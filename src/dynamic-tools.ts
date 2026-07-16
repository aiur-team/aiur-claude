/**
 * Dynamic tool bridge — surfaces orchestrator-declared tools to claude.
 *
 * Orchestrators (e.g. Aiur) may declare coordination tools on thread/start:
 *
 *   { "dynamicTools": [{ "name", "description", "inputSchema" }, …] }
 *
 * Each spec is served to the spawned claude CLI as an MCP tool. The bridge
 * hosts a newline-delimited JSON-RPC MCP server on a unix domain socket,
 * reached by a tiny stdio relay (mcp-shim.js) that claude spawns via
 * `--mcp-config`. Tool names are preserved exactly: claude namespaces them
 * as `mcp__aiur__<name>`, and the exact `<name>` is what round-trips to the
 * orchestrator.
 *
 * Invocation round-trip:
 *
 *   claude        → MCP `tools/call` { name, arguments }
 *   bridge        → orchestrator JSON-RPC request
 *                   { "method": "item/tool/call", "id": "aiur-tool-N",
 *                     "params": { "name", "arguments", "callId" } }
 *   orchestrator  → { "id": "aiur-tool-N",
 *                     "result": { "success", "output", "contentItems" } }
 *   bridge        → MCP result { content: [{ type: "text", text }], isError }
 *
 * Orchestrator failures (timeout, error response, unbound transport) become
 * structured MCP tool errors (isError: true) — never a crash.
 */

import { chmodSync, existsSync, rmSync } from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { v4 as uuid } from "uuid";

import {
  ok, rpcErr,
  E, RpcException,
  type RpcResponse,
} from "./protocol.js";
import type { ConnectionState, DynamicToolSpec } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** MCP server key in --mcp-config; claude prefixes tools as mcp__<key>__<name>. */
export const MCP_SERVER_NAME = "aiur";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const BRIDGE_SERVER_INFO = { name: "aiur-dynamic-tools", version: "1.0.0" };
const DEFAULT_ENGINE_TIMEOUT_MS = 120_000;
const SHIM_FILENAME = "mcp-shim.js";

let bridgeSeq = 0;

// ─── Spec parsing ─────────────────────────────────────────────────────────────

/**
 * Validate and normalize the thread/start `dynamicTools` param.
 * Absent/null → [] (backward compatible). Malformed → InvalidParams.
 */
export function parseDynamicTools(raw: unknown): DynamicToolSpec[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new RpcException(E.InvalidParams, "dynamicTools must be an array of tool specs");
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RpcException(E.InvalidParams, `dynamicTools[${i}] must be an object`);
    }
    const spec = entry as {
      name?: unknown;
      description?: unknown;
      inputSchema?: unknown;
      input_schema?: unknown;
    };
    if (typeof spec.name !== "string" || spec.name.trim() === "") {
      throw new RpcException(E.InvalidParams, `dynamicTools[${i}].name must be a non-empty string`);
    }
    const inputSchema = spec.inputSchema ?? spec.input_schema;
    const parsed: DynamicToolSpec = { name: spec.name };
    if (typeof spec.description === "string") parsed.description = spec.description;
    if (typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)) {
      parsed.inputSchema = inputSchema as Record<string, unknown>;
    }
    return parsed;
  });
}

// ─── Engine round-trip plumbing ───────────────────────────────────────────────

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Tracks server→client JSON-RPC requests awaiting orchestrator responses.
 * Ids are strings ("aiur-tool-N") so they can never collide with the
 * orchestrator's own (integer) request ids on the shared transport.
 */
export class PendingEngineCalls {
  private seq = 0;
  private pending = new Map<string, PendingCall>();

  request(conn: ConnectionState, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = `aiur-tool-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response from orchestrator within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        conn.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Route an incoming response to its pending call. Returns false when unmatched. */
  handleResponse(msg: RpcResponse): boolean {
    if (typeof msg.id !== "string") return false;
    const entry = this.pending.get(msg.id);
    if (!entry) return false;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if ("error" in msg) {
      entry.reject(new Error(`orchestrator error ${msg.error.code}: ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
    return true;
  }
}

// ─── Result mapping ───────────────────────────────────────────────────────────

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

