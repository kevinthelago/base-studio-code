// Wait-for deadlock detection, captured from the LIVE TypeScript so the Rust port can be proved equal.
//
// `coord.log` is written by the BACKEND and by the pure-shell `bsc-*` helpers, and
// `crates/logs/src/coord.rs` already parses and reduces it. What did not move is the reasoning ON TOP:
// whether the parked waiters form a wait-for CYCLE.
//
// A deadlock is the one coordination state nothing recovers from. "Satisfied" is monotonic, so the only
// way a parked waiter never wakes is a ring — no producer in it can move, so all of them hang for ever.
//
// TWO DETAILS ARE THE WHOLE CORRECTNESS, and the corpus below exists to pin them:
//   · a LONE node is a cycle only if it waits on ITSELF (otherwise every parked waiter is "deadlocked");
//   · an edge is drawn only to another PARKED waiter (an unsatisfied dep whose producer is still
//     running is not a deadlock — that producer can finish).
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/fleet/deadlock.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { detectDeadlocks, hasDeadlock, defaultProducerOf } from "@/shared/lib/fleet/coordinationDeadlock";
import type { CoordState, CoordRef } from "@/shared/lib/fleet/coordination.types";

const FIXTURE = join(process.cwd(), "src/shared/lib/fleet/deadlock.fixtures.json");

/** A dep token: `id` is a session ref; `contract:name` etc. name another kind. Non-session kinds
 *  exist so the DEFAULT resolver's rule — only `session:` names a producer — has a case that
 *  separates it from a resolver that maps every kind. */
const dep = (token: string): CoordRef =>
  token.startsWith("contract:")
    ? { kind: "contract", name: token.slice("contract:".length) }
    : { kind: "session", id: token };

/** A CoordState carrying only what the detection reads: waiters and the satisfied latches. */
const state = (
  waiters: Array<{ session: string; deps: string[] }>,
  satisfied: string[] = [],
): CoordState =>
  ({
    waiters: waiters.map((w) => ({ session: w.session, deps: w.deps.map(dep), registeredAt: 0 })),
    // The discriminant is `state`, NOT `status` — a latch is
    // `{ state: "satisfied"; source; at } | { state: "failed"; reason; at }`.
    latches: Object.fromEntries(satisfied.map((s) => [`session:${s}`, { state: "satisfied", source: "landed", at: 1 }])),
    waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [],
  }) as unknown as CoordState;

type Case = { label: string; waiters: Array<{ session: string; deps: string[] }>; satisfied?: string[] };

