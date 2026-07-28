import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClaudeAppServer,
  extractTopLevelRawNumber,
  accountTypeFromApiKeySource,
  normalizeUsedPercent,
} from "../dist/server.js";
import { fakeConn, waitFor } from "./helpers.mjs";

// TypeScript `private` is compile-time only; tests reach internals
// (processClaudeEvent, sourceVersion) through the erased JS surface on purpose.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_CLAUDE = path.join(FIXTURES, "fake-claude.mjs");
const FAKE_VERSION = "9.9.9-test (fake-claude)";
// The server enriches rate limits from /api/oauth/usage. Tests must never reach
// the network, and these cases assert the CLI-derived values specifically, so
// the fetcher is stubbed to "no reading available".
const noUtilization = async () => undefined;


/** Run a full turn against the fake claude CLI replaying the given fixture. */
async function runFixtureTurn(fixture) {
  process.env.FAKE_CLAUDE_FIXTURE = path.join(FIXTURES, fixture);
  const server = new ClaudeAppServer(FAKE_CLAUDE, false, noUtilization);
  const conn = fakeConn();
  await server.handleMessage(
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { clientInfo: { name: "aiur-orchestrator", version: "0.0.0" } },
    },
    conn,
  );
  const started = await server.handleMessage(
    { jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: "/tmp" } },
    conn,
  );
  const threadId = started.result.thread.id;
  await server.handleMessage(
    { jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId, content: "hello" } },
    conn,
  );
  const completed = await waitFor(() => conn.sent.find((m) => m.method === "turn/completed"));
  return { conn, threadId, completed };
}

// ─── Forwarding round-trips (CLI emission → typed engine notification) ────────

test("subscription rate-limit emission round-trips sanitized and typed", async () => {
  const { conn, threadId, completed } = await runFixtureTurn("rate-limit-subscription.ndjson");

  const started = conn.sent.find((m) => m.method === "turn/started");
  const update = await waitFor(() => conn.sent.find((m) => m.method === "rate_limit/update"));
  assert.ok(update, "rate_limit/update must be forwarded");
  assert.deepEqual(update.params, {
    turn_id: started.params.turn_id,
    thread_id: threadId,
    rate_limit: {
      status: "allowed_warning",
      used_percent: 0.83 * 100, // fraction used, scaled to percent USED
      resets_at: 1767225600,
      account_type: "subscription",
      source_version: FAKE_VERSION,
    },
  });

  // Exact decimal preserved alongside the legacy float
  assert.equal(completed.params.cost_usd, 0.1);
  assert.equal(completed.params.cost_usd_raw, "0.100000000000000005");
  assert.equal(completed.params.cost_source_version, FAKE_VERSION);
});

test("api-key rate-limit emission normalizes the alternate CLI shape", async () => {
  const { conn, completed } = await runFixtureTurn("rate-limit-api-key.ndjson");

  const update = await waitFor(() => conn.sent.find((m) => m.method === "rate_limit/update"));
  assert.ok(update, "rate_limit/update must be forwarded");
  assert.deepEqual(update.params.rate_limit, {
    status: "rejected",
    used_percent: 100, // percent scale passes through unchanged
    resets_at: 1767312000,
    account_type: "api_key",
    source_version: FAKE_VERSION,
  });

  assert.equal(completed.params.cost_usd, 1e-7);
  assert.equal(completed.params.cost_usd_raw, "1e-7");
  assert.equal(completed.params.cost_source_version, FAKE_VERSION);
});

// ─── Redaction ────────────────────────────────────────────────────────────────

