// Skill-invocation telemetry — parse + aggregate the `skills.log` written by the
// `bsc-skill` hook on gated panes (see lib.rs). Each invocation appends a
// PreToolUse line; each success appends a PostToolUse line. Both are tagged with
// the skill name. Pure + unit-testable (the `now` clock is injected). (#406)
//
// Mirrors the Agents audit-log model (screens/agents/auditLog.ts): a flat TSV
// `ts \t pane \t event \t skill`, read newest-first via `read_skill_log`.

import { skillSlug } from "./skills";

/** One parsed `bsc-skill` line. `event` is the hook event name (PreToolUse =
 *  one per invocation; PostToolUse = one per success). `skill` is the raw
 *  `skill_name` from the hook payload. */
export interface SkillUsageRecord {
  ts: string;     // ISO-8601 (UTC, "Z")
  pane: string;   // paneId
  event: string;  // "PreToolUse" | "PostToolUse" | …
  skill: string;  // raw skill_name
}

/** Per-skill aggregates, keyed by skill-name slug. */
export interface SkillStats {
  /** total invocations (PreToolUse lines). */
  invocations: number;
  /** successful invocations (PostToolUse lines). */
  success: number;
  /** success rate 0–100 (0 when never invoked). */
  successRate: number;
  /** invocations whose timestamp falls on the current UTC day. */
  today: number;
  /** invocation counts per day for the last 7 UTC days, oldest→newest. */
  trend: number[];
}

/** Parse the TSV skill-usage log into records, skipping malformed lines. */
export function parseSkillLog(text: string): SkillUsageRecord[] {
  const out: SkillUsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [ts, pane, event, ...rest] = line.split("\t");
    if (ts && pane && event) {
      out.push({ ts, pane, event, skill: rest.join("\t") });
    }
  }
  return out;
}

/** The UTC calendar day (YYYY-MM-DD) of an ISO timestamp. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** The 7 UTC day-keys ending today (oldest→newest). */
function last7Days(now: Date): string[] {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Aggregate usage records into per-skill stats, keyed by the skill-name slug so
 * a record's raw `skill_name` (whether the directory slug or the display name)
 * resolves to the same bucket as a {@link SkillDef} via {@link skillSlug}.
 */
export function aggregateSkillTelemetry(
  records: SkillUsageRecord[],
  now: Date,
): Record<string, SkillStats> {
  const today = now.toISOString().slice(0, 10);
  const days = last7Days(now);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const acc: Record<string, { inv: number; ok: number; today: number; trend: number[] }> = {};
  const bucket = (key: string) => (acc[key] ??= { inv: 0, ok: 0, today: 0, trend: [0, 0, 0, 0, 0, 0, 0] });

  for (const r of records) {
    const key = skillSlug(r.skill);
    if (!key) continue;
    const b = bucket(key);
    if (r.event === "PreToolUse") {
      b.inv += 1;
      if (dayKey(r.ts) === today) b.today += 1;
      const di = dayIndex.get(dayKey(r.ts));
      if (di !== undefined) b.trend[di] += 1;
    } else if (r.event === "PostToolUse") {
      b.ok += 1;
    }
  }

  const out: Record<string, SkillStats> = {};
  for (const [key, b] of Object.entries(acc)) {
    // Clamp successes to invocations — a PostToolUse without a captured PreToolUse
    // (e.g. log truncation) must never push the rate above 100%.
    const success = Math.min(b.ok, b.inv);
    out[key] = {
      invocations: b.inv,
      success,
      successRate: b.inv > 0 ? Math.round((success / b.inv) * 100) : 0,
      today: b.today,
      trend: b.trend,
    };
  }
  return out;
}

/**
 * Status-bar KPIs for the Skills page, from the real telemetry (replaces the mock
 * `SKILL_KPIS`). `loaded` is the library size; `invToday` sums today's invocations across
 * skills; `worst` is the lowest-success-rate skill among those actually invoked (the quality
 * flag shown with a warning), or `null` when nothing has been invoked. Pure + unit-tested.
 */
export function skillStatusKpis(
  skillCount: number,
  stats: Record<string, SkillStats>,
): { loaded: number; invToday: number; worst: { skill: string; rate: number } | null } {
  let invToday = 0;
  let worst: { skill: string; rate: number } | null = null;
  for (const [skill, s] of Object.entries(stats)) {
    invToday += s.today;
    if (s.invocations > 0 && (worst == null || s.successRate < worst.rate)) {
      worst = { skill, rate: s.successRate };
    }
  }
  return { loaded: skillCount, invToday, worst };
}
