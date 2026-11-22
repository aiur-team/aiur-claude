import { accessSync, constants, realpathSync } from "fs";
import { delimiter, join } from "path";

// Claude Code's self-updater reinstalls the CLI globally while other claude
// processes run, and for the length of the install `claude` is missing from
// PATH. A lookup that lands in that window waits for the install to finish
// instead of failing.

/** The real path of the first executable `claude` on PATH, if there is one. */
export function findClaude(path = process.env.PATH ?? ""): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch { /* not here */ }
  }
  return undefined;
}

export function claudeProbeTimeoutMs(): number {
  const ms = Number(process.env.AIUR_CLAUDE_PROBE_TIMEOUT_MS);
  return Number.isFinite(ms) && ms >= 0 ? ms : 60_000;
}

/** Look for `claude` on PATH until it appears or `timeoutMs` passes. */
export async function waitForClaude(timeoutMs = claudeProbeTimeoutMs(), intervalMs = 500): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = findClaude();
    if (found || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}
