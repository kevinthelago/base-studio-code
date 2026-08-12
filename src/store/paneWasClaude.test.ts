import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import { resolveInitCmd } from "@/app/console/lib/resumeClaude";

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

  it("autoResumeClaude defaults to FALSE — the app never resumes a session on its own", () => {
    // #restart-does-not-resume-sessions. It used to default TRUE, so after any unclean shutdown (a kill
    // or force-quit — the normal case in development) every pane that had run Claude relaunched itself
    // with no click. The same flag also hid the crash banner, so the app started the sessions AND hid
    // the control for starting them. The mechanism is intact and the toggle still turns it back on;
    // only the default moved. Assert on a FRESH store, not the beforeEach state.
    useAppStore.setState({ autoResumeClaude: useAppStore.getInitialState().autoResumeClaude });
    expect(useAppStore.getState().autoResumeClaude).toBe(false);
  });

  it("setAutoResumeClaude flips the toggle", () => {
    useAppStore.getState().setAutoResumeClaude(false);
    expect(useAppStore.getState().autoResumeClaude).toBe(false);
    useAppStore.getState().setAutoResumeClaude(true);
    expect(useAppStore.getState().autoResumeClaude).toBe(true);
  });
});

/**
 * The composition that actually matters (#restart-does-not-resume-sessions): the store's DEFAULT,
 * fed through the real decision function, must produce no resume after an unclean shutdown.
 *
 * The two halves are pinned separately above and in resumeClaude.test.ts, but neither alone catches
 * the regression that reintroduces this bug — flipping the default back to `true`. That change keeps
 * every other test green, because they all pass the flag in explicitly.
 */
describe("the default posture resumes nothing (#restart-does-not-resume-sessions)", () => {
  it("a crashed pane that had claude does NOT auto-resume under the shipped default", () => {
    const autoResumeClaude = useAppStore.getInitialState().autoResumeClaude;
    expect(resolveInitCmd({
      explicit: undefined,
      startupPrompt: undefined,
      continueSession: false,
      paneWasClaude: true,
      autoResumeClaude,
      wasUncleanShutdown: true,
      restoreRequested: false,
    })).toBe("");
  });

  it("...and the SAME pane resumes the moment the user clicks Restore", () => {
    expect(resolveInitCmd({
      explicit: undefined,
      startupPrompt: undefined,
      continueSession: false,
      paneWasClaude: true,
      autoResumeClaude: useAppStore.getInitialState().autoResumeClaude,
      wasUncleanShutdown: true,
      restoreRequested: true,
    })).not.toBe("");
  });
});
