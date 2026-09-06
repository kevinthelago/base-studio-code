// The worker-end verdict, captured from the LIVE TypeScript so the Rust port can be proved equal.
//
// Both inputs are already Rust's: `crates/plandb` owns the issue statuses and `crates/logs` owns the
// coordination state the landed tiebreaker reads. Only the verdict ran here.
//
// AND THERE IS A SECOND DEFINITION OF DONE-NESS ACROSS THE BOUNDARY. `plandb/issues.rs` declares
// `DONE_STATUSES` and says "the Rust half of the frontend's TERMINAL_GOOD. Both must name the same
// set" — and nothing compares them. This fixture EXPORTS the TypeScript set so the Rust side can.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/fleet/workerEnd.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { classifyWorkerEnd, TERMINAL_GOOD } from "@/shared/lib/fleet/workerEnd";
import type { OwnedIssue } from "@/shared/lib/fleet/workerEnd";
import type { CoordState } from "@/shared/lib/fleet/coordination.types";

const FIXTURE = join(process.cwd(), "src/shared/lib/fleet/workerEnd.fixtures.json");

const i = (ref: string, status: string): OwnedIssue => ({ ref, status });

/** A CoordState whose latches mark the given refs satisfied — the `landed` tiebreaker's input. */
const coord = (landed: string[] = []): CoordState =>
  ({
    waiters: [], latches: Object.fromEntries(landed.map((r) => [r, { state: "satisfied", source: "merged", at: 1 }])),
    waiting: [], asking: [], issues: [], maintaining: [], briefs: [], forks: [], commissions: [], requests: [],
  }) as unknown as CoordState;

type Case = { label: string; issues: OwnedIssue[]; landed?: string[] };

const SUBJECTS: Case[] = [
  // The empty set — completion cannot be CONFIRMED, so it is not claimed.
  { label: "no owned issues — cannot confirm completion", issues: [] },

  // done
  { label: "all complete", issues: [i("#1", "complete"), i("#2", "complete")] },
  { label: "all verified", issues: [i("#1", "verified")] },
  { label: "a mix of complete and verified", issues: [i("#1", "complete"), i("#2", "verified")] },

  // needs-attention — stopped early
  { label: "one still open — stopped early, NEVER silently done", issues: [i("#1", "complete"), i("#2", "open")] },
  { label: "one in_progress", issues: [i("#1", "verified"), i("#2", "in_progress")] },
  { label: "everything still open", issues: [i("#1", "open"), i("#2", "open")] },

  // blocked wins over everything
  { label: "one blocked — outranks the open ones", issues: [i("#1", "blocked"), i("#2", "open")] },
  { label: "one failed — outranks the complete ones", issues: [i("#1", "failed"), i("#2", "complete")] },
  { label: "blocked AND failed", issues: [i("#1", "blocked"), i("#2", "failed"), i("#3", "complete")] },

  // An UNKNOWN status must never inflate a completion.
  { label: "an UNKNOWN status counts as not-done", issues: [i("#1", "complete"), i("#2", "wat")] },
  { label: "only unknown statuses", issues: [i("#1", "wat")] },

  // The landed tiebreaker is REPORTED, never decisive.
  { label: "all complete, none landed — still done", issues: [i("#1", "complete"), i("#2", "complete")] },
  { label: "all complete, one landed", issues: [i("#1", "complete"), i("#2", "complete")], landed: ["#1"] },
  { label: "all complete, all landed", issues: [i("#1", "complete"), i("#2", "complete")], landed: ["#1", "#2"] },
  { label: "landed cannot rescue a blocked worker", issues: [i("#1", "blocked")], landed: ["#1"] },
  { label: "an unparseable ref never counts as landed", issues: [i("", "complete")], landed: [""] },
];

describe("workerEnd fixtures", () => {
  it("captures the verdict over every status mix", () => {
    const next = {
      note: "GENERATED from @/shared/lib/fleet/workerEnd — do not hand-edit; see the .gen.test.ts",
      // EXPORTED so the Rust side can compare it against plandb's DONE_STATUSES. That agreement is
      // currently prose on both sides with nothing checking it.
      terminalGood: [...TERMINAL_GOOD].sort(),
      cases: SUBJECTS.map((c) => ({
        label: c.label,
        issues: c.issues,
        landed: c.landed ?? [],
        verdict: classifyWorkerEnd(c.issues, coord(c.landed)),
      })),
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("a still-open issue is NEVER silently done", () => {
    expect(classifyWorkerEnd([i("#1", "complete"), i("#2", "open")], coord()).state).toBe("needs-attention");
  });

  it("blocked outranks everything, including a full set of completes", () => {
    expect(classifyWorkerEnd([i("#1", "failed"), i("#2", "complete")], coord()).state).toBe("blocked");
  });

  it("an UNKNOWN status counts as not-done — a typo must never inflate a completion", () => {
    expect(classifyWorkerEnd([i("#1", "wat")], coord()).state).toBe("needs-attention");
  });

  it("landed is REPORTED, not decisive — that is what keeps 'complete but never merged' visible", () => {
    const none = classifyWorkerEnd([i("#1", "complete")], coord());
    const all = classifyWorkerEnd([i("#1", "complete")], coord(["#1"]));
    expect(none.state).toBe("done");
    expect(all.state).toBe("done");
    expect(none.summary, "the counts differ even though the verdict does not").not.toEqual(all.summary);
  });
});
