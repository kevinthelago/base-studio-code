import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gateClaudeLaunch, resetLaunchGate, __resetLaunchGateForTest, CLAUDE_LAUNCH_GAP_MS } from "../lib/launchGate";

beforeEach(() => {
  __resetLaunchGateForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("gateClaudeLaunch", () => {
  it("lets the first cold-start through immediately", async () => {
    let done = false;
    gateClaudeLaunch("t0p0", 2000).then(() => { done = true; });
    // One microtask flush — no timers should be needed for the first launch.
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("defaults to no delay between launches (gap removed)", () => {
    expect(CLAUDE_LAUNCH_GAP_MS).toBe(0);
  });

  it("with the default gap, a second launch resolves without any wall-clock wait", async () => {
    vi.useFakeTimers();
    gateClaudeLaunch("t0p0"); // default gap (0) — still serialized via the chain
    let secondDone = false;
    gateClaudeLaunch("t0p1").then(() => { secondDone = true; });

    // No real time passes — only the zero-length timer tick is needed, so the
    // 2s delay is gone while ordering is preserved.
    await vi.advanceTimersByTimeAsync(0);
    expect(secondDone).toBe(true);
  });

  it("queues a second new cold-start behind the gap", async () => {
    vi.useFakeTimers();
    gateClaudeLaunch("t0p0", 2000); // first launch — proceeds now, opens a 2s gap
    let secondDone = false;
    gateClaudeLaunch("t0p1", 2000).then(() => { secondDone = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(secondDone).toBe(false); // still waiting on the gap

    await vi.advanceTimersByTimeAsync(2000);
    expect(secondDone).toBe(true); // gap elapsed → second launch proceeds
  });

  it("staggers each successive launch by an additional gap", async () => {
    vi.useFakeTimers();
    gateClaudeLaunch("a", 2000); // t≈0
    let bDone = false, cDone = false;
    gateClaudeLaunch("b", 2000).then(() => { bDone = true; }); // t≈2000
    gateClaudeLaunch("c", 2000).then(() => { cDone = true; }); // t≈4000

    await vi.advanceTimersByTimeAsync(2000);
    expect(bDone).toBe(true);
    expect(cDone).toBe(false); // c still waits one more gap

    await vi.advanceTimersByTimeAsync(2000);
    expect(cDone).toBe(true);
  });

  it("does not re-gate a key that already launched (tab-switch reconnect)", async () => {
    // First launch of "a" opens a long gap that "b" is now stuck behind.
    gateClaudeLaunch("a", 100000);
    gateClaudeLaunch("b", 100000);

    // "a" remounting (reconnect) must resolve immediately, not wait on "b"'s gap.
    let aReconnected = false;
    gateClaudeLaunch("a", 100000).then(() => { aReconnected = true; });
    await Promise.resolve();
    expect(aReconnected).toBe(true);
  });

  it("re-gates a key after resetLaunchGate (disable → re-enable)", async () => {
    vi.useFakeTimers();
    gateClaudeLaunch("a", 2000);   // launched once — opens a pending 2s gap
    resetLaunchGate("a");          // session killed (console disabled)

    // After reset, re-enabling "a" must go through the gate again: it queues
    // behind the still-pending gap rather than resolving immediately.
    let aDone = false;
    gateClaudeLaunch("a", 2000).then(() => { aDone = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(aDone).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(aDone).toBe(true);
  });
});
