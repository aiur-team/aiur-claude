#!/usr/bin/env node
/**
 * Minimal claude CLI stand-in for tests: answers --version, then replays the
 * NDJSON fixture named by FAKE_CLAUDE_FIXTURE to stdout and exits with
 * FAKE_CLAUDE_EXIT (default 0). The real CLI exits 1 after an API error.
 * FAKE_CLAUDE_HANG=1 never exits after the replay, like a claude held open by
 * an async Stop hook that never returns; the hook stand-in is a child that
 * inherits stdout and outlives a kill of this process for 3 s. FAKE_CLAUDE_ARGV names a file that
 * receives the argv as JSON. FAKE_CLAUDE_ENV names a file that receives
 * DISABLE_AUTOUPDATER as JSON.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

if (process.argv.includes("--version")) {
  process.stdout.write("9.9.9-test (fake-claude)\n");
  process.exit(0);
}

if (process.env.FAKE_CLAUDE_ARGV) writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_CLAUDE_ENV) writeFileSync(process.env.FAKE_CLAUDE_ENV, JSON.stringify({ DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER }));

process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_FIXTURE, "utf-8"));
  if (process.env.FAKE_CLAUDE_HANG === "1") {
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", "inherit", "inherit"] });
    setInterval(() => {}, 1 << 30);
  }
  else process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
});
