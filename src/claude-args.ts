import type { Thread } from "./types.js";

export function buildClaudeArgs(thread: Thread, model?: string): string[] {
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", thread.permission_mode,
  ];

  if (model) args.push("--model", model);

  // Expose dynamic tools via the in-process MCP bridge. Allowlist each
  // mcp__aiur__<name> so calls run headless under every permission mode.
  if (thread.nativeQuestions) {
    args.push(...thread.nativeQuestions.args(thread.permission_mode, thread.toolBridge?.socketPath ? thread.toolBridge.mcpConfig() : undefined));
    if (thread.toolBridge?.socketPath) args.push("--allowedTools", thread.toolBridge.allowedTools());
  } else if (thread.toolBridge?.socketPath) {
    args.push("--mcp-config", thread.toolBridge.mcpConfig());
    args.push("--allowedTools", thread.toolBridge.allowedTools());
  }

  if (thread.forkFrom && !thread.cliSessionId) {
    // First turn of a forked thread: resume source and fork
    args.push("--resume", thread.forkFrom.cliSessionId, "--fork-session");
  } else if (!thread.cliSessionId) {
    // First turn of a brand-new thread: create session with our thread id
    args.push("--session-id", thread.id);
  } else {
    // Subsequent turns: resume the existing session
    args.push("--resume", thread.cliSessionId);
  }

  return args;
}
