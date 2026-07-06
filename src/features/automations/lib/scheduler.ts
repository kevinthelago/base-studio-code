// Pure scheduler core for Automations (#142). No React / no Tauri here — just the
// data model and the deterministic logic (next-run computation, target
// resolution, payload building) so it can be unit-tested in isolation. The tick
// loop and PTY dispatch live in useScheduler; CRUD lives in the store.

import { nextCronRun } from "./cron";
import { clamp } from "@/shared/lib/core/math";

export type Every = "minute" | "hour" | "day" | "weekday";
export type AutomationActionKind = "command";
export type RunStatus = "ok" | "skipped" | "fail";

export interface SimpleWhen {
  kind: "simple";
  every: Every;
  /** "HH:MM" for day/weekday; ":MM" or "MM" for hour; ignored for minute. */
  at: string;
}
export interface CronWhen {
  kind: "cron";
  /** Standard 5-field cron expression. */
  expr: string;
}
export type AutomationWhen = SimpleWhen | CronWhen;

export interface AutomationRun {
  at: number;        // epoch ms
  status: RunStatus;
  note: string;
}

export interface Automation {
  id: string;
  name: string;
  armed: boolean;
  when: AutomationWhen;
  /** Tab resolved at fire time by name (survives reordering); pane by index. */
  targetTab: string;
  targetPaneIdx: number;
  action: AutomationActionKind;
  command?: string;   // action === "command"
  lastRunAt: number | null;
  nextRunAt: number | null;
  runs: AutomationRun[];
}

/** Keep at most this many run records per automation. */
export const MAX_RUNS = 25;

/** Parse the minute component out of an hour spec ("15", ":15", "x:15"). */
function parseMinute(at: string): number {
  const m = at.replace(/^.*:/, "").trim();
  const n = parseInt(m, 10);
  return Number.isFinite(n) ? clamp(n, 0, 59) : 0;
}

/** Parse "HH:MM" into [hours, minutes], clamped; missing parts default to 0. */
function parseHourMinute(at: string): [number, number] {
  const [h, m] = at.split(":");
  const hh = clamp(parseInt(h ?? "0", 10) || 0, 0, 23);
  const mm = clamp(parseInt(m ?? "0", 10) || 0, 0, 59);
  return [hh, mm];
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6; // Sun or Sat
}

/**
 * The next fire time strictly after `fromMs`, in local time, or null if the
 * spec is unsupported. v1 supports minute/hour/day/weekday; week/month are a
 * follow-up.
 */
export function computeNextRun(when: AutomationWhen, fromMs: number): number | null {
  if (when.kind === "cron") return nextCronRun(when.expr, fromMs);

  const from = new Date(fromMs);

  if (when.every === "minute") {
    // Next whole-minute boundary after `from`.
    return Math.floor(fromMs / 60000) * 60000 + 60000;
  }

  if (when.every === "hour") {
    const mm = parseMinute(when.at);
    const c = new Date(from);
    c.setSeconds(0, 0);
    c.setMinutes(mm);
    if (c.getTime() <= fromMs) c.setHours(c.getHours() + 1);
    return c.getTime();
  }

  if (when.every === "day" || when.every === "weekday") {
    const [hh, mm] = parseHourMinute(when.at);
    const c = new Date(from);
    c.setSeconds(0, 0);
    c.setHours(hh, mm);
    if (c.getTime() <= fromMs) c.setDate(c.getDate() + 1);
    if (when.every === "weekday") {
      while (isWeekend(c)) c.setDate(c.getDate() + 1);
    }
    return c.getTime();
  }

  return null;
}

export interface TabLike { name: string; layout: string }

/** Pane count for a "C×R" layout string. */
export function paneCount(layout: string): number {
  const [c, r] = layout.split("×").map(n => parseInt(n, 10));
  return (c || 0) * (r || 0);
}

/**
 * Resolve an automation's (tab name, pane index) target to a live pane id
 * `t{tabIdx}p{paneIdx}`, or null when the target tab is gone, the pane index is
 * outside the tab's layout, or the pane is disabled. The tab is matched by name
 * so it tracks renamed/reordered tabs.
 */
export function resolveTargetPane(
  targetTab: string,
  targetPaneIdx: number,
  tabs: TabLike[],
  disabledPanes: Record<string, boolean>,
): string | null {
  const tabIdx = tabs.findIndex(t => t.name === targetTab);
  if (tabIdx < 0) return null;
  if (targetPaneIdx < 0 || targetPaneIdx >= paneCount(tabs[tabIdx].layout)) return null;
  const paneId = `t${tabIdx}p${targetPaneIdx}`;
  if (disabledPanes[paneId]) return null;
  return paneId;
}

/**
 * The text payload to write into the target pane for an automation, or null if
 * the command is empty. A trailing carriage return is the caller's responsibility.
 */
export function dispatchPayload(a: Automation): string | null {
  const cmd = (a.command ?? "").trim();
  return cmd.length > 0 ? cmd : null;
}

/** Armed automations whose nextRunAt is due (non-null and ≤ now). */
export function dueAutomations(automations: Automation[], nowMs: number): Automation[] {
  return automations.filter(a => a.armed && a.nextRunAt != null && a.nextRunAt <= nowMs);
}

/** Append a run (capped to MAX_RUNS, newest first). */
export function appendRun(runs: AutomationRun[], run: AutomationRun): AutomationRun[] {
  return [run, ...runs].slice(0, MAX_RUNS);
}

/**
 * Map a planning automation suggestion (#174) to a scheduler {@link Automation} input.
 * A cron `schedule` becomes an **armed** cron trigger; an on-demand suggestion (no
 * schedule) is a saved-but-**unarmed** command the user can arm or run. The command fires
 * into `targetTab`, pane 0 (the project's launched tab).
 */
export function suggestionToAutomation(
  s: { name: string; command: string; schedule?: string },
  targetTab: string,
): Omit<Automation, "id" | "lastRunAt" | "nextRunAt" | "runs"> {
  const when: AutomationWhen = s.schedule
    ? { kind: "cron", expr: s.schedule }
    : { kind: "simple", every: "day", at: "09:00" };
  return {
    name: s.name,
    armed: !!s.schedule,
    when,
    targetTab,
    targetPaneIdx: 0,
    action: "command",
    command: s.command,
  };
}
