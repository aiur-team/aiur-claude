import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAppServer } from "../dist/server.js";
import { fakeConn, waitFor } from "./helpers.mjs";

// The claude CLI marks text it synthesizes from an API error: the assistant
// event carries `error` (e.g. "rate_limit") and `is_api_error_message`, the
// result carries `is_error`, `api_error_status` and `terminal_reason:
// "api_error"`, and the process exits 1 with nothing on stderr. Without this
// provenance the engine sees only "claude exited with code 1" plus ordinary
// assistant text, and cannot tell a session-limit refusal from a crash.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_CLAUDE = path.join(FIXTURES, "fake-claude.mjs");
const BANNER = "You've hit your session limit · resets 12:20am (America/Los_Angeles)";
const noUtilization = async () => undefined;

async function runFailingTurn(fixture, exitCode = "1") {
  process.env.FAKE_CLAUDE_FIXTURE = path.join(FIXTURES, fixture);
  process.env.FAKE_CLAUDE_EXIT = exitCode;
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
    const done = await waitFor(() => conn.sent.find((m) => m.method === "turn/failed" || m.method === "turn/completed"));
    return { conn, done };
  } finally {
    delete process.env.FAKE_CLAUDE_EXIT;
  }
}

test("session-limit refusal reaches turn/failed with CLI provenance", async () => {
  const { conn, done } = await runFailingTurn("provider-session-limit.ndjson");

  assert.equal(done.method, "turn/failed");
  assert.equal(done.params.error, "Error: claude exited with code 1");
  assert.deepEqual(done.params.provider_error, {
    error: "rate_limit",
    api_error_status: 429,
    message: BANNER,
  });

  // The banner is still shown as text, but tagged as CLI-synthesized.
  const created = conn.sent.find((m) => m.method === "item/created");
  assert.equal(created.params.item.type, "text");
  assert.equal(created.params.item.text, BANNER);
  assert.equal(created.params.item.provider_error, "rate_limit");
});

test("a real CLI API error (captured model_not_found) carries its own class and status", async () => {
  const { done } = await runFailingTurn("provider-model-not-found.ndjson");

  assert.equal(done.method, "turn/failed");
  assert.equal(done.params.provider_error.error, "model_not_found");
  assert.equal(done.params.provider_error.api_error_status, 404);
  assert.match(done.params.provider_error.message, /issue with the selected model/);
});

test("model-written text that repeats the banner, then a crash, carries no provenance", async () => {
  const { conn, done } = await runFailingTurn("quoted-session-limit.ndjson");

  assert.equal(done.method, "turn/failed");
  assert.equal(done.params.error, "Error: claude exited with code 1");
  assert.equal(done.params.provider_error, undefined);
  assert.ok(!JSON.stringify(conn.sent).includes("provider_error"));
});

test("an ordinary turn never carries provider_error", async () => {
  const { conn, done } = await runFailingTurn("legacy-turn.ndjson", "0");

  assert.equal(done.method, "turn/completed");
  assert.ok(!JSON.stringify(conn.sent).includes("provider_error"));
});
