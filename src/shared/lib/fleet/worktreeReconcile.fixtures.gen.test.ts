// The boot worktree reconciliation, captured from the LIVE TypeScript so the Rust port can be proved
// equal — and so the ONE thing it gets wrong is pinned rather than carried across.
//
// Every input is Rust's. Rust owns the worktrees, runs the boot GC, and `gc_worktrees_on_boot` already
// RETURNS the exact set it reclaimed. The renderer re-derives the same fact with a `dir_exists` probe
// per pane and infers a verdict from the absence.
//
// THE INFERENCE IS WRONG ON ONE OF THE GC'S TWO ARMS. `gc_worktrees_impl` reclaims when
// `hub_gone || worktree_is_disposable(clone, wt)`. The second arm proves clean + merged; the first
// proves NEITHER. `reclaimedWorkerEnd` nonetheless reports "work merged" unconditionally. Rust logs
// which arm fired and then drops it into a log string — so the fixture below records the summary
// VERBATIM, and the Rust characterization test names it as the defect it is.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/fleet/worktreeReconcile.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  worktreeChecks,
  reclaimedWorkerEnd,
  reconcileMissingWorktrees,
} from "@/shared/lib/fleet/worktreeReconcile";
import type { WorktreeCheck } from "@/shared/lib/fleet/worktreeReconcile";
import type { EndedInfo } from "@/store/types/console";

const FIXTURE = join(process.cwd(), "src/shared/lib/fleet/worktreeReconcile.fixtures.json");

/** ONE persisted pane, in the order the store holds it.
 *
 *  The live selector iterates `Object.keys(fleetPaneStreams)` — INSERTION order — and the output order
 *  is part of the contract. Recording four maps would make the fixture's meaning depend on a JSON
 *  object's key order surviving a Rust deserializer, which it does not. So the corpus is an ordered
 *  LIST and the generator builds the maps from it, in that order. */
type Pane = { paneId: string; stream?: string; cwd?: string; ended?: boolean; disabled?: boolean };

type SelectCase = { label: string; panes: Pane[] };

const SELECT: SelectCase[] = [
  { label: "nothing at all", panes: [] },
  { label: "one ordinary worker", panes: [{ paneId: "p:api", stream: "api", cwd: "/wt/proj/repo--api" }] },
  {
    label: "several workers — the output order follows the store's order, not a sort",
    panes: [
      { paneId: "p:web", stream: "web", cwd: "/wt/b" },
      { paneId: "p:api", stream: "api", cwd: "/wt/a" },
      { paneId: "p:db", stream: "db", cwd: "/wt/c" },
    ],
  },
  {
    label: "an ALREADY-ENDED pane is not re-checked",
    panes: [
      { paneId: "p:api", stream: "api", cwd: "/wt/a", ended: true },
      { paneId: "p:web", stream: "web", cwd: "/wt/b" },
    ],
  },
  {
    label: "a DISABLED pane is not checked",
    panes: [
      { paneId: "p:api", stream: "api", cwd: "/wt/a" },
      { paneId: "p:web", stream: "web", cwd: "/wt/b", disabled: true },
    ],
  },
  {
    label: "a pane with NO cwd is not checked — there is nothing to probe",
    panes: [
      { paneId: "p:api", stream: "api", cwd: "/wt/a" },
      { paneId: "p:web", stream: "web" },
    ],
  },
  {
    label: "an EMPTY-STRING cwd is not checked either — falsy, not merely absent",
    panes: [{ paneId: "p:api", stream: "api", cwd: "" }],
  },
  {
    label: "a pane with an undefined stream is not checked",
    panes: [
      { paneId: "p:api", cwd: "/wt/a" },
      { paneId: "p:web", stream: "web", cwd: "/wt/b" },
    ],
  },
  {
    label: "a cwd for a pane that is NOT a fleet worker is ignored — membership is the filter",
    panes: [{ paneId: "p:api", stream: "api", cwd: "/wt/a" }],
    // p:director and t0p0 are added to paneCwds ONLY, below.
  },
  {
    label: "ended AND disabled at once",
    panes: [{ paneId: "p:api", stream: "api", cwd: "/wt/a", ended: true, disabled: true }],
  },
  {
    label: "the stream id differs from the pane id — both are carried",
    panes: [{ paneId: "man:build:p2", stream: "payments", cwd: "/wt/proj/repo--payments" }],
  },
];

/** Extra cwds for panes that are NOT fleet workers — membership, not the cwd map, is the filter. */
const NON_WORKER_CWDS: Record<string, Record<string, string>> = {
  "a cwd for a pane that is NOT a fleet worker is ignored — membership is the filter": {
    "p:director": "/hub",
    t0p0: "/somewhere",
  },
};

