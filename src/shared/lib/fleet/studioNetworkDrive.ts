// The studio-network pump's PURE decision core (#2940). The app-owned studio sessions
// (planner · designer · librarian) commission artifacts from each other over `coord.log`
// (the `commission`/`deliver` edge, slice 1). This module turns the folded `CoordState.commissions`
// into the two actuations the pump performs — with NO React, Tauri, or timers — so every routing
// rule is unit-tested. The thin actuator (`useStudioNetworkPump`) owns polling, `injectPrompt`,
// the once-guards, and the lazy-mount store flag.
//
// The two actuations:
//   1. AUTHOR TASK — an open, undelivered commission's spec is injected into the TARGET studio
//      session (designer → `bsc ui`, librarian → `bsc graph`), once the target has been reachable
//      long enough to accept input (the settle gate; Claude queues input typed mid-turn).
//   2. DELIVER-BACK — once a `deliver` stamps `delivered` on a commission, the authored artifact id
//      is injected back into the REQUESTER's pane (which is the live planning/designer session).
import type { OpenCommission } from "./coordination.types";
import { refKey } from "./coordinationState";
import {
  DESIGN_STUDIO_SESSION_ID,
  ALGORITHMS_STUDIO_SESSION_ID,
} from "@/shared/lib/session/systemSessions";

/** The commissionable studio nodes. The planner is a requester, never a target (plan-only). */
export type StudioTarget = "designer" | "librarian";

/** Target → its app-owned studio session pane id (where the author task is injected). */
export const STUDIO_PANE: Record<StudioTarget, string> = {
  designer: DESIGN_STUDIO_SESSION_ID,
  librarian: ALGORITHMS_STUDIO_SESSION_ID,
};

/** Human label + the store CLI a target authors into — for the injected task prose. */
const TARGET_KIT: Record<StudioTarget, { noun: string; list: string; deliver: string }> = {
  designer:  { noun: "component", list: "bsc ui list",         deliver: "bsc ui" },
  librarian: { noun: "algorithm", list: "bsc graph impl list", deliver: "bsc graph impl set" },
};

export function isStudioTarget(t: string): t is StudioTarget {
  return t === "designer" || t === "librarian";
}

/** A commission is "open" until a `deliver` stamps its artifact id. */
export function isOpen(c: OpenCommission): boolean {
  return c.delivered === undefined;
}

/** A stable per-commission key for the pump's once-guards (the commission id already is one). */
export function commissionKey(c: OpenCommission): string {
  return c.id;
}

/** Distinct studio targets that have at least one OPEN commission — the set of sessions the pump
 *  must keep reachable (drives the lazy-mount hosts). Unknown targets (a stray/bad line) are ignored. */
export function activeTargets(commissions: OpenCommission[]): StudioTarget[] {
  const out: StudioTarget[] = [];
  for (const c of commissions) {
    if (isOpen(c) && isStudioTarget(c.target) && !out.includes(c.target)) out.push(c.target);
  }
  return out;
}

/** The prompt injected into a target studio session to author (or reuse) the commissioned artifact.
 *  Reuse-first is baked in (slice 3 makes the requester check too); the deliver line closes the loop
 *  so the pump can route the id back. */
export function authorTaskPrompt(c: OpenCommission, target: StudioTarget): string {
  const t = TARGET_KIT[target];
  const ref = c.ref ? ` (ref: ${refKey(c.ref)})` : "";
  return (
    `A planning session commissioned a ${t.noun}${ref}: ${c.body}\n` +
    `First reuse-check with \`${t.list}\` — if an existing ${t.noun} fits, use it. ` +
    `Otherwise author it with \`${t.deliver}\`. ` +
    `When done, run \`bsc-deliver ${c.id} <${t.noun}Id>\` so the requester receives it.`
  );
}

/** The prompt injected back into the REQUESTER's pane once the target delivers. */
export function deliverBackPrompt(c: OpenCommission): string {
  const noun = isStudioTarget(c.target) ? TARGET_KIT[c.target].noun : "artifact";
  return (
    `The ${c.target} delivered the ${noun} you commissioned ("${c.body}"): ` +
    `\`${c.delivered}\`. You can bind/reference it now.`
  );
}

/** One actuation the pump should perform this tick. */
export interface Injection {
  paneId: string;
  prompt: string;
  /** Once-guard key (`author:<id>` / `deliver:<id>`) so the same message is never re-injected. */
  key: string;
}

/** AUTHOR-TASK injections due now: open, undelivered commissions to a known target whose session has
 *  been reachable for at least `settleMs` (so `pty_create` + boot are past) and which have not been
 *  injected yet. `activatedAt` maps target → the ms the pump first saw it active. */
export function authorInjections(
  commissions: OpenCommission[],
  activatedAt: Partial<Record<StudioTarget, number>>,
  now: number,
  settleMs: number,
  alreadyInjected: ReadonlySet<string>,
): Injection[] {
  const out: Injection[] = [];
  for (const c of commissions) {
    if (!isOpen(c) || !isStudioTarget(c.target)) continue;
    const key = `author:${c.id}`;
    if (alreadyInjected.has(key)) continue;
    const since = activatedAt[c.target];
    if (since === undefined || now - since < settleMs) continue;
    out.push({ paneId: STUDIO_PANE[c.target], prompt: authorTaskPrompt(c, c.target), key });
  }
  return out;
}

/** DELIVER-BACK injections due now: commissions whose `delivered` is set and whose result has not
 *  been surfaced to the requester yet. The requester (`from`) is a live session (the planner/designer
 *  that emitted the commission), so no settle gate is needed. */
export function deliverBackInjections(
  commissions: OpenCommission[],
  alreadySurfaced: ReadonlySet<string>,
): Injection[] {
  const out: Injection[] = [];
  for (const c of commissions) {
    if (c.delivered === undefined) continue;
    const key = `deliver:${c.id}`;
    if (alreadySurfaced.has(key)) continue;
    out.push({ paneId: c.from, prompt: deliverBackPrompt(c), key });
  }
  return out;
}
