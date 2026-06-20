import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";

/**
 * #36: paneWasClaude + autoResumeClaude carry the "claude was running here"
 * signal across app restarts. Persistence itself is handled by zustand's
 * persist middleware — what we pin here is the in-memory contract that
 * TerminalView writes to and resolveInitCmd reads from.
 */
describe("paneWasClaude / autoResumeClaude (#36)", () => {
  beforeEach(() => {
    useAppStore.setState({ paneWasClaude: {}, autoResumeClaude: true });
  });

  it("setPaneWasClaude(pid, true) records the pane as having used claude", () => {
    useAppStore.getState().setPaneWasClaude("t0p0", true);
    expect(useAppStore.getState().paneWasClaude["t0p0"]).toBe(true);
  });

  it("setPaneWasClaude(pid, false) clears it (so an opt-out / unset case is representable)", () => {
    useAppStore.setState({ paneWasClaude: { t0p0: true, t1p2: true } });
    useAppStore.getState().setPaneWasClaude("t0p0", false);
    const state = useAppStore.getState().paneWasClaude;
    expect(state["t0p0"]).toBeUndefined();
    expect(state["t1p2"]).toBe(true);
  });

  it("setPaneWasClaude is a no-op when the flag already matches (avoids store churn on repeated OSC 100 'run')", () => {
    useAppStore.setState({ paneWasClaude: { t0p0: true } });
    const before = useAppStore.getState().paneWasClaude;
    useAppStore.getState().setPaneWasClaude("t0p0", true);
    const after = useAppStore.getState().paneWasClaude;
    // Same object reference — selectors subscribed to paneWasClaude don't re-fire.
    expect(after).toBe(before);
  });

  it("autoResumeClaude defaults to true (the resume IS the desired behavior; toggle is opt-out)", () => {
    expect(useAppStore.getState().autoResumeClaude).toBe(true);
  });

  it("setAutoResumeClaude flips the toggle", () => {
    useAppStore.getState().setAutoResumeClaude(false);
    expect(useAppStore.getState().autoResumeClaude).toBe(false);
    useAppStore.getState().setAutoResumeClaude(true);
    expect(useAppStore.getState().autoResumeClaude).toBe(true);
  });
});
