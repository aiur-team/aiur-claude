import { deferredQuestion, toRequestUserInput, toUpdatedInput, type DeferredQuestion, type NativeQuestionRequests } from "./native-questions.js";
import type { ConnectionState, Thread, Turn } from "./types.js";

/** Tool count is only a candidate: a terminal deferral always takes precedence. */
export class UnheldQuestions {
  private candidates = new Map<string, DeferredQuestion>();
  observe(event: unknown) {
    const e = event as { type?: string; message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }> } };
    if (e.type !== "assistant") return;
    const tools = e.message?.content?.filter(b => b.type === "tool_use") ?? [];
    if (tools.length < 2) return;
    for (const tool of tools) {
      if (tool.name !== "AskUserQuestion") continue;
      const question = deferredQuestion({ type: "result", terminal_reason: "tool_deferred", deferred_tool_use: tool });
      if (question) this.candidates.set(question.id, question);
    }
  }
  async release(deferred: DeferredQuestion | undefined, thread: Thread, turn: Turn, conn: ConnectionState, requests: NativeQuestionRequests): Promise<string> {
    const messages: string[] = [];
    for (const tool of this.candidates.values()) {
      if (tool.id === deferred?.id || turn.abortController.signal.aborted) continue;
      try {
        const result = await requests.request(conn, toRequestUserInput(tool, thread.id, turn.id, false), turn.abortController.signal);
        messages.push(...Object.values(toUpdatedInput(tool, result).answers));
      } catch (error) {
        if (!turn.abortController.signal.aborted) throw error;
        return "";
      }
    }
    this.candidates.clear();
    return [...new Set(messages)].join("\n");
  }
}
