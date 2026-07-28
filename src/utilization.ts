/**
 * Quota utilization, read the way the Claude Code TUI's `/usage` reads it.
 *
 * The agent event stream's `rate_limit_event` carries a standing and a reset
 * time but no consumed fraction, so a percentage cannot be derived from it. The
 * TUI does not try: it calls `GET /api/oauth/usage` (internally
 * `fetchUtilization`) with the stored OAuth token and renders the percentages
 * from that response.
 *
 * Reading the same endpoint has a second benefit beyond the number itself —
 * it needs no turn. A caller can learn where the account stands the moment a
 * session opens, instead of only after real work has run.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * How long a reading is reused before another request is made.
 *
 * The endpoint rate-limits: calling it per thread-start and per in-turn
 * rate-limit event earns a 429 quickly, and a 429 means no reading at all —
 * so an eager caller ends up with *less* data than a patient one. Quota also
 * moves slowly, so a minute-old number is still a good number.
 *
 * Override with AIUR_CLAUDE_USAGE_TTL_MS to match a caller's own poll cadence.
 */
const DEFAULT_TTL_MS = 60_000;

/** After a 429, wait this long before trying again regardless of TTL. */
const RATE_LIMITED_BACKOFF_MS = 5 * 60_000;

interface CacheEntry {
  value: Utilization | undefined;
  /** Epoch ms after which the entry may be refreshed. */
  freshUntil: number;
}

let cache: CacheEntry | undefined;
/** Coalesces concurrent callers onto one in-flight request. */
let inFlight: Promise<Utilization | undefined> | undefined;

function ttlMs(): number {
  const raw = Number(process.env.AIUR_CLAUDE_USAGE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/** Drop cached state. Exposed for tests; not part of the runtime contract. */
export function resetUtilizationCache(): void {
  cache = undefined;
  inFlight = undefined;
}

/** One quota window as the endpoint reports it. */
interface UsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface UsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
}

export interface Utilization {
  /** Consumed percentage, 0–100, of whichever window is closest to its limit. */
  used_percent: number;
  /** Unix epoch seconds when that window resets, when the endpoint reports one. */
  resets_at?: number;
}

export interface UtilizationOptions {
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Read the stored Claude Code OAuth access token.
 *
 * Returns undefined rather than throwing when the file is absent, unreadable,
 * malformed, or the token has expired — every one of those is a normal state
 * (API-key accounts, fresh machines, logged-out users) and none should be able
 * to fail a turn.
 */
export async function readAccessToken(
  credentialsPath = join(homedir(), ".claude", ".credentials.json"),
  now: () => number = Date.now,
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath, "utf-8"));
    const oauth = parsed?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== "string" || token === "") return undefined;

    // expiresAt is epoch milliseconds. An expired token would just 401; skipping
    // the request is cheaper and keeps the failure quiet.
    if (typeof oauth?.expiresAt === "number" && oauth.expiresAt <= now()) return undefined;

    return token;
  } catch {
    return undefined;
  }
}

/**
 * Fetch current utilization. Resolves undefined on any failure — an unavailable
 * quota reading must never break a session.
 */
export async function fetchUtilization(options: UtilizationOptions = {}): Promise<Utilization | undefined> {
  const now = options.now ?? Date.now;

  // Serve a fresh cache entry rather than re-requesting. This is what keeps the
  // endpoint from 429ing us into having no reading at all.
  if (cache && now() < cache.freshUntil) return cache.value;
  if (inFlight) return inFlight;

  inFlight = requestUtilization(options, now).finally(() => {
    inFlight = undefined;
  });

  return inFlight;
}

async function requestUtilization(
  options: UtilizationOptions,
  now: () => number,
): Promise<Utilization | undefined> {
  const token = await readAccessToken(options.credentialsPath, now);
  if (!token) return undefined;

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await doFetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "anthropic-beta": OAUTH_BETA,
      },
      signal: controller.signal,
    });

    if (response.status === 429) {
      // Back off hard: continuing to ask while limited guarantees no reading.
      // The previous value keeps being served until the backoff elapses.
      cache = { value: cache?.value, freshUntil: now() + RATE_LIMITED_BACKOFF_MS };
      return cache.value;
    }

    if (!response.ok) {
      cache = { value: cache?.value, freshUntil: now() + ttlMs() };
      return cache.value;
    }

    const value = selectWindow((await response.json()) as UsageResponse);
    cache = { value, freshUntil: now() + ttlMs() };
    return value;
  } catch {
    // Network failure, timeout, malformed body: keep serving the last good
    // reading rather than flapping to "unknown" on a transient blip.
    cache = { value: cache?.value, freshUntil: now() + ttlMs() };
    return cache.value;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the window closest to its limit.
 *
 * A session may sit at 2% while the week sits at 20%; the week is what will
 * stop work first, so it is the honest single number to report. Reporting the
 * lower one would understate how close the account is to a stop.
 */
export function selectWindow(body: UsageResponse | null | undefined): Utilization | undefined {
  const windows = [body?.five_hour, body?.seven_day, body?.seven_day_opus, body?.seven_day_sonnet];

  let worst: Utilization | undefined;
  for (const window of windows) {
    const percent = normalizePercent(window?.utilization);
    if (percent === undefined) continue;
    if (worst && percent <= worst.used_percent) continue;

    worst = { used_percent: percent };
    const resetsAt = parseResetsAt(window?.resets_at);
    if (resetsAt !== undefined) worst.resets_at = resetsAt;
  }

  return worst;
}

function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, 100);
}

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}
