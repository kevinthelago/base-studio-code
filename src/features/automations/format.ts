// Compact local-time formatting for automation timestamps.
// fmtClock moved to the shared home (@/shared/lib/core/format, #2421) — import it from there.

import { fmtClock } from "@/shared/lib/core/format";

/** "today HH:MM" / "yesterday HH:MM" / "Mon D HH:MM", or "—" for null. */
export function fmtStamp(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const t = fmtClock(ms);
  const midnight = (x: Date) => { const c = new Date(x); c.setHours(0, 0, 0, 0); return c.getTime(); };
  const today = midnight(new Date());
  const day = midnight(d);
  if (day === today) return `today ${t}`;
  if (day === today - 86_400_000) return `yesterday ${t}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${t}`;
}

/**
 * The status-bar summary of armed schedules: how many are armed and the soonest next run
 * across them (`null` when none are armed or none have a next run). Pure; drives the live
 * Automations status-bar slot (replacing the old hardcoded "4 schedules armed").
 */
export function armedSummary(
  automations: ReadonlyArray<{ armed: boolean; nextRunAt: number | null }>,
): { count: number; nextAt: number | null } {
  let count = 0;
  let nextAt: number | null = null;
  for (const a of automations) {
    if (!a.armed) continue;
    count++;
    if (a.nextRunAt != null && (nextAt == null || a.nextRunAt < nextAt)) nextAt = a.nextRunAt;
  }
  return { count, nextAt };
}
