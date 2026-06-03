// Pure parse + aggregation of the app-wide skills usage log (#406).
//
// Claude surfaces a skill invocation to hooks as `tool_name: "Skill"` with
// `tool_input.skill_name`. On gated panes a `bsc-skill` hook appends one line per
// hook event to `skills.log` (env `BSC_SKILL_LOG`), in the shape:
//
//     <ts> · <pane> · <hook_event> · <skill_name>
//
// where `hook_event` is `PreToolUse` (one per invocation) or `PostToolUse` (one per
// success). The Rust `read_skill_log` command reads it back newest-first; this module
// turns those raw lines into the per-skill metrics the dashboard renders. No React /
// Tauri imports — `now` is injected so aggregation is deterministic in tests.

export interface SkillLogLine {
  /** Epoch milliseconds (parsed from the line's timestamp). */
  ts: number;
  pane: string;
  /** "PreToolUse" | "PostToolUse" | … */
  event: string;
  /** The invoked skill's name/slug, as Claude reported it. */
  skill: string;
}

export interface SkillStats {
  /** PreToolUse count — how many times the skill was invoked. */
  invocations: number;
  /** PostToolUse count — how many invocations completed. */
  success: number;
  /** Invocations whose timestamp falls on `now`'s calendar day. */
  today: number;
  /** Invocations per day for the last 7 days, oldest → newest (length 7). */
  trend: number[];
}

const SEP = "·";
const DAY_MS = 86_400_000;

/** Parse one timestamp token into epoch ms: accepts epoch (s or ms) or any
 *  `Date.parse`-able string. Returns NaN when unparseable. */
function parseTs(token: string): number {
  const t = token.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    // Heuristic: 10-digit values are epoch seconds, 13-digit are ms.
    return t.length <= 10 ? n * 1000 : n;
  }
  const d = Date.parse(t);
  return Number.isNaN(d) ? NaN : d;
}

/** Parse the raw `skills.log` contents into structured lines (malformed lines
 *  dropped). Order is preserved from the input. */
export function parseSkillLog(raw: string): SkillLogLine[] {
  const out: SkillLogLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(SEP).map(p => p.trim());
    if (parts.length < 4) continue;
    const ts = parseTs(parts[0]);
    const skill = parts.slice(3).join(` ${SEP} `).trim();
    if (Number.isNaN(ts) || !skill) continue;
    out.push({ ts, pane: parts[1], event: parts[2], skill });
  }
  return out;
}

/** The local-midnight epoch ms for the day containing `ts`. */
function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Aggregate parsed log lines into per-skill stats, keyed by skill name exactly as
 * it appears in the log. `now` anchors "today" and the 7-day trend window.
 */
export function aggregateSkillLog(lines: SkillLogLine[], now: number): Record<string, SkillStats> {
  const todayStart = dayStart(now);
  // Bucket index 6 = today, 0 = six days ago.
  const stats: Record<string, SkillStats> = {};
  const ensure = (skill: string): SkillStats =>
    (stats[skill] ??= { invocations: 0, success: 0, today: 0, trend: [0, 0, 0, 0, 0, 0, 0] });

  for (const line of lines) {
    const s = ensure(line.skill);
    if (line.event === "PreToolUse") {
      s.invocations += 1;
      if (line.ts >= todayStart && line.ts < todayStart + DAY_MS) s.today += 1;
      const bucket = 6 - Math.floor((todayStart - dayStart(line.ts)) / DAY_MS);
      if (bucket >= 0 && bucket <= 6) s.trend[bucket] += 1;
    } else if (line.event === "PostToolUse") {
      s.success += 1;
    }
  }
  return stats;
}

/** Convenience: parse + aggregate in one call. */
export function skillStatsFromLog(raw: string, now: number): Record<string, SkillStats> {
  return aggregateSkillLog(parseSkillLog(raw), now);
}

/** Empty stats for a skill with no logged usage (the honest default — #406). */
export function emptyStats(): SkillStats {
  return { invocations: 0, success: 0, today: 0, trend: [0, 0, 0, 0, 0, 0, 0] };
}

/** Success rate in [0,1]; 0 when never invoked (avoids a divide-by-zero NaN). */
export function successRate(s: SkillStats): number {
  return s.invocations > 0 ? s.success / s.invocations : 0;
}
