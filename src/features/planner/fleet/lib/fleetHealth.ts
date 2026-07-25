// Fleet health & errors (#2240) — a pure unifier of the fleet's ERROR signals that exist but weren't
// surfaced: permission denials (`bsc logs perm`), coordination stalls/deadlocks (`coordinationSummary`),
// warden quarantine trips, and auto-end needs-attention/blocked verdicts. Produces one recent-errors
// feed + counts. No fabrication — every item is a real recorded signal.
//
// The merge itself is the generic `mergeFeeds` (#3465) — the reusable "K streams → one recent-first
// feed with a pinned class + per-kind counts" algorithm this panel was the source for.
import { mergeFeeds, feedStream } from "@/shared/lib/algorithms/streamMerge";

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

/** The kind set, in badge order — passed to `mergeFeeds` so `counts` carries a zero for every one. */
const HEALTH_KINDS: HealthKind[] = ["deadlock", "stalled", "quarantine", "blocked", "attention", "denied"];

/** The per-item payload the feed carries beyond `{ kind, pinned, sortKey }`. */
type HealthPayload = { label: string; detail: string; danger: boolean };

/**
 * Merge every error signal into one recent-first feed + counts. Pure.
 *
 * Delegates the merge to the generic `mergeFeeds` (#3465): this function is now the DOMAIN part —
 * which signal sources exist and how each projects to a kind/label/detail — while the ordering, the
 * pin-above-recency rule, and the per-kind count are the shared algorithm. The stalls/deadlocks are
 * `pinned` (a live problem sits above the time sort), replacing the `sortKey: Infinity` sentinel the
 * hand-written version used, which left two live items with no defined order between them.
 */
export function buildFleetHealth(input: HealthInput): FleetHealth {
  const name = (id: string, fallback: string) => input.nameByPane.get(id) ?? fallback;
  const recentPerm = [...input.perm].sort((a, b) => b.ts_ms - a.ts_ms).slice(0, input.permLimit ?? 8);

  const { items, counts, total, hasItems } = mergeFeeds<HealthKind, HealthPayload>(
    [
      // Coordination stalls / deadlocks — LIVE, so they PIN above the time sort.
      feedStream(input.blocked, (b) => {
        if (!b.stalled && !b.deadlocked) return null;
        const failed = b.deps.filter((d) => d.status === "failed").map((d) => d.ref).join(", ");
        return {
          kind: b.deadlocked ? "deadlock" : "stalled", pinned: true, sortKey: 0,
          label: name(b.session, b.session),
          detail: b.deadlocked ? "in a wait-for cycle — no producer will satisfy it" : `stalled on ${failed || "a failed dependency"}`,
          danger: true,
        };
      }),
      // Warden quarantine trips.
      feedStream(Object.entries(input.quarantined), ([pane, q]) => ({
        kind: "quarantine", pinned: false, sortKey: q.at, label: name(pane, q.streamId), detail: q.summary, danger: true,
      })),
      // Auto-end verdicts that need eyes (done is not an error → dropped by returning null).
      feedStream(Object.entries(input.ended), ([pane, e]) =>
        e.state === "done" ? null : {
          kind: e.state === "blocked" ? "blocked" : "attention", pinned: false, sortKey: e.at,
          label: name(pane, e.streamId), detail: e.summary, danger: e.state === "blocked",
        }),
      // Recent permission denials.
      feedStream(recentPerm, (p) => ({
        kind: "denied", pinned: false, sortKey: p.ts_ms, label: name(p.session, p.session), detail: p.summary, danger: false,
      })),
    ],
    HEALTH_KINDS,
  );

  return { items, counts, total, hasIssues: hasItems };
}
