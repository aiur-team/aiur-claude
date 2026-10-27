import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ConnectionState, Thread, Turn } from "./types.js";
import type { RpcResponse } from "./protocol.js";

export const RELEASE_PREFIX = "Your question is recorded as Command";
export interface Question {
  question: string; header: string; multiSelect?: boolean;
  options: Array<{ label: string; description: string }>;
}
export interface DeferredQuestion {
  id: string; name: "AskUserQuestion";
  input: { questions: Question[]; [key: string]: unknown };
}
export const questionId = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function deferredQuestion(event: unknown): DeferredQuestion | undefined {
  const e = event as { type?: string; terminal_reason?: string; stop_reason?: string; deferred_tool_use?: DeferredQuestion };
  if (e.type !== "result" || (e.terminal_reason !== "tool_deferred" && e.stop_reason !== "tool_deferred")) return;
  const tool = e.deferred_tool_use;
  if (tool?.name !== "AskUserQuestion" || typeof tool.id !== "string" || !Array.isArray(tool.input?.questions)) {
    throw new Error("Invalid native question deferral");
  }
  if (!tool.input.questions.length || tool.input.questions.some(q =>
    typeof q.question !== "string" || !q.question || typeof q.header !== "string" ||
    !Array.isArray(q.options) || q.options.some(o => typeof o.label !== "string" || typeof o.description !== "string"))) {
    throw new Error("Invalid native question input");
  }
  return tool;
}

export function toRequestUserInput(tool: DeferredQuestion, threadId: string, turnId: string) {
  return { threadId, turnId, itemId: tool.id, questions: tool.input.questions.map(q => ({
    id: questionId(q.question), header: q.header, question: q.question,
    isOther: true, isSecret: false, options: q.options, multiSelect: q.multiSelect === true,
  })) };
}

export function toUpdatedInput(tool: DeferredQuestion, result: unknown) {
  const r = result as { answers?: Record<string, { answers?: unknown }> } | null;
  const answers: Record<string, string> = Object.create(null);
  const release = Object.values(r?.answers ?? {}).flatMap(a => Array.isArray(a?.answers) ? a.answers : []);
  const releaseText = release.length === 1 && typeof release[0] === "string" && release[0].startsWith(RELEASE_PREFIX) ? release[0] : undefined;
  for (const q of tool.input.questions) {
    if (releaseText) { answers[q.question] = releaseText; continue; }
    const values = r?.answers?.[questionId(q.question)]?.answers;
    if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== "string")) {
      throw new Error("Missing native question answer");
    }
    answers[q.question] = values.join(", ");
  }
  return { ...tool.input, answers };
}

/** Native questions have no response deadline; interruption cancels and forgets the request. */
export class NativeQuestionRequests {
  private seq = 0;
  private pending = new Map<string, { conn: ConnectionState; finish: (msg?: RpcResponse) => void }>();
  request(conn: ConnectionState, params: unknown, signal: AbortSignal): Promise<unknown> {
    const id = `native-question-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const finish = (msg?: RpcResponse) => {
        this.pending.delete(id);
        signal.removeEventListener("abort", abort);
        if (!msg) reject(new Error("Native question interrupted"));
        else if ("error" in msg) reject(new Error(msg.error.message));
        else resolve(msg.result);
      };
      const abort = () => finish();
      if (signal.aborted) { finish(); return; }
      this.pending.set(id, { conn, finish });
      signal.addEventListener("abort", abort, { once: true });
      try { conn.send({ jsonrpc: "2.0", id, method: "item/tool/requestUserInput", params }); }
      catch (err) { this.pending.delete(id); signal.removeEventListener("abort", abort); reject(err); }
    });
  }
  handleResponse(msg: RpcResponse, conn: ConnectionState): boolean {
    const pending = typeof msg.id === "string" ? this.pending.get(msg.id) : undefined;
    if (!pending || pending.conn !== conn) return false;
    pending.finish(msg);
    return true;
  }
}

const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export class NativeQuestions {
  private directory?: string;
  args(permissionMode: string, mcpConfig?: string): string[] {
    this.directory ??= mkdtempSync(join(tmpdir(), "aiur-native-"));
    const runtime = join(__dirname, "native-question-runtime.js");
    const command = [process.execPath, runtime, "hook", this.directory].map(quote).join(" ");
    const config = mcpConfig ? JSON.parse(mcpConfig) : { mcpServers: {} };
    config.mcpServers.aiur_native = { command: process.execPath, args: [runtime, "host", permissionMode] };
    return ["--mcp-config", JSON.stringify(config), "--permission-prompt-tool", "mcp__aiur_native__approve",
      "--settings", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command }] }] } })];
  }
  async answer(tool: DeferredQuestion, thread: Thread, turn: Turn, conn: ConnectionState, requests: NativeQuestionRequests) {
    let decision: unknown;
    try {
      const result = await requests.request(conn, toRequestUserInput(tool, thread.id, turn.id), turn.abortController.signal);
      decision = { permissionDecision: "allow", updatedInput: toUpdatedInput(tool, result) };
    } catch (err) {
      if (!turn.abortController.signal.aborted) throw err;
      decision = { permissionDecision: "deny", permissionDecisionReason: `${RELEASE_PREFIX}. The turn was interrupted; stop.` };
    }
    if (!this.directory) throw new Error("Native question runtime is not initialized");
    writeFileSync(join(this.directory, "answer.json"), JSON.stringify({ toolUseId: tool.id, decision }), { mode: 0o600 });
  }
  close() {
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.directory = undefined;
  }
}
