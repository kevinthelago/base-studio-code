// The fault-triage decision, captured from the LIVE TypeScript so the Rust port can be proved equal.
//
// `fault-triage.ts` turns a project's unresolved runtime faults into a bounded, deduped set of fix
// dispatches. Three guarantees ride on it, each a real failure mode: the GATE (auto-triage off means
// dispatch nothing), DEDUP (never dispatch the same fingerprint twice while it stays open), and the
// RATE-LIMIT (a fault storm must not become a worker storm). The faults live in error.db, which Rust
// owns; only the decision is in the renderer.
//
// Regenerate deliberately:
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/fleet/faultTriage.fixtures.gen.test.ts
//
// A regeneration that changes the file is a CHANGE OF BEHAVIOUR. Read the diff before committing it.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  planFaultDispatch,
  unresolvedCount,
  worstFault,
  DEFAULT_FAULT_TRIAGE,
  type FaultLite,
  type FaultTriageConfig,
} from "@/shared/lib/fleet/faultTriage";

const FIXTURE = join(process.cwd(), "src/shared/lib/fleet/faultTriage.fixtures.json");

const cfg = (o: Partial<FaultTriageConfig> = {}): FaultTriageConfig =>
  ({ enabled: true, ...DEFAULT_FAULT_TRIAGE, ...o });

const f = (
  fingerprint: string,
  level: FaultLite["level"],
  count: number,
  resolvedAt: number | null = null,
): FaultLite => ({ fingerprint, level, title: `${fingerprint} title`, count, resolvedAt });

interface Case { name: string; faults: FaultLite[]; dispatched: string[]; cfg: FaultTriageConfig }

/** Each case names the guarantee or branch it exists to pin. */
const CASES: Case[] = [
  { name: "nothing open", faults: [], dispatched: [], cfg: cfg() },
  {
    name: "GATE off — surface only, dispatch nothing",
    faults: [f("aa", "fatal", 9)], dispatched: [], cfg: cfg({ enabled: false }),
  },
  {
    name: "GATE off still PRUNES a resolved fingerprint",
    faults: [f("aa", "fatal", 9, 1000)], dispatched: ["aa"], cfg: cfg({ enabled: false }),
  },
  {
    name: "DEDUP — an already-dispatched open fault is not dispatched again",
    faults: [f("aa", "error", 3)], dispatched: ["aa"], cfg: cfg(),
  },
  {
    name: "a dispatched fingerprint that RESOLVED is pruned from in-flight",
    faults: [f("aa", "error", 3, 1000), f("bb", "error", 3)], dispatched: ["aa"], cfg: cfg(),
  },
  {
    name: "RATE-LIMIT — maxPerCycle caps one cycle",
    faults: [f("aa", "fatal", 9), f("bb", "fatal", 8), f("cc", "fatal", 7)],
    dispatched: [], cfg: cfg({ maxPerCycle: 2, maxInFlight: 10 }),
  },
  {
    // NOT a rate-limit case, despite where it sits: `zz-gone` names no OPEN fault, so it is pruned
    // from in-flight and the slots it was occupying come back. Named for what it actually pins.
    name: "a dispatched fingerprint that is no longer open is pruned, freeing its slot",
    faults: [f("aa", "fatal", 9), f("bb", "fatal", 8), f("cc", "fatal", 7)],
    dispatched: ["zz-gone"], cfg: cfg({ maxInFlight: 2, maxPerCycle: 5 }),
  },
  {
    // The real one: the in-flight fingerprint IS open, so it holds its slot and only one remains.
    name: "RATE-LIMIT — one genuinely in-flight fault leaves exactly one slot",
    faults: [f("held", "error", 1), f("aa", "fatal", 9), f("bb", "fatal", 8)],
    dispatched: ["held"], cfg: cfg({ maxInFlight: 2, maxPerCycle: 5 }),
  },
  {
    name: "RATE-LIMIT — no slots at all dispatches nothing",
    faults: [f("aa", "fatal", 9), f("in1", "error", 1), f("in2", "error", 1)],
    dispatched: ["in1", "in2"], cfg: cfg({ maxInFlight: 2, maxPerCycle: 5 }),
  },
  {
    name: "minLevel excludes a warn",
    faults: [f("aa", "warn", 99), f("bb", "error", 1)], dispatched: [], cfg: cfg({ minLevel: "error" }),
  },
  {
    name: "threshold excludes a low-count fault",
    faults: [f("aa", "error", 1), f("bb", "error", 5)], dispatched: [], cfg: cfg({ threshold: 3 }),
  },
  {
    name: "ORDER — level outranks count",
    faults: [f("aa", "error", 100), f("bb", "fatal", 1)], dispatched: [], cfg: cfg({ maxPerCycle: 1 }),
  },
  {
    name: "ORDER — equal level falls back to count",
    faults: [f("aa", "error", 2), f("bb", "error", 7)], dispatched: [], cfg: cfg({ maxPerCycle: 1 }),
  },
  {
    name: "ORDER — equal level and count falls back to fingerprint",
    faults: [f("zz", "error", 4), f("aa", "error", 4)], dispatched: [], cfg: cfg({ maxPerCycle: 1 }),
  },
  {
    name: "a resolved fault is never a candidate",
    faults: [f("aa", "fatal", 9, 1234), f("bb", "error", 2)], dispatched: [], cfg: cfg(),
  },
];

function build() {
  return {
    note: "GENERATED from the live TypeScript — see faultTriage.fixtures.gen.test.ts",
    defaults: DEFAULT_FAULT_TRIAGE,
    cases: CASES.map((c) => ({
      ...c,
      plan: planFaultDispatch(c.faults, c.dispatched, c.cfg),
      unresolvedCount: unresolvedCount(c.faults),
      worstFault: worstFault(c.faults),
    })),
  };
}

describe("the fault-triage decision is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const text = JSON.stringify(build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("exercises each guarantee, so a port cannot pass on the easy cases alone", () => {
    const b = build();
    expect(b.cases.some((c) => !c.cfg.enabled && c.plan.dispatch.length === 0)).toBe(true);
    expect(b.cases.some((c) => c.dispatched.length > 0 && c.plan.dispatch.length === 0)).toBe(true);
    expect(b.cases.some((c) => c.faults.length > c.plan.dispatch.length && c.plan.dispatch.length > 0)).toBe(true);
    expect(b.cases.some((c) => c.worstFault !== null)).toBe(true);
  });
});