/** Build the four store maps from the ordered list, preserving that order. */
function maps(k: SelectCase) {
  const fleetPaneStreams: Record<string, { id: string } | undefined> = {};
  const endedPanes: Record<string, unknown> = {};
  const disabledPanes: Record<string, unknown> = {};
  const paneCwds: Record<string, string> = {};
  for (const p of k.panes) {
    fleetPaneStreams[p.paneId] = p.stream === undefined ? undefined : { id: p.stream };
    if (p.cwd !== undefined) paneCwds[p.paneId] = p.cwd;
    if (p.ended) endedPanes[p.paneId] = { state: "done", streamId: p.stream ?? "", summary: "s", at: 1 };
    if (p.disabled) disabledPanes[p.paneId] = true;
  }
  Object.assign(paneCwds, NON_WORKER_CWDS[k.label] ?? {});
  return { fleetPaneStreams, endedPanes, disabledPanes, paneCwds };
}

/** A whole reconciliation scenario. `present` is the set of cwds the probe reports as still there. */
type ReconcileCase = {
  label: string;
  checks: WorktreeCheck[];
  present: string[];
  alreadyEnded: string[];
};

const c = (paneId: string, cwd: string, streamId: string): WorktreeCheck => ({ paneId, cwd, streamId });

const RECONCILE: ReconcileCase[] = [
  { label: "no checks", checks: [], present: [], alreadyEnded: [] },
  {
    label: "worktree still there — the worker is left alone",
    checks: [c("p:api", "/wt/a", "api")], present: ["/wt/a"], alreadyEnded: [],
  },
  {
    label: "worktree GONE — ended, and this is the claim under scrutiny",
    checks: [c("p:api", "/wt/a", "api")], present: [], alreadyEnded: [],
  },
  {
    label: "gone but ALREADY ended meanwhile — not re-marked",
    checks: [c("p:api", "/wt/a", "api")], present: [], alreadyEnded: ["p:api"],
  },
  {
    label: "some gone, some present — only the gone ones end",
    checks: [c("p:api", "/wt/a", "api"), c("p:web", "/wt/b", "web"), c("p:db", "/wt/c", "db")],
    present: ["/wt/b"], alreadyEnded: [],
  },
  {
    label: "every worktree gone",
    checks: [c("p:api", "/wt/a", "api"), c("p:web", "/wt/b", "web")],
    present: [], alreadyEnded: [],
  },
  {
    label: "gone, and a DIFFERENT pane was already ended — the skip is per pane",
    checks: [c("p:api", "/wt/a", "api"), c("p:web", "/wt/b", "web")],
    present: [], alreadyEnded: ["p:web"],
  },
  {
    label: "two panes share one cwd — both end",
    checks: [c("p:api", "/wt/same", "api"), c("p:web", "/wt/same", "web")],
    present: [], alreadyEnded: [],
  },
];

const NOW = 1_700_000_000_000;

describe("worktreeReconcile fixtures", () => {
  it("captures the live selection, the verdict and the reconciliation", async () => {
    const select = SELECT.map((k) => {
      const m = maps(k);
      return {
        label: k.label,
        panes: k.panes,
        // Every non-worker cwd, so the Rust side sees the same map the selector saw.
        extraCwds: NON_WORKER_CWDS[k.label] ?? {},
        // The WHOLE check objects, in order — not just the pane ids.
        checks: worktreeChecks(m.fleetPaneStreams, m.endedPanes, m.disabledPanes, m.paneCwds),
      };
    });

    const reconcile = [];
    for (const r of RECONCILE) {
      // Build the real state and record ITS values — never a summary of the inputs.
      const marked: { paneId: string; info: EndedInfo }[] = [];
      const ended = await reconcileMissingWorktrees(
        r.checks,
        async (cwd) => r.present.includes(cwd),
        (paneId) => r.alreadyEnded.includes(paneId),
        (paneId, info) => void marked.push({ paneId, info }),
        () => NOW,
      );
      reconcile.push({ ...r, ended, marked });
    }

    // The verdict on its own, so a Rust test can name it without a reconciliation around it.
    const verdicts = ["api", "payments", ""].map((streamId) => ({
      streamId,
      info: reclaimedWorkerEnd(streamId, NOW),
    }));

    const doc = { now: NOW, select, reconcile, verdicts };

    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(doc, null, 2) + "\n");
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(doc);
  });

  it("the summary asserts merged work — the claim the Rust side pins as unproven", () => {
    // The GC reclaims when `hub_gone || worktree_is_disposable(...)`. Only the second arm proves
    // merged+clean. This wording is unconditional, so it is a false claim on the first arm.
    const info = reclaimedWorkerEnd("api", NOW);
    expect(info.state).toBe("done");
    expect(info.summary).toContain("work merged");
    expect(info.summary).not.toContain("orphan");
  });

  it("every check carries a stream and a cwd", () => {
    for (const k of SELECT) {
      const m = maps(k);
      for (const chk of worktreeChecks(m.fleetPaneStreams, m.endedPanes, m.disabledPanes, m.paneCwds)) {
        expect(chk.cwd).toBeTruthy();
        expect(chk.streamId).toBeTruthy();
        expect(chk.paneId).toBeTruthy();
      }
    }
  });
});
