/** Shared test helpers. */

import * as net from "node:net";
import * as readline from "node:readline";

/** Fake orchestrator connection capturing everything the server sends. */
export function fakeConn() {
  const sent = [];
  return {
    initialized: false,
    sent,
    send(msg) { sent.push(msg); },
  };
}

/** Poll until fn() returns a truthy value, or fail after timeout. */
export async function waitFor(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Minimal MCP client speaking newline-delimited JSON-RPC over a unix socket —
 * the same wire format the claude CLI uses through the stdio shim.
 */
export function mcpClient(socketPath) {
  const socket = net.connect(socketPath);
  socket.on("error", () => {});
  const rl = readline.createInterface({ input: socket, terminal: false });
  const pending = new Map();
  const unmatched = [];

  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    } else {
      unmatched.push(msg);
    }
  });

  return {
    unmatched,
    request(id, method, params) {
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method, params) {
      socket.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    close() { socket.destroy(); },
  };
}

/** Tool specs shaped exactly like the Aiur engine's DynamicTool.tool_specs(). */
export const TOOLS = [
  {
    name: "aiur_declare_blocker",
    description: "Declare that another issue blocks the issue you are working on.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue_number"],
      properties: {
        issue_number: { type: ["integer", "string"], description: "Issue number of the blocker." },
      },
    },
  },
  {
    name: "emit_alert",
    description: "Emit a milestone alert.",
    // no inputSchema — bridge must default it
  },
];
