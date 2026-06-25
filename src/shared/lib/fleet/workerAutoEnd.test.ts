import { describe, it, expect } from "vitest";
import { decideWorkerAutoEnd, DEFAULT_AUTO_END_THRESHOLDS, type AutoEndSignals } from "./workerAutoEnd";
import type { WorkerEndVerdict } from "./workerEnd";

const T = DEFAULT_AUTO_END_THRESHOLDS;
const done: WorkerEndVerdict = { state: "done", summary: "2/2 complete" };
const needsAttn: WorkerEndVerdict = { state: "needs-attention", summary: "1/2 still open" };
const blocked: WorkerEndVerdict = { state: "blocked", summary: "1/2 blocked" };

const sig = (o: Partial<AutoEndSignals>): AutoEndSignals => ({
  turnOpen: false, idleMs: 0, hasOutstandingQuestion: false, verdict: done, ...o,
});

describe("decideWorkerAutoEnd", () => {
  it("never acts while the turn is open (working, even if silent)", () => {
    expect(decideWorkerAutoEnd(sig({ turnOpen: true, idleMs: 10 * T.lostQuestionMs }), T)).toBe("none");
  });

  describe("no outstanding question → close-nudge when complete", () => {
    it("nudges a complete worker to close once idle past the (shorter) close window", () => {
      expect(decideWorkerAutoEnd(sig({ idleMs: T.closeNudgeMs, verdict: done }), T)).toBe("close-nudge");
    });
    it("waits until the close window elapses", () => {
      expect(decideWorkerAutoEnd(sig({ idleMs: T.closeNudgeMs - 1, verdict: done }), T)).toBe("none");
    });
    it("does NOT nudge a worker that stopped early (needs-attention) or is blocked", () => {
      expect(decideWorkerAutoEnd(sig({ idleMs: T.closeNudgeMs, verdict: needsAttn }), T)).toBe("none");
      expect(decideWorkerAutoEnd(sig({ idleMs: 10 * T.closeNudgeMs, verdict: blocked }), T)).toBe("none");
    });
  });

  describe("outstanding question → resurface only after the (longer) lost-question wait", () => {
    it("resurfaces once idle past the lost-question window", () => {
      expect(decideWorkerAutoEnd(sig({ hasOutstandingQuestion: true, idleMs: T.lostQuestionMs }), T))
        .toBe("resurface-question");
    });
    it("does nothing while the director still has time to answer", () => {
      expect(decideWorkerAutoEnd(sig({ hasOutstandingQuestion: true, idleMs: T.lostQuestionMs - 1 }), T))
        .toBe("none");
    });
    it("never closes a worker that's waiting, even if its issues read complete", () => {
      // Past the SHORTER close window but with a question outstanding → resurface path only, never close.
      expect(decideWorkerAutoEnd(sig({ hasOutstandingQuestion: true, idleMs: T.closeNudgeMs, verdict: done }), T))
        .toBe("none");
    });
  });

  it("uses a longer wait for lost questions than for the close-nudge", () => {
    expect(T.lostQuestionMs).toBeGreaterThan(T.closeNudgeMs);
  });
});
