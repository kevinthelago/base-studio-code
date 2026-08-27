// The TS half of the dependency-gate CONTRACT (#the-director-can-see-which-streams-are-held).
//
// `streamGate.ts` is the LAUNCHER's copy of these rules — Glance decides what to start with it. The
// CLI now needs the same answer for a different job: telling a director which of its stopped streams
// is actually dispatchable and which is waiting on an upstream. Two implementations in two languages
// is not avoidable there (the app is TypeScript, `bsc fleet list` is Rust), so what IS avoidable is
// them drifting into two answers to one question.
//
// So this file and `crates/bsc-fleet/src/gate.rs`'s tests read the SAME fixture. A rule changed on one
// side and not the other fails a gate instead of surfacing months later as "Glance says held, the CLI
// says ready". It is the pattern the tunnel and planner wire contracts already use here.
import { describe, it, expect } from "vitest";
import { partitionByDeps, type GateStream } from "@/shared/lib/fleet/streamGate";
import fixtures from "./streamGate.fixtures.json";

type Case = {
  name: string;
  streams: GateStream[];
  evidence: { doneIssues: string[]; mergedBranches: string[]; sessionDone: string[] };
  expect: {
    ready: string[];
    landed: string[];
    held: { streamId: string; waitingOn: string[]; deadlocked: boolean }[];
  };
};

describe("the dependency gate, against the shared contract", () => {
  for (const c of fixtures.cases as Case[]) {
    it(c.name, () => {
      const got = partitionByDeps(c.streams, {
        doneIssues: new Set(c.evidence.doneIssues),
        mergedBranches: new Set(c.evidence.mergedBranches),
        sessionDone: new Set(c.evidence.sessionDone),
      });
      expect(got.ready.map((s) => s.id)).toEqual(c.expect.ready);
      expect(got.landed.map((s) => s.id)).toEqual(c.expect.landed);
      expect(got.held).toEqual(c.expect.held);
    });
  }

  it("covers every bucket, so a fixture that only ever exercises `ready` cannot pass as a contract", () => {
    const cases = fixtures.cases as Case[];
    expect(cases.some((c) => c.expect.landed.length), "some case lands a stream").toBeTruthy();
    expect(cases.some((c) => c.expect.held.length), "some case holds one").toBeTruthy();
    expect(cases.some((c) => c.expect.held.some((h) => h.deadlocked)), "some case deadlocks").toBeTruthy();
  });
});
