import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAppServer } from "../dist/server.js";
import { fakeConn, waitFor } from "./helpers.mjs";

// A user-scope async Stop hook can keep claude (and its stdout) alive for
// hours after the turn's `result` event. The turn is finished at `result`; the
// server must complete it and reap claude rather than wait for an exit that
// never comes (the orchestrator would kill it as a stall and retry).

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_CLAUDE = path.join(FIXTURES, "fake-claude.mjs");
const noUtilization = async () => undefined;

async function runTurn(env) {
  Object.assign(process.env, { FAKE_CLAUDE_FIXTURE: path.join(FIXTURES, "legacy-turn.ndjson"), ...env });
  try {
    const server = new ClaudeAppServer(FAKE_CLAUDE, false, noUtilization);
    const conn = fakeConn();
    await server.handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "aiur-orchestrator", version: "0.0.0" } } },
      conn,
    );
    const started = await server.handleMessage(
      { jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: "/tmp" } },
      conn,
    );
    await server.handleMessage(
      { jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: started.result.thread.id, content: "hello" } },
      conn,
    );
    return await waitFor(() => conn.sent.find((m) => m.method === "turn/failed" || m.method === "turn/completed"), { timeoutMs: 2500 });
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

test("claude held open after result by a never-exiting hook completes the turn", async () => {
  const startedAt = Date.now();
  const done = await runTurn({ FAKE_CLAUDE_HANG: "1", AIUR_CLAUDE_RESULT_GRACE_MS: "100" });

  assert.equal(done.method, "turn/completed");
  assert.equal(done.params.status, "completed");
  assert.equal(done.params.usage.output_tokens, 4);
  // Well before the hook stand-in's 3 s lifetime: the open stdout did not hold the turn.
  assert.ok(Date.now() - startedAt < 2500);
});

test("claude runs isolated from user-scope settings and MCP servers", async () => {
  const argvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiur-claude-argv-")), "argv.json");
  await runTurn({ FAKE_CLAUDE_ARGV: argvFile });
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf-8"));

  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "project,local");
  assert.ok(argv.includes("--strict-mcp-config"));
});

test("AIUR_CLAUDE_SETTING_SOURCES overrides the isolated default", async () => {
  const argvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiur-claude-argv-")), "argv.json");
  await runTurn({ FAKE_CLAUDE_ARGV: argvFile, AIUR_CLAUDE_SETTING_SOURCES: "user,project,local" });
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf-8"));

  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "user,project,local");
});
