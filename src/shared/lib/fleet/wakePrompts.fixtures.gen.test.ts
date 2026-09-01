// The wake prompts, captured from the LIVE TypeScript so the Rust port can be proved equal.
//
// These are what a woken agent READS. `src-tauri/src/fleet/wake.rs` performs the wake and already
// carries one such message of its own; `crates/bsc-fleet/src/cli.rs` states the contract outright —
// "without --prompt the app supplies its standard change-request wake". So the backend wakes the
// session and the sentence telling it what happened was written here.
//
// This session opened on a fleet loop: a director re-sent the ORIGINAL TASK as a --prompt six times,
// because the standard wake it should have fallen back to lived across the boundary.
//
// FOUR PROMPTS, each saying something different on purpose — a woken waiter learns which deps landed
// and HOW; a user-paused session learns the user resumed it; an answered session is told explicitly
// NOT to ask the user; an assigned worker is told to re-read its checkpoint BEFORE beginning.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/fleet/wakePrompts.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  wakePromptFor, waitingWakePrompt, answerWakePrompt, assignWakePrompt, planWakes, coordinationSummary,
} from "@/shared/lib/fleet/coordinationWakes";
import { defaultProducerOf } from "@/shared/lib/fleet/coordinationDeadlock";
import type { CoordState, CoordRef, Waiter } from "@/shared/lib/fleet/coordination.types";

const FIXTURE = join(process.cwd(), "src/shared/lib/fleet/wakePrompts.fixtures.json");

const sess = (id: string): CoordRef => ({ kind: "session", id });
const issue = (n: number): CoordRef => ({ kind: "issue", number: n });

/** A CoordState carrying waiters and their latches. `source` is how a dep was satisfied — the part a
 *  fresh session needs in order to trust it. */
const state = (
  waiters: Array<{ session: string; deps: CoordRef[]; checkpoint?: string }>,
  latches: Record<string, { state: "satisfied" | "failed"; source?: string; reason?: string }> = {},
): CoordState =>
  ({
    waiters: waiters.map((w) => ({ ...w, registeredAt: 0 })),
    latches: Object.fromEntries(
      Object.entries(latches).map(([k, v]) =>
        [k, v.state === "satisfied" ? { state: "satisfied", source: v.source ?? "landed", at: 1 } : { state: "failed", reason: v.reason ?? "boom", at: 1 }],
      ),
    ),
    waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [],
  }) as unknown as CoordState;

/** `registeredAt` is carried even though no prompt reads it: the fixture is the Rust `Waiter`'s input
 *  too, and that type requires it. A helper that omits a field the CONSUMER needs makes the artifact
 *  lossy in the other direction from the usual — the writer, not the reader. */
const w = (session: string, deps: CoordRef[], checkpoint?: string): Waiter =>
  ({ session, deps, registeredAt: 0, ...(checkpoint ? { checkpoint } : {}) }) as Waiter;

/** Waiter prompts: one dep vs many, with and without a checkpoint, and every satisfaction source. */
const WAITER_CASES: Array<{ label: string; waiter: Waiter; state: CoordState }> = [
  { label: "one dep, landed, no checkpoint", waiter: w("a", [sess("b")]), state: state([], { "session:b": { state: "satisfied", source: "landed" } }) },
  { label: "one dep, with a checkpoint", waiter: w("a", [sess("b")], "cp-17"), state: state([], { "session:b": { state: "satisfied", source: "landed" } }) },
  { label: "TWO deps — the plural must agree", waiter: w("a", [sess("b"), sess("c")], "cp-2"), state: state([], { "session:b": { state: "satisfied", source: "landed" }, "session:c": { state: "satisfied", source: "merged" } }) },
  { label: "a dep satisfied by a different SOURCE", waiter: w("a", [sess("b")]), state: state([], { "session:b": { state: "satisfied", source: "closed" } }) },
  { label: "a dep with NO latch — reported as ready", waiter: w("a", [sess("ghost")]), state: state([]) },
  { label: "an ISSUE dep", waiter: w("a", [issue(4212)], "cp-9"), state: state([], { "#4212": { state: "satisfied", source: "landed" } }) },
  { label: "a mix of kinds", waiter: w("a", [sess("b"), issue(7)]), state: state([], { "session:b": { state: "satisfied", source: "landed" }, "#7": { state: "satisfied", source: "merged" } }) },
];

const WAITING_CASES = [
  { label: "a reason and a checkpoint", waiting: { session: "a", reason: "needs a decision", checkpoint: "cp-3", at: 1 } },
  { label: "a reason, no checkpoint", waiting: { session: "a", reason: "needs a decision", at: 1 } },
  { label: "an EMPTY reason", waiting: { session: "a", reason: "", at: 1 } },
  { label: "a whitespace-only reason", waiting: { session: "a", reason: "   ", checkpoint: "cp-1", at: 1 } },
];

