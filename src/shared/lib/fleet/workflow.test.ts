import { describe, it, expect } from "vitest";
import {
  type Workflow, type ItemState, type Outcome,
  startItem, advance, stageCapability, WORKFLOW_PRESETS, DONE, ESCALATE,
} from "./workflow";

const P = WORKFLOW_PRESETS["implement-test-review-integrate"];

/** Run a sequence of outcomes from the start of workflow `p`. */
function run(p: Workflow, outcomes: Outcome[], item = "#1"): ItemState {
  let st = startItem(p, item);
  for (const o of outcomes) st = advance(p, st, o);
  return st;
}

describe("workflow — happy path", () => {
  it("flows implement → build-test → review → integrate → done", () => {
    const st = run(P, ["success", "success", "success", "success"]);
    expect(st.status).toBe("done");
    expect(st.stage).toBeNull();
    expect(st.history.map((h) => h.stage)).toEqual(["implement", "build-test", "review", "integrate"]);
  });

  it("startItem begins at the start stage with attempt 1", () => {
    const st = startItem(P, "#42");
    expect(st).toMatchObject({ item: "#42", stage: "implement", status: "active", attempts: { implement: 1 } });
  });
});

describe("workflow — failure loops are bounded", () => {
  it("build-test ↔ fix loops then escalates after the retry limit", () => {
    // implement✓ → build-test✗→fix✓→build-test✗→fix✓→build-test✗→fix✓→(build-test #4 ⇒ escalate)
    const st = run(P, ["success", "failure", "success", "failure", "success", "failure", "success"]);
    expect(st.status).toBe("escalated");
    expect(st.escalation).toContain("build-test exceeded retryLimit (3)");
    expect(st.attempts["build-test"]).toBe(3); // entered the limit, the 4th was refused
  });

  it("escalates immediately when a stage's onFailure is ESCALATE", () => {
    const st = run(P, ["failure"]); // implement fails → ESCALATE
    expect(st.status).toBe("escalated");
    expect(st.escalation).toBe("implement failure");
  });
});

describe("workflow — review requests changes (loop back)", () => {
  it("review✗ sends it back to implement, then completes", () => {
    // implement✓→build-test✓→review✗→implement(2)✓→build-test✓→review✓→integrate✓→done
    const st = run(P, ["success", "success", "failure", "success", "success", "success", "success"]);
    expect(st.status).toBe("done");
    expect(st.attempts["implement"]).toBe(2);
    expect(st.attempts["review"]).toBe(2);
  });
});

describe("workflow — terminal + robustness", () => {
  it("advancing a finished item is a no-op (idempotent)", () => {
    const done = run(P, ["success", "success", "success", "success"]);
    expect(advance(P, done, "success")).toEqual(done);
    expect(advance(P, done, "failure")).toEqual(done);
  });

  it("escalates on an unknown transition target", () => {
    const bad: Workflow = {
      name: "bad", start: "a",
      stages: { a: { name: "a", role: "worker", onSuccess: "ghost", onFailure: ESCALATE, retryLimit: 1 } },
    };
    const st = advance(bad, startItem(bad, "#1"), "success");
    expect(st.status).toBe("escalated");
    expect(st.escalation).toContain("unknown target 'ghost'");
  });

  it("every preset starts at a defined stage and only targets known stages / terminals", () => {
    for (const p of Object.values(WORKFLOW_PRESETS)) {
      expect(p.stages[p.start]).toBeDefined();
      for (const s of Object.values(p.stages)) {
        for (const t of [s.onSuccess, s.onFailure]) {
          expect(t === DONE || t === ESCALATE || p.stages[t] !== undefined).toBe(true);
        }
      }
    }
  });
});

describe("workflow — stage capabilities (composes with #219)", () => {
  const stages = WORKFLOW_PRESETS["implement-test-review-integrate"].stages;

  it("maps each stage to its role-scoped capability", () => {
    expect(stageCapability(stages.implement).code).toBe("write");    // worker edits
    expect(stageCapability(stages["build-test"]).code).toBe("none");  // tester can't edit
    expect(stageCapability(stages["build-test"]).git).toBe("read");
    expect(stageCapability(stages.review).code).toBe("none");         // reviewer can't edit
    expect(stageCapability(stages.integrate).github).toBe("write");   // director merges
    expect(stageCapability(stages.integrate).code).toBe("none");      // ...but writes no code
  });

  it("the read-only stage roles can neither write code nor push/merge", () => {
    for (const name of ["build-test", "review"] as const) {
      const cap = stageCapability(stages[name]);
      expect(cap.code).toBe("none");
      expect(cap.git).not.toBe("write");
    }
  });
});
