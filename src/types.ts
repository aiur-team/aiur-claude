/**
 * Domain types: Thread → Turn → Item hierarchy.
 *
 * Thread   A conversation between user and agent (maps 1:1 to a claude session).
 * Turn     A single user request + all agent work that follows.
 * Item     An atomic unit of content (text, tool call, file change, …).
 */

import type { ChildProcess } from "child_process";
import type { DynamicToolBridge } from "./dynamic-tools.js";

// ─── Permissions ─────────────────────────────────────────────────────────────

/** Maps directly to claude's --permission-mode flag. */
export type PermissionMode =
  | "default"           // prompt for dangerous ops
  | "acceptEdits"       // auto-approve file edits
  | "bypassPermissions" // approve everything (use in sandboxes only)
  | "dontAsk"           // skip prompts, don't approve (log only)

// ─── Items ───────────────────────────────────────────────────────────────────

export interface TextItem {
  type: "text";
  text: string;
  /**
   * Set when the claude CLI synthesized this text from an API error (the
   * stream event carried `is_api_error_message` / `error`), e.g. the session
   * limit banner. Absent on text the model actually wrote.
   */
  provider_error?: string;
}
export interface ThinkingItem { type: "thinking";       thinking: string }

export interface ToolCallItem {
  type: "tool_call";
  tool_use_id: string;
  name: string;
  input: unknown;
}

export interface ToolResultItem {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface FileChangeItem {
  type: "file_change";
  path: string;
  operation: "create" | "update" | "delete";
}

export interface CommandOutputItem {
  type: "command_output";
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
}

export type Item =
  | TextItem
  | ThinkingItem
  | ToolCallItem
  | ToolResultItem
  | FileChangeItem
  | CommandOutputItem;

export interface StoredItem {
  id: string;
  created_at: number;
  item: Item;
}

// ─── Turn ─────────────────────────────────────────────────────────────────────

export type TurnStatus = "active" | "completed" | "interrupted" | "error";

export interface Turn {
  id: string;
  thread_id: string;
  status: TurnStatus;

  /** Content the user sent to start this turn. */
  user_content: string;

  /** Extra content queued via turn/steer (injected into next claude call). */
  steer_queue: string[];

  /** All items produced during this turn. */
  items: StoredItem[];

  /** The running claude subprocess for this turn (if still active). */
  process?: ChildProcess;

  abortController: AbortController;

  created_at: number;
  completed_at?: number;
  error?: string;

  /** Token usage accumulated from stream_event/message_delta events. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** Cost in USD reported by the claude CLI. */
  cost_usd?: number;
  /**
   * Exact decimal for cost_usd as serialized by the CLI, captured from the
   * raw NDJSON text before JSON.parse converts it to a float.
   */
  cost_usd_raw?: string;
  /**
   * Provider refusal reported by the claude CLI itself during this turn.
   * Forwarded on turn/failed so the engine never has to guess from text.
   */
  provider_error?: ProviderError;
}

/**
 * An API error the claude CLI reported in its own stream-json, as opposed to
 * text the model wrote. `error` is the CLI's error class (e.g. "rate_limit",
 * "model_not_found"); `api_error_status` is the HTTP status from the result
 * event; `message` is the CLI's user-facing text (e.g. "You've hit your
 * session limit · resets 12:20am (America/Los_Angeles)").
 */
export interface ProviderError {
  error: string;
  api_error_status?: number;
  message?: string;
}

// ─── Thread ───────────────────────────────────────────────────────────────────

export interface Thread {
  id: string;
  created_at: number;
  turns: Turn[];
  cwd: string;
  permission_mode: PermissionMode;
  active_turn_id?: string;

  /**
   * The actual claude CLI session ID captured from the "system/init" event.
   * May differ from thread.id for forked threads.
   */
  cliSessionId?: string;

  /**
   * Set when this thread was forked from another.
   * Used to pass --resume <id> --fork-session on the first turn.
   */
  forkFrom?: { cliSessionId: string };

  /**
   * Tools declared by the orchestrator on thread/start (`dynamicTools`).
   * Surfaced to the spawned claude CLI through the MCP bridge; invocations
   * round-trip to the orchestrator as item/tool/call requests.
   */
  dynamicTools?: DynamicToolSpec[];

  /** In-process MCP server exposing dynamicTools to the claude subprocess. */
  toolBridge?: DynamicToolBridge;

  /**
   * Billing relationship fact derived from the CLI init event's apiKeySource
   * ("none" → subscription auth; anything else → API key).
   */
  accountType?: AccountType;
}

// ─── Rate limits ──────────────────────────────────────────────────────────────

/** Non-identifying account billing fact: how the claude CLI is authenticated. */
export type AccountType = "subscription" | "api_key" | "unknown";

/**
 * Sanitized rate-limit standing forwarded to the engine as `rate_limit/update`.
 *
 * Built by allowlist — only the fields below ever pass through. Identifying
 * data (org/account ids, emails, tokens, session ids, raw headers) is never
 * copied from the CLI event.
 */
export interface RateLimitStatus {
  /** Bounded CLI-reported standing; unrecognized values become `unknown`. */
  status: "allowed" | "allowed_warning" | "rejected" | "unknown";
  /**
   * Percentage of the quota USED, on a 0–100 scale. Higher = closer to the
   * limit; 95 means nearly exhausted. This is consumption, NOT remaining
   * headroom. CLI values in [0, 1] are treated as a used fraction and
   * scaled by 100.
   */
  used_percent?: number;
  /** Unix epoch seconds when the current limit window resets. */
  resets_at?: number;
  /** Whether the account is a subscription or API-key account. */
  account_type: AccountType;
  /** Version string of the claude CLI that emitted the event. */
  source_version: string;
}

// ─── Dynamic tools ────────────────────────────────────────────────────────────

/** One orchestrator-declared tool: name, description, JSON-schema input. */
export interface DynamicToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ─── Connection State ─────────────────────────────────────────────────────────

export interface ConnectionState {
  initialized: boolean;
  client_info?: { name: string; version: string };
  /** send a message to the connected client */
  send: (msg: unknown) => void;
}
