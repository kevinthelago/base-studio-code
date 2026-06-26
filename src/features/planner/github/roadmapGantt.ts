// Pure Gantt/timeline model for the Projects → Roadmap tab.
//
// Kept free of React / Tauri imports so the windowing and bar math can be unit
// tested in isolation. The Roadmap view feeds it GitHub milestones plus a
// selected time window; it returns positioned rows and the axis scale.

// The milestone shape is the canonical one in shared/lib/github/types (#1528); re-exported here so
// existing importers (Roadmap.tsx, the tests) keep their `from "./roadmapGantt"` import.
import type { GhMilestone } from "@/shared/lib/github/types";
export type { GhMilestone };

const WEEK_MS = 7 * 24 * 3600 * 1000;

export interface GanttRow {
  id: string;
  title: string;
  startWeek: number;
  lengthWeeks: number;
  pct: number;
  state: "done" | "doing" | "upcoming" | "backlog";
  creator: string;
  dueLabel: string;
}

export interface GanttModel {
  rows: GanttRow[];
  totalWeeks: number;
  todayWeek: number;
  origin: Date;
}

/** Time-window presets for the Roadmap filter. `weeks: null` = all time. */
export const WINDOW_PRESETS: { label: string; weeks: number | null }[] = [
  { label: "8w",  weeks: 8 },
  { label: "28w", weeks: 28 },
  { label: "1y",  weeks: 52 },
  { label: "all", weeks: null },
];

/** Default window — bounds the timeline on first load so it isn't spread across
 *  the project's entire history. */
export const DEFAULT_WINDOW_WEEKS = 28;

export function weeksBetween(a: Date, b: Date): number {
  return Math.max(0, Math.ceil((b.getTime() - a.getTime()) / WEEK_MS));
}

/** The start of a window `weeks` before `now`, or null for all-time. */
export function windowStartFrom(weeks: number | null, now: Date = new Date()): Date | null {
  return weeks == null ? null : new Date(now.getTime() - weeks * WEEK_MS);
}

export function tickIntervalWeeks(totalWeeks: number): number {
  if (totalWeeks <= 16)  return 1;
  if (totalWeeks <= 52)  return 4;
  if (totalWeeks <= 130) return 8;
  return 13;
}

export function tickLabel(weekIndex: number, origin: Date, interval: number): string {
  if (interval <= 1) return `w${weekIndex + 1}`;
  const d = new Date(origin.getTime() + weekIndex * WEEK_MS);
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function milestoneEnd(m: GhMilestone): Date {
  return m.due_on ? new Date(m.due_on) : new Date(new Date(m.created_at).getTime() + 14 * 24 * 3600 * 1000);
}

/**
 * Build the Gantt model for the given milestones, scaled to a time window.
 *
 * `windowStart` (from {@link windowStartFrom}) clamps the timeline's left edge:
 * milestones whose end falls entirely before it are dropped, and the axis origin
 * is pinned to the window edge (or the earliest kept milestone, whichever is
 * later) so a few far-apart due dates can't squash everything into slivers. Bars
 * that began before the window are clamped to start at the edge. Pass `null` for
 * all time. `now` is injectable for testing.
 */
export function buildGantt(
  milestones: GhMilestone[],
  windowStart: Date | null,
  now: Date = new Date(),
): GanttModel {
  const items = milestones.map(m => ({ m, start: new Date(m.created_at), end: milestoneEnd(m) }));
  const kept = windowStart
    ? items.filter(x => x.end.getTime() >= windowStart.getTime())
    : items;

  if (kept.length === 0) return { rows: [], totalWeeks: 8, todayWeek: 0, origin: now };

  const earliestStart = kept.reduce((a, b) => (a.start < b.start ? a : b)).start;
  // Pin the origin to the window edge when it's later than the earliest kept
  // start; otherwise start at the earliest milestone (no empty left margin).
  const origin = windowStart && windowStart.getTime() > earliestStart.getTime() ? windowStart : earliestStart;
  const horizon = kept.reduce((a, b) => (a.end > b.end ? a : b)).end;
  const totalWeeks = Math.max(weeksBetween(origin, horizon) + 1, 8);
  const todayWeek = weeksBetween(origin, now);

  const rows: GanttRow[] = kept.map(({ m, start, end }) => {
    // Clamp a bar that began before the window to the visible left edge.
    const effStart = start.getTime() < origin.getTime() ? origin : start;
    const startWeek = weeksBetween(origin, effStart);
    const lengthWeeks = Math.max(1, weeksBetween(effStart, end));
    const total = m.open_issues + m.closed_issues;
    const pct = total > 0 ? m.closed_issues / total : 0;
    const state: GanttRow["state"] =
      m.state === "closed" ? "done"
      : pct > 0 ? "doing"
      : startWeek <= todayWeek ? "upcoming"
      : "backlog";
    const dueLabel = m.due_on
      ? new Date(m.due_on).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "no due date";

    return { id: String(m.number), title: m.title, startWeek, lengthWeeks, pct, state, creator: m.creator?.login ?? "", dueLabel };
  });

  return { rows, totalWeeks, todayWeek, origin };
}