const SUBJECTS: Case[] = [
  { label: "no waiters at all", waiters: [] },
  { label: "one waiter, no deps", waiters: [{ session: "a", deps: [] }] },

  // THE SINGLETON RULE: a lone waiter is a cycle only if it waits on itself.
  { label: "a lone waiter waiting on a NON-waiter — not a deadlock", waiters: [{ session: "a", deps: ["ghost"] }] },
  { label: "a SELF-LOOP — a waits on a", waiters: [{ session: "a", deps: ["a"] }] },

  // Rings.
  { label: "a two-ring — a waits on b, b waits on a", waiters: [{ session: "a", deps: ["b"] }, { session: "b", deps: ["a"] }] },
  { label: "a three-ring", waiters: [{ session: "a", deps: ["b"] }, { session: "b", deps: ["c"] }, { session: "c", deps: ["a"] }] },
  { label: "a chain that does NOT close", waiters: [{ session: "a", deps: ["b"] }, { session: "b", deps: ["c"] }, { session: "c", deps: [] }] },
  { label: "two INDEPENDENT rings", waiters: [
    { session: "a", deps: ["b"] }, { session: "b", deps: ["a"] },
    { session: "c", deps: ["d"] }, { session: "d", deps: ["c"] },
  ] },
  { label: "a ring plus an innocent bystander", waiters: [
    { session: "a", deps: ["b"] }, { session: "b", deps: ["a"] }, { session: "z", deps: ["ghost"] },
  ] },

  // THE PARKED-PRODUCER RULE: an edge only counts to another waiter.
  { label: "a waits on b, but b is NOT parked — no edge, no deadlock", waiters: [{ session: "a", deps: ["b"] }] },

  // SATISFIED deps impose no wait.
  { label: "a ring whose edge is SATISFIED — no longer blocking", waiters: [
    { session: "a", deps: ["b"] }, { session: "b", deps: ["a"] },
  ], satisfied: ["a"] },
  { label: "a ring where BOTH deps are satisfied", waiters: [
    { session: "a", deps: ["b"] }, { session: "b", deps: ["a"] },
  ], satisfied: ["a", "b"] },
  { label: "a self-loop whose dep is satisfied", waiters: [{ session: "a", deps: ["a"] }], satisfied: ["a"] },

  // THE DEFAULT RESOLVER'S KIND GATE: only a `session:` dep names a producer. A `contract:` dep
  // resolves to nothing under the default, so it draws NO edge — without a case like this, a resolver
  // that mapped every kind would be indistinguishable from the real one.
  { label: "a CONTRACT dep draws no edge under the default resolver", waiters: [
    { session: "a", deps: ["contract:b"] }, { session: "b", deps: ["a"] },
  ] },
  { label: "a contract dep whose name matches a parked session — still no edge", waiters: [
    { session: "a", deps: ["contract:b"] }, { session: "b", deps: ["contract:a"] },
  ] },

  // Multiple deps, only one of which closes a ring.
  { label: "several deps, one closes a ring", waiters: [
    { session: "a", deps: ["ghost", "b"] }, { session: "b", deps: ["a"] },
  ] },
  { label: "a longer ring with a spur", waiters: [
    { session: "a", deps: ["b"] }, { session: "b", deps: ["c"] }, { session: "c", deps: ["a", "d"] }, { session: "d", deps: [] },
  ] },
];

describe("deadlock fixtures", () => {
  it("captures the detection over every graph shape", () => {
    const cases = SUBJECTS.map((c) => {
      const s = state(c.waiters, c.satisfied);
      return {
        label: c.label,
        waiters: c.waiters,
        satisfied: c.satisfied ?? [],
        deadlocks: detectDeadlocks(s, defaultProducerOf),
        hasDeadlock: hasDeadlock(s, defaultProducerOf),
      };
    });
    const next = { note: "GENERATED from @/shared/lib/fleet/coordinationDeadlock — do not hand-edit; see the .gen.test.ts", cases };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("THE SINGLETON RULE: a lone waiter is a cycle only if it waits on itself", () => {
    expect(detectDeadlocks(state([{ session: "a", deps: ["ghost"] }]), defaultProducerOf)).toEqual([]);
    expect(detectDeadlocks(state([{ session: "a", deps: ["a"] }]), defaultProducerOf)).toHaveLength(1);
  });

  it("THE PARKED-PRODUCER RULE: an edge only counts to another parked waiter", () => {
    // b is not a waiter, so a's dep on it draws no edge — b can still finish.
    expect(hasDeadlock(state([{ session: "a", deps: ["b"] }]), defaultProducerOf)).toBe(false);
    expect(hasDeadlock(state([{ session: "a", deps: ["b"] }, { session: "b", deps: ["a"] }]), defaultProducerOf)).toBe(true);
  });

  it("a SATISFIED dep imposes no wait", () => {
    const ring = [{ session: "a", deps: ["b"] }, { session: "b", deps: ["a"] }];
    expect(hasDeadlock(state(ring), defaultProducerOf)).toBe(true);
    expect(hasDeadlock(state(ring, ["a"]), defaultProducerOf), "the ring is broken").toBe(false);
  });

  it("is non-vacuous: the corpus contains both deadlocked and healthy graphs", () => {
    const v = SUBJECTS.map((c) => hasDeadlock(state(c.waiters, c.satisfied), defaultProducerOf));
    expect(v.filter(Boolean).length, "no deadlock in the corpus").toBeGreaterThan(3);
    expect(v.filter((x) => !x).length, "no healthy graph in the corpus").toBeGreaterThan(3);
  });
});