const ANSWER_CASES = [
  { label: "an answer and a checkpoint", answered: { session: "a", answer: "use the second approach", checkpoint: "cp-4" } },
  { label: "an answer, no checkpoint", answered: { session: "a", answer: "use the second approach" } },
  { label: "an EMPTY answer falls back to the notes", answered: { session: "a", answer: "" } },
  { label: "a whitespace-only answer", answered: { session: "a", answer: "  ", checkpoint: "cp-5" } },
];

const ASSIGN_CASES = [
  { label: "title, body and checkpoint", assigned: { session: "a", title: "fix the parser", body: "It drops a trailing comma.", checkpoint: "cp-6" } },
  { label: "no title", assigned: { session: "a", title: "", body: "Do the thing.", checkpoint: "cp-7" } },
  { label: "no body", assigned: { session: "a", title: "fix the parser", body: "" } },
  { label: "neither title nor body", assigned: { session: "a", title: "", body: "" } },
  { label: "a whitespace-only body", assigned: { session: "a", title: "t", body: "   ", checkpoint: "cp-8" } },
];

/** Summary graphs: a healthy wait, a stalled chain, and a deadlocked ring. */
const SUMMARY_CASES = [
  { label: "one waiter, pending", waiters: [{ session: "a", deps: [sess("ghost")] }], latches: {} },
  { label: "a STALLED chain — a dep failed", waiters: [{ session: "a", deps: [sess("b")] }], latches: { "session:b": { state: "failed" as const } } },
  { label: "a DEADLOCKED ring", waiters: [{ session: "a", deps: [sess("b")] }, { session: "b", deps: [sess("a")] }], latches: {} },
  { label: "a satisfied dep is neither stalled nor deadlocked", waiters: [{ session: "a", deps: [sess("b")] }], latches: { "session:b": { state: "satisfied" as const } } },
  { label: "a waiter with a checkpoint", waiters: [{ session: "a", deps: [sess("ghost")], checkpoint: "cp-11" }], latches: {} },
];

describe("wakePrompts fixtures", () => {
  it("captures all four prompts, planWakes and the summary", () => {
    const next = {
      note: "GENERATED from @/shared/lib/fleet/coordinationWakes — do not hand-edit; see the .gen.test.ts",
      waiterPrompts: WAITER_CASES.map((c) => ({ label: c.label, waiter: c.waiter, latches: c.state.latches, prompt: wakePromptFor(c.waiter, c.state) })),
      waitingPrompts: WAITING_CASES.map((c) => ({ label: c.label, waiting: c.waiting, prompt: waitingWakePrompt(c.waiting as never) })),
      answerPrompts: ANSWER_CASES.map((c) => ({ label: c.label, answered: c.answered, prompt: answerWakePrompt(c.answered as never) })),
      assignPrompts: ASSIGN_CASES.map((c) => ({ label: c.label, assigned: c.assigned, prompt: assignWakePrompt(c.assigned as never) })),
      planned: (() => {
        const s = state([], { "session:b": { state: "satisfied", source: "landed" } });
        return planWakes([w("a", [sess("b")], "cp-1"), w("z", [sess("b")])], s);
      })(),
      // Record the BUILT state, not the shorthand that produced it. The shorthand is a convenience of
      // this generator; the Rust side deserializes real `Waiter` and `LatchStatus` values, so recording
      // the inputs would hand it a shape it cannot read — the artifact lossy on the WRITER side.
      summaries: SUMMARY_CASES.map((c) => {
        const s = state(c.waiters, c.latches as never);
        return {
          label: c.label,
          waiters: s.waiters,
          latches: s.latches,
          view: coordinationSummary(s, defaultProducerOf),
        };
      }),
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("a woken waiter is told HOW each dep was satisfied — not merely that it was", () => {
    const s = state([], { "session:b": { state: "satisfied", source: "merged" } });
    expect(wakePromptFor(w("a", [sess("b")]), s), "the source is what lets a fresh session trust it").toContain("(merged)");
  });

  it("the answered wake keeps its explicit 'Do not ask the user'", () => {
    // Without it, a parked session parks again the moment it resumes.
    expect(answerWakePrompt({ session: "a", answer: "go" } as never)).toContain("Do not ask the user");
  });

  it("an assigned worker re-reads its checkpoint BEFORE beginning", () => {
    const p = assignWakePrompt({ session: "a", title: "t", body: "b", checkpoint: "cp" } as never);
    expect(p.indexOf("First re-read"), "the order is the instruction").toBeGreaterThan(p.indexOf("assigned you new work"));
  });

  it("a waiter with no checkpoint gets no checkpoint line at all", () => {
    const s = state([], { "session:b": { state: "satisfied", source: "landed" } });
    expect(wakePromptFor(w("a", [sess("b")]), s)).not.toContain("checkpoint");
  });
});
