import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { ClaudeAppServer } from "../dist/server.js";
import { E } from "../dist/protocol.js";
import { fakeConn, waitFor } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("./fixtures/steer-claude.mjs", import.meta.url));

async function setup(t) {
  const server = new ClaudeAppServer(CLI, false, async () => undefined);
  const conn = fakeConn();
  let id = 0;
  const rpc = (method, params = {}) => server.handleMessage({ jsonrpc: "2.0", id: ++id, method, params }, conn);
  await rpc("initialize");
  const threads = [];
  const scratch = mkdtempSync(join(tmpdir(), "steer-"));
  const gates = new Map();
  t.after(async () => {
    for (const gate of gates.values()) writeFileSync(gate, "0");
    for (const thread of threads) {
      for (const turn of thread.turns) turn.process?.kill("SIGTERM");
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    rmSync(scratch, { recursive: true, force: true });
  });
  async function thread() {
    const reply = await rpc("thread/start", { cwd: process.cwd() });
    const created = server.getThread(reply.result.thread.id);
    threads.push(created);
    return created;
  }
  async function start(thread, content, model) {
    const gate = join(scratch, String(id));
    const reply = await rpc("turn/start", { threadId: thread.id, content, model: model === "hold" ? `hold:${gate}` : model });
    assert.ok(reply.result?.turn.id, JSON.stringify(reply));
    const turnId = reply.result.turn.id;
    if (model === "hold") gates.set(turnId, gate);
    const echo = await waitFor(() => conn.sent.find(m =>
      m.method === "item/created" && m.params.turn_id === turnId && m.params.item.type === "text"));
    return { id: turnId, content: echo.params.item.text };
  }
  const done = turnId => waitFor(() => conn.sent.find(m =>
    ["turn/completed", "turn/failed"].includes(m.method) && m.params.turn_id === turnId));
  async function finish(turn, exitCode = "0") {
    writeFileSync(gates.get(turn.id), exitCode);
    return done(turn.id);
  }
  return { rpc, thread, start, done, finish };
}

test("turn/steer prepends content in arrival order to the next turn's stdin on the same thread", async t => {
  const { rpc, thread, start, done, finish } = await setup(t);
  const first = await thread();
  const active = await start(first, "running", "hold");
  for (const content of ["A", "B"]) {
    const reply = await rpc("turn/steer", { threadId: first.id, content });
    assert.deepEqual(reply.result, { turn_id: active.id, note: "queued: will be prepended to the next user message" });
  }
  assert.equal(first.turns[0].user_content, "running");
  await finish(active);
  const other = await thread();
  const unrelated = await start(other, "other thread");
  assert.equal(unrelated.content, "other thread");
  await done(unrelated.id);
  const next = await start(first, "C");
  assert.equal(next.content, "A\n\nB\n\nC");
  await done(next.id);
});

test("turn/steer accepts Codex-shaped input arrays", async t => {
  const { rpc, thread, start, done, finish } = await setup(t);
  const current = await thread();
  const active = await start(current, "running", "hold");
  const reply = await rpc("turn/steer", { thread_id: current.id, input: [{ type: "text", text: "A" }, { type: "text", text: "B" }] });
  assert.equal(reply.result?.turn_id, active.id);
  await finish(active);
  const next = await start(current, "C");
  assert.equal(next.content, "A\nB\n\nC");
  await done(next.id);
});

test("steered text is delivered once even after a rejected turn/start", async t => {
  const { rpc, thread, start, done, finish } = await setup(t);
  const current = await thread();
  const active = await start(current, "running", "hold");
  await rpc("turn/steer", { threadId: current.id, content: "A" });
  assert.equal((await rpc("turn/start", { threadId: current.id, content: "busy" })).error.code, E.TurnBusy);
  await finish(active);
  assert.equal((await rpc("turn/start", { threadId: current.id, content: "" })).error.code, -32602);
  const next = await start(current, "B");
  assert.equal(next.content, "A\n\nB");
  await done(next.id);
  const last = await start(current, "C");
  assert.equal(last.content, "C");
  await done(last.id);
});

for (const ending of ["interrupt", "failure"]) {
  test(`accepted steer survives turn ${ending}`, async t => {
    const { rpc, thread, start, done, finish } = await setup(t);
    const current = await thread();
    const active = await start(current, "running", "hold");
    await rpc("turn/steer", { threadId: current.id, content: "A" });
    if (ending === "interrupt") {
      assert.equal((await rpc("turn/interrupt", { threadId: current.id })).result.status, "interrupted");
      assert.equal((await finish(active)).params.status, "interrupted");
    } else {
      assert.equal((await finish(active, "1")).method, "turn/failed");
    }
    const next = await start(current, "B");
    assert.equal(next.content, "A\n\nB");
    await done(next.id);
  });
}

test("turn/steer rejects empty or non-string text without queuing it", async t => {
  const { rpc, thread, start, done, finish } = await setup(t);
  const current = await thread();
  const active = await start(current, "running", "hold");
  for (const params of [
    {}, { content: "" }, { content: "   " }, { content: 42 }, { content: {} },
    { input: [] }, { input: "A" }, { input: [null] },
    { input: [{ type: "text", text: 42 }] }, { input: [{ type: "text" }] },
    { input: [{ type: "text", text: "" }] }, { input: [{ type: "image", text: "A" }] },
  ]) {
    const reply = await rpc("turn/steer", { threadId: current.id, ...params });
    assert.equal(reply.error?.code, -32602, JSON.stringify(params));
  }
  await finish(active);
  const next = await start(current, "B");
  assert.equal(next.content, "B");
  await done(next.id);
});

// Existing behavior guard: this passes on the original implementation.
test("regression guard: turn/steer with no active turn returns NoActiveTurn", async t => {
  const { rpc, thread } = await setup(t);
  const current = await thread();
  assert.equal((await rpc("turn/steer", { threadId: current.id, content: "A" })).error.code, E.NoActiveTurn);
});
