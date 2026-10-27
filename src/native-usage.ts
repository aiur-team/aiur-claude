import type { Turn } from "./types.js";

type UsageSnapshot = Pick<Turn, "usage" | "cost_usd" | "cost_usd_raw">;

/** Each resumed CLI invocation reports its own usage; one app-server turn includes them all. */
export function addNativeUsage(turn: Turn, previous?: UsageSnapshot): void {
  if (!previous) return;
  const usage = { ...turn.usage };
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    if (previous.usage?.[key] !== undefined) usage[key] = (usage[key] ?? 0) + previous.usage[key]!;
  }
  turn.usage = usage;
  if (previous.cost_usd !== undefined) {
    const sum = addDecimal(previous.cost_usd_raw ?? String(previous.cost_usd), turn.cost_usd_raw ?? String(turn.cost_usd ?? 0));
    turn.cost_usd_raw = sum;
    turn.cost_usd = Number(sum);
  }
}

function addDecimal(a: string, b: string): string {
  const parts = (s: string): [bigint, number] => {
    const [mantissa, exponent = "0"] = s.toLowerCase().split("e");
    const scale = (mantissa.split(".")[1]?.length ?? 0) - Number(exponent);
    return [BigInt(mantissa.replace(".", "")), scale];
  };
  const [left, ls] = parts(a), [right, rs] = parts(b);
  const scale = Math.max(ls, rs, 0);
  const sum = (left * 10n ** BigInt(scale - ls) + right * 10n ** BigInt(scale - rs)).toString().padStart(scale + 1, "0");
  return scale ? sum.slice(0, -scale) + "." + sum.slice(-scale) : sum;
}
