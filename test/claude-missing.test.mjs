import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ClaudeAppServer } from "../dist/server.js";
import { fakeConn, waitFor } from "./helpers.mjs";

// Claude Code's self-updater reinstalls the CLI every few minutes, and for the
// ~18 s of each install `claude` is gone from PATH. A worker that starts or
// spawns a turn in that window used to die with an auth hint (open-games,
// 2026-11-21: 11 of ~112 starts). It must wait for the install instead.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const FAKE_CLAUDE = path.join(FIXTURES, "fake-claude.mjs");
const INDEX = path.join(HERE, "..", "dist", "index.js");
const noUtilization = async () => undefined;

// PATH holds only this directory (plus `node` for the fake's shebang), so the
// real CLI next to node is never found.
function emptyBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiur-claude-bin-"));
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  return dir;
}

function installLater(binDir, ms) {
  setTimeout(() => fs.symlinkSync(FAKE_CLAUDE, path.join(binDir, "claude")), ms);
}

test("startup names a missing CLI instead of suggesting a login", () => {
  const result = spawnSync(process.execPath, [INDEX], {
    encoding: "utf-8",
    input: "",
    timeout: 10_000,
    env: { PATH: emptyBinDir(), AIUR_CLAUDE_PROBE_TIMEOUT_MS: "300" },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /claude CLI not found on PATH/);
  assert.doesNotMatch(result.stderr, /claude auth/);
});

test("a turn whose claude vanished mid-install respawns it once the install lands", async () => {
  const binDir = emptyBinDir();
  const envFile = path.join(binDir, "env.json");
  const saved = { PATH: process.env.PATH };
  Object.assign(process.env, {
    PATH: binDir,
    FAKE_CLAUDE_FIXTURE: path.join(FIXTURES, "legacy-turn.ndjson"),
    FAKE_CLAUDE_ENV: envFile,
    AIUR_CLAUDE_PROBE_TIMEOUT_MS: "5000",
  });
  try {
    // The path resolved at startup no longer exists; the reinstall lands 300 ms in.
    const server = new ClaudeAppServer(path.join(binDir, "stale", "claude"), false, noUtilization);
    installLater(binDir, 300);
    const conn = fakeConn();
    await server.handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "aiur-orchestrator", version: "0.0.0" } } },
      conn,
    );
    const started = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: "/tmp" } }, conn);
    await server.handleMessage(
      { jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: started.result.thread.id, content: "hello" } },
      conn,
    );
    const done = await waitFor(() => conn.sent.find((m) => m.method === "turn/failed" || m.method === "turn/completed"), { timeoutMs: 8000 });

    assert.equal(done.method, "turn/completed");
    // Workers never start a self-update of their own.
    assert.equal(JSON.parse(fs.readFileSync(envFile, "utf-8")).DISABLE_AUTOUPDATER, "1");
  } finally {
    for (const key of ["FAKE_CLAUDE_FIXTURE", "FAKE_CLAUDE_ENV", "AIUR_CLAUDE_PROBE_TIMEOUT_MS"]) delete process.env[key];
    process.env.PATH = saved.PATH;
  }
});
