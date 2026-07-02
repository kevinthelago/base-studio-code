// Hook-fire telemetry (#865 PR 2) — parse + aggregate the hook-fire log for the Hook
// Analytics tab. Mirrors skillTelemetry.ts. The log lives at ~/.base-studio-code/hooks.log,
// one TSV line per fire: `ts \t pane \t event \t hook \t outcome` (#1743 prepended the pane
// column). Legacy lines written before #1743 have no pane (`ts \t event \t hook \t outcome`)
// and are still tolerated — the parser detects the shape by column count. Read newest-first via
// `bsc logs tail hook`. `outcome` is "allow" | "block" (PreToolUse decisions) or "ok"
// (PostToolUse / non-gating events). Pure + unit-tested; the hook wrappers that EMIT these
// lines are wired separately (PR 3).

export type HookOutcome = "allow" | "block" | "ok";

export interface HookFire {
  /** epoch ms */
  ts: number;
  /** PreToolUse | PostToolUse | Stop | … */
  event: string;
  /** the hook's name */
  hook: string;
  outcome: HookOutcome;
}

/** Parse the TSV hook-fire log into records, skipping malformed lines. */
export function parseHookLog(text: string): HookFire[] {
  const out: HookFire[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    // #1743: new lines carry a leading pane column (5 fields: ts·pane·event·hook·outcome); legacy
    // lines have none (4 fields: ts·event·hook·outcome). Detect by column count and offset the field
    // reads. The pane isn't surfaced here (the analytics don't break down by session), so it's read
    // past, not stored.
    const b = parts.length >= 5 ? 1 : 0;
    const [tsRaw, event, hook, outcomeRaw] = [parts[0], parts[b + 1], parts[b + 2], parts[b + 3]];
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || !event || !hook) continue;
    const outcome: HookOutcome = outcomeRaw === "block" ? "block" : outcomeRaw === "allow" ? "allow" : "ok";
    out.push({ ts, event, hook, outcome });
  }
  return out;
}

export interface DayBucket { day: string; allows: number; blocks: number; }
export interface HookCount { hook: string; event: string; fires: number; }
export interface PreHookSplit { hook: string; allows: number; blocks: number; }

export interface HookAnalytics {
  /** total fires in the window */
  total: number;
  /** PreToolUse fires denied (outcome === "block") */
  blocks: number;
  /** PreToolUse fires allowed (outcome === "allow") */
  allows: number;
  /** allows / (allows + blocks), 0–100; 100 when no PreToolUse decisions */
  allowRate: number;
  /** per-day allow (allow + ok) vs block counts, oldest→newest, length === days */
  daily: DayBucket[];
  /** fires per hook, descending */
  perHook: HookCount[];
  /** PreToolUse hooks only: allows vs blocks, descending by total */
  perPreHook: PreHookSplit[];
}

const DAY_MS = 86_400_000;

/** Local YYYY-MM-DD for an epoch-ms timestamp (matches the chart's daily bucketing). */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Aggregate hook fires into the analytics the Hook Analytics tab renders. Only fires within
 * the last `days` (relative to `now`) are counted. `daily` always has exactly `days` buckets
 * (zero-filled), oldest→newest, so the chart has a stable x-axis.
 */
export function aggregateHookTelemetry(fires: HookFire[], now: Date, days = 14): HookAnalytics {
  const end = now.getTime();
  const start = end - days * DAY_MS;
  const inWindow = fires.filter((f) => f.ts >= start && f.ts <= end);

  // Stable daily buckets (oldest→newest), keyed by local day.
  const daily: DayBucket[] = [];
  const idxByDay = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(end - i * DAY_MS);
    idxByDay.set(key, daily.length);
    daily.push({ day: key, allows: 0, blocks: 0 });
  }

  let blocks = 0;
  let allows = 0;
  const perHookMap = new Map<string, HookCount>();
  const perPreMap = new Map<string, PreHookSplit>();

  for (const f of inWindow) {
    if (f.outcome === "block") blocks++;
    else if (f.outcome === "allow") allows++;

    const bucket = idxByDay.get(dayKey(f.ts));
    if (bucket != null) {
      if (f.outcome === "block") daily[bucket].blocks++;
      else daily[bucket].allows++;
    }

    const hk = perHookMap.get(f.hook) ?? { hook: f.hook, event: f.event, fires: 0 };
    hk.fires++;
    perHookMap.set(f.hook, hk);

    if (f.event === "PreToolUse") {
      const ph = perPreMap.get(f.hook) ?? { hook: f.hook, allows: 0, blocks: 0 };
      if (f.outcome === "block") ph.blocks++;
      else ph.allows++;
      perPreMap.set(f.hook, ph);
    }
  }

  const perHook = [...perHookMap.values()].sort((a, b) => b.fires - a.fires);
  const perPreHook = [...perPreMap.values()].sort((a, b) => (b.allows + b.blocks) - (a.allows + a.blocks));
  const decided = allows + blocks;

  return {
    total: inWindow.length,
    blocks,
    allows,
    allowRate: decided > 0 ? Math.round((allows / decided) * 100) : 100,
    daily,
    perHook,
    perPreHook,
  };
}
