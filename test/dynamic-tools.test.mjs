import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  DynamicToolBridge,
  PendingEngineCalls,
  parseDynamicTools,
  engineResultToMcp,
} from "../dist/dynamic-tools.js";
import { fakeConn, waitFor, mcpClient, TOOLS } from "./helpers.mjs";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

function startedBridge(t, { tools = TOOLS, timeoutMs, conn = fakeConn() } = {}) {
  const engineCalls = new PendingEngineCalls();
  const bridge = new DynamicToolBridge(tools, engineCalls, { timeoutMs });
  bridge.bindConnection(conn);
  t.after(() => bridge.close());
  return { bridge, engineCalls, conn };
}

// ─── parseDynamicTools ────────────────────────────────────────────────────────

test("parseDynamicTools: absent means no tools (backward compatible)", () => {
  assert.deepEqual(parseDynamicTools(undefined), []);
  assert.deepEqual(parseDynamicTools(null), []);
});

test("parseDynamicTools normalizes engine-shaped specs", () => {
  const parsed = parseDynamicTools(TOOLS);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "aiur_declare_blocker");
  assert.deepEqual(parsed[0].inputSchema, TOOLS[0].inputSchema);
  assert.equal(parsed[1].name, "emit_alert");
  assert.equal(parsed[1].inputSchema, undefined);
});

test("parseDynamicTools rejects malformed specs with InvalidParams", () => {
  assert.throws(() => parseDynamicTools("nope"), (e) => e.code === -32602);
  assert.throws(() => parseDynamicTools([{ description: "missing name" }]), (e) => e.code === -32602);
  assert.throws(() => parseDynamicTools([{ name: "" }]), (e) => e.code === -32602);
  assert.throws(() => parseDynamicTools([42]), (e) => e.code === -32602);
});

// ─── engineResultToMcp ────────────────────────────────────────────────────────

test("engineResultToMcp maps the engine's result envelope", () => {
  const success = engineResultToMcp({
    success: true,
    output: "declared",
    contentItems: [{ type: "inputText", text: "declared" }],
  });
  assert.deepEqual(success, { content: [{ type: "text", text: "declared" }], isError: false });

  const failure = engineResultToMcp({ success: false, output: '{"error":"boom"}' });
  assert.equal(failure.isError, true);
  assert.equal(failure.content[0].text, '{"error":"boom"}');

  // output lifted from contentItems when missing
  const lifted = engineResultToMcp({ success: true, contentItems: [{ type: "inputText", text: "hi" }] });
  assert.equal(lifted.content[0].text, "hi");

  // unknown shapes serialize rather than crash
  const odd = engineResultToMcp({ something: "else" });
  assert.equal(odd.isError, false);
  assert.equal(odd.content[0].text, JSON.stringify({ something: "else" }));
});

// ─── MCP handshake & discovery ────────────────────────────────────────────────

test("MCP handshake and tools/list surface exact tool names", async (t) => {
  const { bridge } = startedBridge(t);
  const socketPath = await bridge.start();
  const client = mcpClient(socketPath);
  t.after(() => client.close());

  const init = await client.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "test" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools);
  client.notify("notifications/initialized");

  const list = await client.request(2, "tools/list", {});
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ["aiur_declare_blocker", "emit_alert"],
  );
  assert.deepEqual(list.result.tools[0].inputSchema, TOOLS[0].inputSchema);
  // Specs without a schema get a permissive default (MCP requires inputSchema)
  assert.deepEqual(list.result.tools[1].inputSchema, { type: "object" });

  const pong = await client.request(3, "ping", {});
  assert.deepEqual(pong.result, {});
});

test("claude CLI flag payloads expose the bridge", async (t) => {
  const { bridge } = startedBridge(t);
  const socketPath = await bridge.start();

  const config = JSON.parse(bridge.mcpConfig());
  const server = config.mcpServers.aiur;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, process.execPath);
  assert.equal(server.args[0], path.join(DIST, "mcp-shim.js"));
  assert.equal(server.args[1], socketPath);

  assert.equal(
    bridge.allowedTools(),
    "mcp__aiur__aiur_declare_blocker,mcp__aiur__emit_alert",
  );
});

// ─── Invocation round-trip ────────────────────────────────────────────────────

test("tools/call round-trips through item/tool/call", async (t) => {
  const { bridge, engineCalls, conn } = startedBridge(t);
  const client = mcpClient(await bridge.start());
  t.after(() => client.close());

  const replyPromise = client.request(10, "tools/call", {
    name: "aiur_declare_blocker",
    arguments: { issue_number: 42 },
  });

  // The bridge must emit a JSON-RPC REQUEST on the orchestrator transport
  const request = await waitFor(() => conn.sent.find((m) => m.method === "item/tool/call"));
  assert.equal(request.jsonrpc, "2.0");
  assert.equal(typeof request.id, "string");
  assert.equal(request.params.name, "aiur_declare_blocker");
  assert.deepEqual(request.params.arguments, { issue_number: 42 });
  assert.equal(typeof request.params.callId, "string");

  // Simulate the engine answering with its Response.build envelope
  const consumed = engineCalls.handleResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      success: true,
      output: "declared #42",
      contentItems: [{ type: "inputText", text: "declared #42" }],
    },
  });
  assert.equal(consumed, true);

  const reply = await replyPromise;
  assert.equal(reply.result.isError, false);
  assert.deepEqual(reply.result.content, [{ type: "text", text: "declared #42" }]);
});

