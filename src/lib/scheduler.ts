// Pure scheduler core for Automations (#142). No React / no Tauri here — just the
// data model and the deterministic logic (next-run computation, target
// resolution, payload building) so it can be unit-tested in isolation. The tick
// loop and PTY dispatch live in useScheduler; CRUD lives in the store.

export type Every = "minute" | "hour" | "day" | "weekday";
export type AutomationActionKind = "command" | "knowledge";
export type RunStatus = "ok" | "skipped" | "fail";

export interface AutomationWhen {
  every: Every;
  /** "HH:MM" for day/weekday; ":MM" or "MM" for hour; ignored for minute. */
  at: string;
}

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
  blockId?: string;   // action === "knowledge"
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
  return Number.isFinite(n) ? Math.min(59, Math.max(0, n)) : 0;
}

/** Parse "HH:MM" into [hours, minutes], clamped; missing parts default to 0. */
function parseHourMinute(at: string): [number, number] {
  const [h, m] = at.split(":");
  const hh = Math.min(23, Math.max(0, parseInt(h ?? "0", 10) || 0));
  const mm = Math.min(59, Math.max(0, parseInt(m ?? "0", 10) || 0));
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

export interface BlockLike { id: string; content?: string }

/**
 * The text payload to write into the target pane for an automation, or null if
 * the action is incomplete (no command / missing knowledge block). A trailing
 * carriage return is the caller's responsibility.
 */
export function dispatchPayload(a: Automation, blocks: BlockLike[]): string | null {
  if (a.action === "command") {
    const cmd = (a.command ?? "").trim();
    return cmd.length > 0 ? cmd : null;
  }
  const block = blocks.find(b => b.id === a.blockId);
  const content = block?.content?.trim();
  return content && content.length > 0 ? content : null;
}

/** Armed automations whose nextRunAt is due (non-null and ≤ now). */
export function dueAutomations(automations: Automation[], nowMs: number): Automation[] {
  return automations.filter(a => a.armed && a.nextRunAt != null && a.nextRunAt <= nowMs);
}

/** Append a run (capped to MAX_RUNS, newest first). */
export function appendRun(runs: AutomationRun[], run: AutomationRun): AutomationRun[] {
  return [run, ...runs].slice(0, MAX_RUNS);
}