function toolError(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Map the orchestrator's dynamic tool result envelope
 * ({ success, output, contentItems }) onto an MCP tool result.
 */
export function engineResultToMcp(result: unknown): McpToolResult {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const r = result as {
      success?: unknown;
      output?: unknown;
      contentItems?: Array<{ text?: unknown }>;
    };
    const firstItemText = Array.isArray(r.contentItems) ? r.contentItems[0]?.text : undefined;
    const text =
      typeof r.output === "string" ? r.output
      : typeof firstItemText === "string" ? firstItemText
      : JSON.stringify(result);
    return { content: [{ type: "text", text }], isError: r.success === false };
  }
  return { content: [{ type: "text", text: String(result) }], isError: false };
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export interface DynamicToolBridgeOptions {
  /** How long to wait for the orchestrator to answer item/tool/call. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export class DynamicToolBridge {
  readonly tools: DynamicToolSpec[];
  /** Set once start() succeeds; claude connects here through the shim. */
  socketPath?: string;

  private engineCalls: PendingEngineCalls;
  private conn?: ConnectionState;
  private server?: net.Server;
  private timeoutMs: number;
  private log: (msg: string) => void;

  constructor(tools: DynamicToolSpec[], engineCalls: PendingEngineCalls, options: DynamicToolBridgeOptions = {}) {
    this.tools = tools;
    this.engineCalls = engineCalls;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
  }

  /** Point item/tool/call requests at the orchestrator connection. */
  bindConnection(conn: ConnectionState): void {
    this.conn = conn;
  }

  /** Start the unix socket MCP server. Idempotent; returns the socket path. */
  async start(): Promise<string> {
    if (this.server && this.socketPath) return this.socketPath;

    const shim = shimPath();
    if (!existsSync(shim)) {
      throw new Error(`MCP shim not found at ${shim} — run the build first (npm run build)`);
    }

    const socketPath = path.join(os.tmpdir(), `aiur-mcp-${process.pid}-${++bridgeSeq}.sock`);
    rmSync(socketPath, { force: true });

    const server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => this.log(`mcp bridge server error: ${err}`));
    // Owner-only: the socket executes orchestrator tools on behalf of claude.
    try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }

    this.server = server;
    this.socketPath = socketPath;
    this.log(`mcp bridge listening on ${socketPath} (${this.tools.length} tools)`);
    return socketPath;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    if (this.socketPath) {
      try { rmSync(this.socketPath, { force: true }); } catch { /* best effort */ }
      this.socketPath = undefined;
    }
  }

  /** Inline JSON for claude's --mcp-config flag. */
  mcpConfig(): string {
    if (!this.socketPath) throw new Error("bridge not started");
    return JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: process.execPath,
          args: [shimPath(), this.socketPath],
        },
      },
    });
  }

  /** Comma-separated names for claude's --allowedTools flag. */
  allowedTools(): string {
    return this.tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`).join(",");
  }

  // ── MCP connection handling ─────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    socket.on("error", (err) => this.log(`mcp connection error: ${err.message}`));

    const rl = readline.createInterface({ input: socket, terminal: false });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        msg = parsed as Record<string, unknown>;
      } catch {
        this.log(`mcp: ignoring non-JSON line: ${trimmed.slice(0, 120)}`);
        return;
      }

      void this.handleMcpMessage(msg)
        .then((reply) => {
          if (reply && !socket.destroyed && socket.writable) {
            socket.write(JSON.stringify(reply) + "\n");
          }
        })
        .catch((err: unknown) => this.log(`mcp: handler failure: ${String(err)}`));
    });
  }

  private async handleMcpMessage(msg: Record<string, unknown>): Promise<unknown | null> {
    const { id, method, params } = msg as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof method !== "string") return null; // not a request/notification
    if (id === undefined || id === null) return null; // notification (initialized, cancelled, …)
    const rpcId = id as string | number;

    try {
      switch (method) {
        case "initialize": {
          const p = (params ?? {}) as { protocolVersion?: unknown };
          return ok(rpcId, {
            protocolVersion: typeof p.protocolVersion === "string" ? p.protocolVersion : MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: BRIDGE_SERVER_INFO,
          });
        }

        case "ping":
          return ok(rpcId, {});

        case "tools/list":
          return ok(rpcId, {
            tools: this.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              inputSchema: t.inputSchema ?? { type: "object" },
            })),
          });

        case "tools/call": {
          const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
          if (typeof p.name !== "string" || p.name === "") {
            throw new RpcException(E.InvalidParams, "tools/call requires a tool name");
          }
          if (!this.tools.some((t) => t.name === p.name)) {
            throw new RpcException(E.InvalidParams, `Unknown tool: ${p.name}`);
          }
          return ok(rpcId, await this.callTool(p.name, p.arguments));
        }

        default:
          throw new RpcException(E.MethodNotFound, `Unknown method: ${method}`);
      }
    } catch (e) {
      if (e instanceof RpcException) return rpcErr(rpcId, e.code, e.message, e.data);
      return rpcErr(rpcId, E.InternalError, String(e));
    }
  }

  /** Round-trip one tool invocation to the orchestrator. Never throws. */
  private async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const conn = this.conn;
    if (!conn) {
      return toolError(`Tool "${name}" failed: no orchestrator connection bound`);
    }

    let result: unknown;
    try {
      result = await this.engineCalls.request(
        conn,
        "item/tool/call",
        { name, arguments: args ?? {}, callId: uuid() },
        this.timeoutMs,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`mcp: tool "${name}" failed: ${message}`);
      return toolError(`Tool "${name}" failed: ${message}`);
    }

    return engineResultToMcp(result);
  }
}

function shimPath(): string {
  return path.join(__dirname, SHIM_FILENAME);
}