test("missing arguments default to an empty object", async (t) => {
  const { bridge, engineCalls, conn } = startedBridge(t);
  const client = mcpClient(await bridge.start());
  t.after(() => client.close());

  const replyPromise = client.request(11, "tools/call", { name: "emit_alert" });
  const request = await waitFor(() => conn.sent.find((m) => m.method === "item/tool/call"));
  assert.deepEqual(request.params.arguments, {});

  engineCalls.handleResponse({ jsonrpc: "2.0", id: request.id, result: { success: true, output: "ok" } });
  const reply = await replyPromise;
  assert.equal(reply.result.isError, false);
});

// ─── Error paths ──────────────────────────────────────────────────────────────

test("engine failure result becomes an MCP tool error", async (t) => {
  const { bridge, engineCalls, conn } = startedBridge(t);
  const client = mcpClient(await bridge.start());
  t.after(() => client.close());

  const replyPromise = client.request(20, "tools/call", { name: "emit_alert", arguments: {} });
  const request = await waitFor(() => conn.sent.find((m) => m.method === "item/tool/call"));

  engineCalls.handleResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { success: false, output: '{"error":{"message":"Unsupported dynamic tool"}}' },
  });

  const reply = await replyPromise;
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /Unsupported dynamic tool/);
});

test("engine JSON-RPC error response becomes a structured tool error", async (t) => {
  const { bridge, engineCalls, conn } = startedBridge(t);
  const client = mcpClient(await bridge.start());
  t.after(() => client.close());

  const replyPromise = client.request(21, "tools/call", { name: "emit_alert", arguments: {} });
  const request = await waitFor(() => conn.sent.find((m) => m.method === "item/tool/call"));

  engineCalls.handleResponse({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32603, message: "engine exploded" },
  });

  const reply = await replyPromise;
  assert.ok(reply.result, "must be a tool result, not a protocol error");
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /engine exploded/);
});

test("engine timeout becomes a tool error and the bridge stays alive", async (t) => {
  const { bridge, conn } = startedBridge(t, { timeoutMs: 100 });
  const client = mcpClient(await bridge.start());
  t.after(() => client.close());

  const replyPromise = client.request(22, "tools/call", { name: "emit_alert", arguments: {} });
  await waitFor(() => conn.sent.find((m) => m.method === "item/tool/call"));
  // Never answer: the pending call must time out.

  const reply = await replyPromise;
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /no response from orchestrator within 100ms/);

  // Bridge still serves requests afterwards
  const pong = await client.request(23, "ping", {});
  assert.deepEqual(pong.result, {});
});

test("unbound orchestrator connection yields a tool error", async (t) => {
  const engineCalls = new PendingEngineCalls();
  const bridge = new DynamicToolBridge(TOOLS, engineCalls, {});
  t.after(() => bridge.close());
  const client = mcpClient(await bridge.start());
  t.after(() => client.close());

  const reply = await client.request(24, "tools/call", { name: "emit_alert", arguments: {} });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /no orchestrator connection/);
});

test("unknown tool and unknown method return JSON-RPC errors", async (t) => {
  const { bridge } = startedBridge(t);
  const client = mcpClient(await bridge.start());
  t.after(() => client.close());

  const unknownTool = await client.request(30, "tools/call", { name: "not_a_tool", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);

  const unknownMethod = await client.request(31, "resources/list", {});
  assert.equal(unknownMethod.error.code, -32601);
});

test("unmatched responses are ignored without crashing", () => {
  const engineCalls = new PendingEngineCalls();
  assert.equal(
    engineCalls.handleResponse({ jsonrpc: "2.0", id: "aiur-tool-999", result: {} }),
    false,
  );
  assert.equal(
    engineCalls.handleResponse({ jsonrpc: "2.0", id: 3, result: {} }),
    false,
  );
});

// ─── Shim relay ───────────────────────────────────────────────────────────────

test("mcp-shim relays stdio to the bridge socket", async (t) => {
  const { bridge } = startedBridge(t);
  const socketPath = await bridge.start();

  const shim = spawn(process.execPath, [path.join(DIST, "mcp-shim.js"), socketPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => shim.kill());

  const lines = readline.createInterface({ input: shim.stdout, terminal: false });
  const firstLine = new Promise((resolve) => lines.once("line", resolve));

  shim.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }) + "\n",
  );

  const reply = JSON.parse(await firstLine);
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  assert.equal(reply.result.serverInfo.name, "aiur-dynamic-tools");
});