test("identifying fields never pass through rate_limit/update", async () => {
  const server = new ClaudeAppServer("claude", false, noUtilization);
  server.sourceVersion = FAKE_VERSION;
  const thread = { id: "thread-1", accountType: "subscription" };
  const turn = { id: "turn-1" };
  const conn = fakeConn();

  const hostile = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      utilization: 0.5,
      resetsAt: 1767225600,
      organization_id: "org-SECRET",
      account_uuid: "acct-SECRET",
      email: "user@example.com",
      access_token: "sk-ant-SECRET",
      headers: { "x-api-key": "SECRET-KEY" },
    },
    session_id: "sess-SECRET",
  };
  server.processClaudeEvent(hostile, thread, turn, conn, new Map(), new Map(), JSON.stringify(hostile));

  const update = await waitFor(() => conn.sent.find((m) => m.method === "rate_limit/update"));
  assert.ok(update);
  assert.deepEqual(update.params.rate_limit, {
    status: "allowed",
    used_percent: 50,
    resets_at: 1767225600,
    account_type: "subscription",
    source_version: FAKE_VERSION,
  });
  const wire = JSON.stringify(update.params);
  for (const leak of [
    "SECRET", "example.com", "organization_id", "account_uuid",
    "email", "access_token", "headers", "session_id", "sess-",
  ]) {
    assert.ok(!wire.includes(leak), `identifying data leaked: ${leak}`);
  }
});

test("unrecognized status text and invalid numeric facts cannot cross the allowlist", async () => {
  const server = new ClaudeAppServer("claude", false, noUtilization);
  const thread = { id: "thread-1", accountType: "subscription" };
  const turn = { id: "turn-1" };
  const conn = fakeConn();

  const hostile = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "user@example.com sk-ant-SECRET",
      utilization: 101,
      resetsAt: -1,
    },
  };
  server.processClaudeEvent(hostile, thread, turn, conn, new Map(), new Map(), JSON.stringify(hostile));

  const update = await waitFor(() => conn.sent.find((m) => m.method === "rate_limit/update"));
  assert.deepEqual(update.params.rate_limit, {
    status: "unknown",
    account_type: "subscription",
    source_version: "unknown",
  });
  assert.ok(!JSON.stringify(update).includes("SECRET"));
  assert.ok(!JSON.stringify(update).includes("example.com"));
});

