// The worker auto-end decision, captured from the LIVE TypeScript so the Rust port can be proved equal.
//
// Same class as the idle reaper, which was moved out of a React hook into `console::pty::reap`
// because a dead webview meant nothing bounded the session count. This is an idle-time decision
// still in the renderer: it stops happening when the renderer dies, silently, exactly when a fleet
// is left running unattended.
//
// Regenerate deliberately:
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/fleet/workerAutoEnd.fixtures.gen.test.ts
//
// A regeneration that changes the file is a CHANGE OF BEHAVIOUR. Read the diff before committing it.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  decideWorkerAutoEnd,
  DEFAULT_AUTO_END_THRESHOLDS,
  type AutoEndSignals,
  type AutoEndThresholds,
} from "@/shared/lib/fleet/workerAutoEnd";

const FIXTURE = join(process.cwd(), "src/shared/lib/fleet/workerAutoEnd.fixtures.json");
const T: AutoEndThresholds = DEFAULT_AUTO_END_THRESHOLDS;

/** The verdict enters as a VALUE — `worker-end.ts`'s classifier is out of scope (coordination). */
const verdict = (state: "done" | "needs-attention" | "blocked") => ({ state, summary: `${state} summary` });

const sig = (o: Partial<AutoEndSignals>): AutoEndSignals => ({
  turnOpen: false,
  idleMs: 0,
  hasOutstandingQuestion: false,
  verdict: verdict("done"),
  ...o,
});

interface Case { name: string; signals: AutoEndSignals; thresholds: AutoEndThresholds }

/** Each case names the branch it pins. Both sides of every threshold, and every verdict state. */
const CASES: Case[] = [
  { name: "turn still open — never act, however idle", signals: sig({ turnOpen: true, idleMs: 10_000_000 }), thresholds: T },
  { name: "focused — never act, however idle", signals: sig({ focused: true, idleMs: 10_000_000 }), thresholds: T },
  { name: "focused outranks an outstanding question", signals: sig({ focused: true, hasOutstandingQuestion: true, idleMs: 10_000_000 }), thresholds: T },
  { name: "turnOpen outranks focused being false", signals: sig({ turnOpen: true, focused: false, hasOutstandingQuestion: true, idleMs: 10_000_000 }), thresholds: T },
  { name: "question, just under lostQuestionMs", signals: sig({ hasOutstandingQuestion: true, idleMs: T.lostQuestionMs - 1 }), thresholds: T },
  { name: "question, exactly at lostQuestionMs — resurface", signals: sig({ hasOutstandingQuestion: true, idleMs: T.lostQuestionMs }), thresholds: T },
  { name: "question, well past — resurface", signals: sig({ hasOutstandingQuestion: true, idleMs: T.lostQuestionMs * 3 }), thresholds: T },
  { name: "a question outranks a done verdict past closeNudgeMs", signals: sig({ hasOutstandingQuestion: true, idleMs: T.closeNudgeMs, verdict: verdict("done") }), thresholds: T },
  { name: "done, just under closeNudgeMs", signals: sig({ idleMs: T.closeNudgeMs - 1 }), thresholds: T },
  { name: "done, exactly at closeNudgeMs — nudge", signals: sig({ idleMs: T.closeNudgeMs }), thresholds: T },
  { name: "needs-attention past closeNudgeMs — no nudge", signals: sig({ idleMs: T.closeNudgeMs * 2, verdict: verdict("needs-attention") }), thresholds: T },
  { name: "blocked past closeNudgeMs — no nudge", signals: sig({ idleMs: T.closeNudgeMs * 2, verdict: verdict("blocked") }), thresholds: T },
  { name: "idle zero, done — nothing yet", signals: sig({ idleMs: 0 }), thresholds: T },
  { name: "custom thresholds are honoured, not the packaged ones", signals: sig({ idleMs: 5 }), thresholds: { closeNudgeMs: 5, lostQuestionMs: 10 } },
];

function build() {
  return {
    note: "GENERATED from the live TypeScript — see workerAutoEnd.fixtures.gen.test.ts",
    defaults: DEFAULT_AUTO_END_THRESHOLDS,
    cases: CASES.map((c) => ({ ...c, action: decideWorkerAutoEnd(c.signals, c.thresholds) })),
  };
}

describe("the worker auto-end decision is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const text = JSON.stringify(build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("reaches every action, so a port cannot pass by always returning none", () => {
    const seen = new Set(build().cases.map((c) => c.action));
    expect(seen).toEqual(new Set(["none", "close-nudge", "resurface-question"]));
  });
});
