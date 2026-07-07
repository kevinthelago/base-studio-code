// Alert taxonomy (#2498) — ONE event model for everything that should reach the user's phone:
// the push-worthy moments of a running fleet/planner, derived from the SAME sources the desktop
// surfaces them from (the coordination pump's CoordState, the focus queue's awaiting set, the
// planner's gate/turn transitions). Pure — no React/Tauri — so the derivation, dedup, and the
// capped rolling inbox are unit-testable. The inbox rides the `alerts` store_state domain; each
// FRESH alert additionally fires an FCM push (see alertHub.ts / tunnel_emit_alert).

import type { CoordState } from "@/shared/lib/fleet/coordination";

/** The alert vocabulary (#2498). Fixed — mobile switches its notification routing on it. */
export type AlertKind =
  | "agent-paused"     // bsc-wait: an agent parked itself for the user (#297)
  | "prompt-waiting"   // a console pane flipped to awaiting-input (the user_request moment)
  | "worker-question"  // bsc-ask: a worker asked the director a question (#369)
  | "fleet-failed"     // a dep/issue latch FAILED — a stalled chain needing attention
  | "fleet-landed"     // a dep/issue latch satisfied (landed/merged/closed)
  | "gate-ready"       // the active plan stage's gate passed — awaiting the USER's confirm
  | "planner-waiting"; // the planner finished a turn and is waiting on the user

/** One alert. `id` is the stable dedup key — derivation is idempotent per source event. */
export interface AlertEvent {
  id: string;
  kind: AlertKind;
  /** The pane/session the alert is about, when it has one. */
  paneId?: string;
  /** The owning project key, when known. */
  project?: string;
  /** Short human-facing line (also the push body). */
  text: string;
  /** Epoch ms. */
  at: number;
}

/** Rolling-inbox cap: the newest N alerts are kept. */
export const ALERT_INBOX_CAP = 100;

const truncate = (s: string, max = 140): string => {
  const collapsed = s.split(/\s+/).join(" ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
};

// ── Coord-log sources ────────────────────────────────────────────────────────────
// CoordState entries carry their own `at` from the log line, so the derived ids are stable
// across polls — re-deriving from the same log yields the same alerts and foldAlerts dedups.

/** Derive the coord-sourced alert candidates from a replayed {@link CoordState}. */
export function coordAlerts(state: CoordState): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const w of state.waiting) {
    out.push({
      id: `agent-paused:${w.session}:${w.at}`,
      kind: "agent-paused",
      paneId: w.session,
      text: w.reason ? truncate(w.reason) : `${w.session} paused and is waiting for you.`,
      at: w.at,
    });
  }
  for (const a of state.asking) {
    out.push({
      id: `worker-question:${a.session}:${a.at}`,
      kind: "worker-question",
      paneId: a.session,
      text: truncate(a.question || `${a.session} asked the director a question.`),
      at: a.at,
    });
  }
  for (const [ref, latch] of Object.entries(state.latches)) {
    if (latch.state === "failed") {
      out.push({
        id: `fleet-failed:${ref}:${latch.at}`,
        kind: "fleet-failed",
        text: truncate(`${ref} failed${latch.reason ? `: ${latch.reason}` : ""}`),
        at: latch.at,
      });
    } else {
      out.push({
        id: `fleet-landed:${ref}:${latch.at}`,
        kind: "fleet-landed",
        text: `${ref} ${latch.source}`,
        at: latch.at,
      });
    }
  }
  return out;
}

// ── Transition sources ───────────────────────────────────────────────────────────
// These have no durable log to key off, so a NEW alert is an entry present now but not in the
// previous snapshot; `now` stamps it. A pane that resolves and awaits again re-alerts.

/** One awaiting console pane (from the focus queue, resolved to its identity id). */
export interface AwaitingPane {
  paneId: string;
  name: string;
}

/** Derive prompt-waiting alerts for panes that JUST entered the awaiting set. */
export function promptAlerts(
  prev: ReadonlyArray<AwaitingPane>,
  next: ReadonlyArray<AwaitingPane>,
  now: number,
): AlertEvent[] {
  const seen = new Set(prev.map((p) => p.paneId));
  return next
    .filter((p) => !seen.has(p.paneId))
    .map((p) => ({
      id: `prompt-waiting:${p.paneId}:${now}`,
      kind: "prompt-waiting" as const,
      paneId: p.paneId,
      text: `${p.name} is waiting for your input.`,
      at: now,
    }));
}

/** A gate-ready alert for a stage whose gate JUST passed (false→true per stage). */
export function gateReadyAlert(
  project: string,
  stage: string,
  now: number,
): AlertEvent {
  return {
    id: `gate-ready:${project}:${stage}:${now}`,
    kind: "gate-ready",
    project,
    text: `Stage "${stage}" gate passed — awaiting your confirm.`,
    at: now,
  };
}

/** A planner-waiting alert: the planner finished a turn (its newest transcript message is an
 *  assistant turn) and is waiting on the user. Keyed by the message timestamp, so the same turn
 *  never re-alerts. */
export function plannerWaitingAlert(
  project: string,
  paneId: string,
  lastText: string,
  at: number,
): AlertEvent {
  return {
    id: `planner-waiting:${paneId}:${at}`,
    kind: "planner-waiting",
    paneId,
    project,
    text: truncate(lastText) || "The planner is waiting for you.",
    at,
  };
}

// ── The rolling inbox ────────────────────────────────────────────────────────────

/** Fold candidate alerts into the inbox: candidates whose `id` is already present are dropped,
 *  the rest append in `at` order, and the inbox keeps only the newest {@link ALERT_INBOX_CAP}.
 *  Returns the (possibly unchanged — same reference) inbox plus the FRESH alerts to push. */
export function foldAlerts(
  inbox: ReadonlyArray<AlertEvent>,
  candidates: ReadonlyArray<AlertEvent>,
): { inbox: ReadonlyArray<AlertEvent>; fresh: AlertEvent[] } {
  const known = new Set(inbox.map((a) => a.id));
  const fresh = candidates.filter((a) => !known.has(a.id));
  // Dedup WITHIN the batch too (two sources could mint the same id in one tick).
  const uniqueFresh: AlertEvent[] = [];
  const batch = new Set<string>();
  for (const a of fresh) {
    if (batch.has(a.id)) continue;
    batch.add(a.id);
    uniqueFresh.push(a);
  }
  if (uniqueFresh.length === 0) return { inbox, fresh: [] };
  uniqueFresh.sort((a, b) => a.at - b.at);
  const next = [...inbox, ...uniqueFresh];
  return { inbox: next.slice(Math.max(0, next.length - ALERT_INBOX_CAP)), fresh: uniqueFresh };
}

/** The FCM banner fields for one alert (title per kind; body = the alert text). Pure so the
 *  push contract is pinned by tests. */
export function alertPushFields(a: AlertEvent): { title: string; body: string } {
  const titles: Record<AlertKind, string> = {
    "agent-paused": "Agent paused",
    "prompt-waiting": "Agent awaiting input",
    "worker-question": "Worker question",
    "fleet-failed": "Fleet: dependency failed",
    "fleet-landed": "Fleet: landed",
    "gate-ready": "Plan stage ready",
    "planner-waiting": "Planner waiting",
  };
  const who = a.paneId ?? a.project;
  return {
    title: who ? `${titles[a.kind]} — ${who}` : titles[a.kind],
    body: a.text,
  };
}
