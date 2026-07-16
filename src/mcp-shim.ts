#!/usr/bin/env node
/**
 * MCP stdio relay.
 *
 * Spawned by the claude CLI as an MCP "stdio" server (via --mcp-config); pipes
 * stdin/stdout to the unix domain socket where the in-process
 * DynamicToolBridge listens. All MCP protocol handling happens in the bridge —
 * this process only relays bytes.
 *
 * Usage: node mcp-shim.js <socket-path>
 */

import * as net from "net";

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("usage: mcp-shim <socket-path>\n");
  process.exit(2);
}

const socket = net.connect(socketPath);

socket.on("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on("error", (err: Error) => {
  process.stderr.write(`[mcp-shim] socket error: ${err.message}\n`);
  process.exit(1);
});

socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
