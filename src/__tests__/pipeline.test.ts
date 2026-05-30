import { describe, it, expect } from "vitest";
import {
  type Pipeline, type ItemState, type Outcome,
  startItem, advance, PIPELINE_PRESETS, DONE, ESCALATE,
} from "../lib/pipeline";

const P = PIPELINE_PRESETS["implement-test-review-integrate"];

/** Run a sequence of outcomes from the start of pipeline `p`. */
function run(p: Pipeline, outcomes: Outcome[], item = "#1"): ItemState {
  let st = startItem(p, item);
  for (const o of outcomes) st = advance(p, st, o);
  return st;
}

describe("pipeline — happy path", () => {
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

describe("pipeline — failure loops are bounded", () => {
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

describe("pipeline — review requests changes (loop back)", () => {
  it("review✗ sends it back to implement, then completes", () => {
    // implement✓→build-test✓→review✗→implement(2)✓→build-test✓→review✓→integrate✓→done
    const st = run(P, ["success", "success", "failure", "success", "success", "success", "success"]);
    expect(st.status).toBe("done");
    expect(st.attempts["implement"]).toBe(2);
    expect(st.attempts["review"]).toBe(2);
  });
});

describe("pipeline — terminal + robustness", () => {
  it("advancing a finished item is a no-op (idempotent)", () => {
    const done = run(P, ["success", "success", "success", "success"]);
    expect(advance(P, done, "success")).toEqual(done);
    expect(advance(P, done, "failure")).toEqual(done);
  });

  it("escalates on an unknown transition target", () => {
    const bad: Pipeline = {
      name: "bad", start: "a",
      stages: { a: { name: "a", role: "worker", onSuccess: "ghost", onFailure: ESCALATE, retryLimit: 1 } },
    };
    const st = advance(bad, startItem(bad, "#1"), "success");
    expect(st.status).toBe("escalated");
    expect(st.escalation).toContain("unknown target 'ghost'");
  });

  it("every preset starts at a defined stage and only targets known stages / terminals", () => {
    for (const p of Object.values(PIPELINE_PRESETS)) {
      expect(p.stages[p.start]).toBeDefined();
      for (const s of Object.values(p.stages)) {
        for (const t of [s.onSuccess, s.onFailure]) {
          expect(t === DONE || t === ESCALATE || p.stages[t] !== undefined).toBe(true);
        }
      }
    }
  });
});
