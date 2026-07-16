/**
 * JSON-RPC 2.0 protocol types and helpers.
 * Messages are newline-delimited JSON (NDJSON) over stdio or WebSocket frames.
 */

export type RpcId = string | number | null;

/** A request from client → server (has an id, expects a response). */
export interface RpcRequest {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
  id: RpcId;
}

/** A notification (no id, no response expected). Direction: both ways. */
export interface RpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcSuccessResponse {
  jsonrpc: "2.0";
  result: unknown;
  id: RpcId;
}

export interface RpcErrorResponse {
  jsonrpc: "2.0";
  error: RpcError;
  id: RpcId;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;
export type RpcIncoming = RpcRequest | RpcNotification;
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

// ─── Error Codes ────────────────────────────────────────────────────────────

export const E = {
  // Standard JSON-RPC 2.0
  ParseError:     -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams:  -32602,
  InternalError:  -32603,
  // Server-defined
  NotInitialized: -32000,
  ThreadNotFound: -32001,
  TurnBusy:       -32003,
  NoActiveTurn:   -32004,
} as const;

export class RpcException extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcException";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function ok(id: RpcId, result: unknown): RpcSuccessResponse {
  return { jsonrpc: "2.0", result, id };
}

export function rpcErr(id: RpcId, code: number, message: string, data?: unknown): RpcErrorResponse {
  return { jsonrpc: "2.0", error: { code, message, data }, id };
}

export function notif(method: string, params?: unknown): RpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export function isRequest(msg: RpcIncoming): msg is RpcRequest {
  return "id" in msg;
}

export function isNotification(msg: RpcIncoming): msg is RpcNotification {
  return !("id" in msg);
}

/** A response to a server→client request (id + result/error, no method). */
export function isResponse(msg: RpcMessage): msg is RpcResponse {
  return !("method" in msg) && "id" in msg && ("result" in msg || "error" in msg);
}

/**
 * Try to parse a single line as a JSON-RPC message. Returns null on error.
 * Accepts requests, notifications, and responses — responses arrive when the
 * client answers a server-initiated request (e.g. item/tool/call).
 */
export function parseLine(line: string): RpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as RpcMessage;
    if ("jsonrpc" in parsed && parsed.jsonrpc !== "2.0") return null;
    if ("method" in parsed) return parsed;
    if ("id" in parsed && ("result" in parsed || "error" in parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}
