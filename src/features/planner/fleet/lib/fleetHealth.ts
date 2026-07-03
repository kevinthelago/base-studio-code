// Fleet health & errors (#2240) — a pure unifier of the fleet's ERROR signals that exist but weren't
// surfaced: permission denials (`bsc logs perm`), coordination stalls/deadlocks (`coordinationSummary`),
// warden quarantine trips, and auto-end needs-attention/blocked verdicts. Produces one recent-errors
// feed + counts. No fabrication — every item is a real recorded signal.

/** One `bsc logs perm --json` row (subset). `summary` is already human-readable (e.g. "scope block src/App.tsx"). */
export interface PermEvent { ts_ms: number; session: string; summary: string }
/** Warden quarantine (store `quarantinedPanes` value). */
export interface QuarantineLike { streamId: string; summary: string; at: number; acknowledged?: boolean }
/** Auto-end verdict (store `endedPanes` value). */
export interface EndedLike { state: "done" | "needs-attention" | "blocked"; streamId: string; summary: string; at: number }
/** A coordination BlockedView (subset) — stalled = a failed dep; deadlocked = a wait-for cycle. */
export interface BlockedLike { session: string; stalled: boolean; deadlocked: boolean; deps: { ref: string; status: string }[] }

export type HealthKind = "deadlock" | "stalled" | "quarantine" | "blocked" | "attention" | "denied";

export interface HealthItem {
  kind: HealthKind;
  /** The worker/agent the item is about (resolved name, else the raw id). */
  label: string;
  /** The one-line reason. */
  detail: string;
  /** Sort key (epoch ms; live coord issues use Infinity so they pin to the top). */
  sortKey: number;
  /** true = red (error), false = amber (warning). */
  danger: boolean;
}

export interface FleetHealth {
  items: HealthItem[];
  counts: Record<HealthKind, number>;
  total: number;
  hasIssues: boolean;
}

/** Display label per kind. */
export const HEALTH_LABEL: Record<HealthKind, string> = {
  deadlock: "deadlock", stalled: "stalled", quarantine: "quarantined",
  blocked: "blocked", attention: "needs attention", denied: "denied",
};

export interface HealthInput {
  perm: PermEvent[];
  quarantined: Record<string, QuarantineLike>;
  ended: Record<string, EndedLike>;
  blocked: BlockedLike[];
  /** paneId → worker display name, to humanize ids. */
  nameByPane: Map<string, string>;
  /** Cap on the number of recent permission denials shown. Default 8. */
  permLimit?: number;
}

/** Merge every error signal into one recent-first feed + counts. Pure. */
export function buildFleetHealth(input: HealthInput): FleetHealth {
  const name = (id: string, fallback: string) => input.nameByPane.get(id) ?? fallback;
  const items: HealthItem[] = [];

  // Coordination stalls / deadlocks — LIVE, so they pin to the top (sortKey Infinity).
  for (const b of input.blocked) {
    if (!b.stalled && !b.deadlocked) continue;
    const failed = b.deps.filter((d) => d.status === "failed").map((d) => d.ref).join(", ");
    items.push({
      kind: b.deadlocked ? "deadlock" : "stalled",
      label: name(b.session, b.session),
      detail: b.deadlocked ? "in a wait-for cycle — no producer will satisfy it" : `stalled on ${failed || "a failed dependency"}`,
      sortKey: Infinity, danger: true,
    });
  }
  // Warden quarantine trips.
  for (const [pane, q] of Object.entries(input.quarantined)) {
    items.push({ kind: "quarantine", label: name(pane, q.streamId), detail: q.summary, sortKey: q.at, danger: true });
  }
  // Auto-end verdicts that need eyes (done is not an error).
  for (const [pane, e] of Object.entries(input.ended)) {
    if (e.state === "done") continue;
    items.push({
      kind: e.state === "blocked" ? "blocked" : "attention",
      label: name(pane, e.streamId), detail: e.summary, sortKey: e.at, danger: e.state === "blocked",
    });
  }
  // Recent permission denials.
  const recentPerm = [...input.perm].sort((a, b) => b.ts_ms - a.ts_ms).slice(0, input.permLimit ?? 8);
  for (const p of recentPerm) {
    items.push({ kind: "denied", label: name(p.session, p.session), detail: p.summary, sortKey: p.ts_ms, danger: false });
  }

  items.sort((a, b) => b.sortKey - a.sortKey);
  const counts: Record<HealthKind, number> = { deadlock: 0, stalled: 0, quarantine: 0, blocked: 0, attention: 0, denied: 0 };
  for (const it of items) counts[it.kind]++;
  return { items, counts, total: items.length, hasIssues: items.length > 0 };
}
