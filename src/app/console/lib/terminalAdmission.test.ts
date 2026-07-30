import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  admitTerminal, pendingAdmissions, resetAdmissionsForTest, setAdmissionScheduler, PER_FRAME,
} from "./terminalAdmission";

/** Drive frames by hand so the tests are deterministic (jsdom's rAF is timer-backed). */
let frames: Array<() => void> = [];
let restore: (cb: () => void) => void;

const runFrame = async () => {
  const due = frames;
  frames = [];
  for (const f of due) f();
  await Promise.resolve();   // let the resolved promises' .then callbacks run
};

beforeEach(() => {
  resetAdmissionsForTest();
  frames = [];
  restore = setAdmissionScheduler((cb) => { frames.push(cb); });
});
afterEach(() => { setAdmissionScheduler(restore); resetAdmissionsForTest(); });

describe("terminalAdmission (#3975)", () => {
  it("admits at most PER_FRAME terminals per frame", async () => {
    // The bug: 29 panes ran `term.open()` in ONE frame — a 6s main-thread stall with only one React
    // render in the same window, so the cost is entirely outside React.
    const opened: number[] = [];
    for (let i = 0; i < 6; i++) void admitTerminal().then(() => opened.push(i));
    expect(opened).toHaveLength(0);            // nothing opens synchronously

    await runFrame();
    expect(opened).toHaveLength(PER_FRAME);
    await runFrame();
    expect(opened).toHaveLength(PER_FRAME * 2);
  });

  it("drains every waiter — a queued pane is never stranded", async () => {
    const opened: number[] = [];
    const n = 29;                                        // the measured fleet size
    for (let i = 0; i < n; i++) void admitTerminal().then(() => opened.push(i));
    for (let f = 0; f < 40 && opened.length < n; f++) await runFrame();
    expect(opened).toHaveLength(n);
    expect(pendingAdmissions()).toBe(0);
  });

  it("admits in FIFO order, so panes come up in mount order", async () => {
    const opened: number[] = [];
    for (let i = 0; i < 5; i++) void admitTerminal().then(() => opened.push(i));
    for (let f = 0; f < 5; f++) await runFrame();
    expect(opened).toEqual([0, 1, 2, 3, 4]);
  });

  it("a single pane waits exactly one frame", async () => {
    // No "first N are immediate" fast path: that needs a counter which must then decay, and a stale
    // counter would silently un-stagger the next burst. One frame is imperceptible.
    let opened = false;
    void admitTerminal().then(() => { opened = true; });
    await runFrame();
    expect(opened).toBe(true);
  });

  it("a consumer whose callback throws does not strand the rest of the queue", async () => {
    // One pane's effect failing must not freeze every later pane. The rejection belongs to that
    // consumer's own chain (caught here so it isn't an unhandled rejection), never to the pump.
    const opened: string[] = [];
    void admitTerminal().then(() => { opened.push("first"); throw new Error("boom"); }).catch(() => {});
    void admitTerminal().then(() => { opened.push("second"); });
    void admitTerminal().then(() => { opened.push("third"); });
    for (let f = 0; f < 4; f++) await runFrame();
    expect(opened).toEqual(["first", "second", "third"]);
  });

  it("re-arms for a later burst after the queue drains", async () => {
    // A second tab opening later must be staggered too — the pump must not stay stopped.
    let a = false; void admitTerminal().then(() => { a = true; });
    await runFrame();
    expect(a).toBe(true);
    expect(pendingAdmissions()).toBe(0);

    let b = false; void admitTerminal().then(() => { b = true; });
    await runFrame();
    expect(b).toBe(true);
  });

  it("stops scheduling frames once idle", async () => {
    void admitTerminal();
    await runFrame();
    frames = [];
    await runFrame();                 // nothing should have re-armed
    expect(frames).toHaveLength(0);
  });
});
