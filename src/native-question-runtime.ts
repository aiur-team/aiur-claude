/** Private CLI helpers: matched PreToolUse hook and permission-host MCP server. */
import { readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

export function hookDecision(input: { tool_name?: string; tool_use_id?: string; tool_input?: unknown }, directory: string) {
  if (input.tool_name !== "AskUserQuestion") return {};
  const file = join(directory, "answer.json");
  let decision: unknown = { permissionDecision: "defer" };
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.toolUseId === input.tool_use_id) { decision = saved.decision; unlinkSync(file); }
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", ...decision as object } };
}

export function permissionDecision(args: { tool_name?: string; input?: unknown }, permissionMode = "default") {
  return args.tool_name === "AskUserQuestion"
    ? { behavior: "deny", message: "Native question deferral was not honored. Stop and end your turn; use decision.requested to record the question." }
    : permissionMode === "bypassPermissions"
      ? { behavior: "allow", updatedInput: args.input }
      : { behavior: "deny", message: "Tool requires approval outside the native question bridge." };
}

if (require.main === module) {
  if (process.argv[2] === "hook") {
    process.stdout.write(JSON.stringify(hookDecision(JSON.parse(readFileSync(0, "utf8")), process.argv[3])));
  } else if (process.argv[2] === "host") {
    createInterface({ input: process.stdin, terminal: false }).on("line", line => {
      const msg = JSON.parse(line);
      if (msg.id === undefined) return;
      let result: unknown;
      switch (msg.method) {
        case "initialize": result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "aiur-native", version: "1.0.0" } }; break;
        case "ping": result = {}; break;
        case "tools/list": result = { tools: [{ name: "approve", description: "Native interaction permission host", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] } }] }; break;
        case "tools/call": result = { content: [{ type: "text", text: JSON.stringify(permissionDecision(msg.params.arguments, process.argv[3])) }] }; break;
        default: process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unknown method" } }) + "\n"); return;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    });
  }
}
