import { E, RpcException } from "./protocol.js";

/** Match turn/start's text-array shape without coercing malformed text. */
export function parseSteerContent(params: { content?: unknown; input?: unknown }): string {
  let content = params.content;
  if (content === undefined && Array.isArray(params.input)) {
    const text = params.input.filter(item => item?.type === "text");
    if (text.some(item => typeof item.text !== "string")) {
      throw new RpcException(E.InvalidParams, "input text must be a string");
    }
    content = text.map(item => item.text).join("\n");
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new RpcException(E.InvalidParams, "non-empty content or text input is required");
  }
  return content;
}