test("a later init without an auth fact clears stale account classification", () => {
  const server = new ClaudeAppServer("claude", false, noUtilization);
  const thread = { id: "thread-1" };
  const turn = { id: "turn-1" };
  const conn = fakeConn();

  server.processClaudeEvent(
    { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" },
    thread, turn, conn, new Map(), new Map(),
  );
  assert.equal(thread.accountType, "api_key");

  server.processClaudeEvent(
    { type: "system", subtype: "init" },
    thread, turn, conn, new Map(), new Map(),
  );
  assert.equal(thread.accountType, "unknown");
});

test("rate_limit_event with no payload still forwards a normalized envelope", async () => {
  const server = new ClaudeAppServer("claude", false, noUtilization);
  const thread = { id: "thread-1" };
  const turn = { id: "turn-1" };
  const conn = fakeConn();

  const event = { type: "rate_limit_event" };
  server.processClaudeEvent(event, thread, turn, conn, new Map(), new Map(), JSON.stringify(event));

  const update = await waitFor(() => conn.sent.find((m) => m.method === "rate_limit/update"));
  assert.deepEqual(update.params.rate_limit, {
    status: "unknown",
    account_type: "unknown",
    source_version: "unknown",
  });
});

// ─── Exact decimal preservation ───────────────────────────────────────────────

test("awkward decimals preserve exact strings while floats keep working", () => {
  const server = new ClaudeAppServer("claude", false, noUtilization);
  const cases = [
    ['{"type":"result","subtype":"success","total_cost_usd":0.100000000000000005}', "0.100000000000000005", 0.1],
    ['{"type":"result","subtype":"success","cost_usd":1e-7}', "1e-7", 1e-7],
    ['{"type":"result","subtype":"success","total_cost_usd":0.30000000000000004}', "0.30000000000000004", 0.30000000000000004],
    ['{"type":"result","subtype":"success","total_cost_usd":2.5E+1}', "2.5E+1", 25],
  ];
  for (const [rawLine, exact, float] of cases) {
    const thread = { id: "thread-1" };
    const turn = { id: "turn-1" };
    server.processClaudeEvent(JSON.parse(rawLine), thread, turn, fakeConn(), new Map(), new Map(), rawLine);
    assert.equal(turn.cost_usd, float, `float for ${rawLine}`);
    assert.equal(turn.cost_usd_raw, exact, `exact decimal for ${rawLine}`);
  }
});

test("cost key inside a string value is never mistaken for the cost", () => {
  const server = new ClaudeAppServer("claude", false, noUtilization);
  const rawLine =
    '{"type":"result","subtype":"success","result":"note: \\"total_cost_usd\\": 9.9 appears in prose","total_cost_usd":0.25}';
  const turn = { id: "turn-1" };
  server.processClaudeEvent(JSON.parse(rawLine), { id: "thread-1" }, turn, fakeConn(), new Map(), new Map(), rawLine);
  assert.equal(turn.cost_usd, 0.25);
  assert.equal(turn.cost_usd_raw, "0.25");
});

test("extractTopLevelRawNumber only matches top-level numeric keys", () => {
  assert.equal(extractTopLevelRawNumber('{"a":{"total_cost_usd":1.5},"total_cost_usd":2.5}', "total_cost_usd"), "2.5");
  assert.equal(extractTopLevelRawNumber('{ "total_cost_usd" : 3.00 }', "total_cost_usd"), "3.00");
  assert.equal(extractTopLevelRawNumber('{"total_cost_usd":-0.5e-2}', "total_cost_usd"), "-0.5e-2");
  assert.equal(extractTopLevelRawNumber('{"x":1}', "total_cost_usd"), undefined);
  assert.equal(extractTopLevelRawNumber('{"total_cost_usd":"free"}', "total_cost_usd"), undefined);
  assert.equal(extractTopLevelRawNumber('{"note":"total_cost_usd","total_cost_usd":7}', "total_cost_usd"), "7");
});

// ─── Normalization units ──────────────────────────────────────────────────────

test("used_percent normalization is explicit about used-vs-remaining scale", () => {
  assert.equal(normalizeUsedPercent(0.83), 0.83 * 100); // fraction used → percent used
  assert.equal(normalizeUsedPercent(45), 45);           // already percent used
  assert.equal(normalizeUsedPercent(1), 100);           // fully used
  assert.equal(normalizeUsedPercent(0), 0);
  assert.equal(normalizeUsedPercent(-5), undefined);
  assert.equal(normalizeUsedPercent(101), undefined);
  assert.equal(normalizeUsedPercent(Number.POSITIVE_INFINITY), undefined);
  assert.equal(normalizeUsedPercent("95"), undefined);
});

test("account type derives from apiKeySource without forwarding it", () => {
  assert.equal(accountTypeFromApiKeySource("none"), "subscription");
  assert.equal(accountTypeFromApiKeySource("ANTHROPIC_API_KEY"), "api_key");
  assert.equal(accountTypeFromApiKeySource("/login managed key"), "api_key");
  assert.equal(accountTypeFromApiKeySource(undefined), "unknown");
});

// ─── Backward compatibility ───────────────────────────────────────────────────

test("stream without rate-limit or cost data behaves byte-identically", async () => {
  const { conn, threadId, completed } = await runFixtureTurn("legacy-turn.ndjson");

  // Exactly the legacy notification sequence — nothing new appears
  assert.deepEqual(
    conn.sent.map((m) => m.method),
    ["initialized", "turn/started", "item/progress", "item/created", "turn/completed"],
  );

  // turn/completed carries exactly the legacy key set
  assert.deepEqual(Object.keys(completed.params).sort(), [
    "completed_at", "items_count", "status", "thread_id", "turn_id", "usage",
  ]);
  assert.equal(completed.params.status, "completed");
  assert.equal(completed.params.thread_id, threadId);

  // No rate-limit or cost bytes anywhere on the wire
  const wire = JSON.stringify(conn.sent);
  assert.ok(!wire.includes("rate_limit"));
  assert.ok(!wire.includes("cost"));
});
