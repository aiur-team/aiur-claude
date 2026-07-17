#!/usr/bin/env node
/**
 * Minimal claude CLI stand-in for tests: answers --version, then replays the
 * NDJSON fixture named by FAKE_CLAUDE_FIXTURE to stdout and exits 0.
 */
import { readFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("9.9.9-test (fake-claude)\n");
  process.exit(0);
}

process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_FIXTURE, "utf-8"));
  process.exit(0);
});
