// THE SEAM: StudioSessionMount → TerminalHost → TerminalSlot → TerminalView → pty_create.
//
// A studio woken to serve an ask has to reach claude WITH the request. `studioLaunchErrand.test.ts`
// asserts the errand lands in the store — and that is exactly the kind of test this repo keeps getting
// caught by, because it stops one hop short of the thing that was broken.
//
// MEASURED ON THE RUNNING APP, 2026-08-28: a cold-start `bsc session ask designerReact` reported "the
// session was started with your request in its launch prompt" while the process it started was
// `claude --model sonnet --continue` — three argv entries, no prompt. The errand reached the store and
// the launch never saw it. `TerminalView` reads `paneStartupPromptText` ONCE inside a one-shot launch
// effect; `seedStudioLaunchState` writes it from an ASYNC effect that has already awaited
// `setupCommand`. When the read wins, the errand is dropped in silence — and a session with no prompt
// is indistinguishable from one that has finished.
//
// The sibling feature learned this first (`src/features/debug/requestSessionLaunch.test.tsx`, and
// `SlotTerminalProps.startupPrompt`'s own doc: "58 of 58 debug launches carried the props and none
// carried the prompt"). The fix there and here is the same — hand the prompt to the launch as a PROP —
// and so is the guard: assert on the argument `pty_create` actually received.
//
// So this file mocks only what jsdom cannot run (xterm) and the Tauri bridge. The mount, the host, the
// slot and the view are all real.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { StudioSessionMount } from "@/features/studio-sessions/StudioSessionMount";
import { STUDIO_SESSIONS } from "@/features/studio-sessions/lib/studioSessions";
import { useAppStore } from "@/store";
import { invoke } from "@tauri-apps/api/core";

const DEF = STUDIO_SESSIONS.designerReact;
const ERRAND =
  "You were started to serve a request on loop 42.\nRun `bsc loop watch 42 --as designerReact` to read it.";

// xterm cannot initialize in jsdom (`open()` needs real measurements).
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80; rows = 24; options = {}; parser = { registerOscHandler: vi.fn() };
    loadAddon = vi.fn(); open = vi.fn(); write = vi.fn(); scrollToBottom = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() })); focus = vi.fn(); dispose = vi.fn();
    attachCustomKeyEventHandler = vi.fn(); getSelection = vi.fn(() => ""); refresh = vi.fn();
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (cmd: string, payload?: unknown) => {
    // The workspace setup the mount awaits BEFORE it seeds anything — the await that creates the race.
    if (cmd === DEF.setupCommand) return { [DEF.dirKey]: "/studio/design/react" };
    if (cmd === "pty_pane_runtime") {
      const ids = (payload as { paneIds?: string[] } | undefined)?.paneIds ?? [];
      return ids.map((paneId) => ({ paneId, live: false }));
    }
    if (cmd === "pty_create") return true;
    return "";
  });
  useAppStore.setState({ paneStartupPromptText: {}, studioPendingDirective: {}, paneContinue: {} });
});
afterEach(cleanup);

/** The `pty_create` payload, or undefined if the launch never happened. */
const launch = () => {
  const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "pty_create");
  return call?.[1] as
    | { startupPrompt?: string; initCmd?: string; cwd?: string; continueSession?: boolean; startupPromptFreshOnly?: boolean; restoreRequested?: boolean; startupPromptIsErrand?: boolean; paneInitCmd?: string; paneWasClaude?: boolean; autoResumeClaude?: boolean; providerIsClaude?: boolean; roleCapability?: { role?: string; git?: string; github?: string } | null; streamId?: string; env?: Record<string, string> }
    | undefined;
};

describe("a studio woken to serve an ask", () => {
  it("bakes the errand into pty_create, not just into the store", async () => {
    useAppStore.getState().setStudioPendingDirective(DEF.id, ERRAND);
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);

    await waitFor(() => {
      const p = launch();
      expect(p, "pty_create was never called — no session launched at all").toBeTruthy();
      // THE ASSERTION THAT WOULD HAVE CAUGHT IT. The store-level test passed while this was empty.
      expect(p!.startupPrompt, "launched with NO errand — the session has nothing to do").toBeTruthy();
      expect(p!.startupPrompt).toContain("loop 42");
      expect(p!.startupPrompt).toContain("bsc loop watch 42 --as designerReact");
    });
  });

  it("does not let the backend suppress the errand on a studio that has history", async () => {
    // The second half of the same bug in the debug session: the charter reached `pty_create` and the
    // BACKEND dropped it, because `fresh_only && has_history` suppresses a startup prompt and every
    // one of those panes had history. A studio ALWAYS has history — its pane id is stable so it
    // resumes — so a fresh-only errand would be suppressed on every launch that matters.
    //
    // The frontend no longer sends that answer (`the-launch-derives-its-own-fresh-only-instead-of-
    // receiving-it`): it sends `startupPromptIsErrand`, and the backend's carve-out is what keeps the
    // errand. THIS ASSERTION USED TO READ `p!.startupPromptFreshOnly ?? false`, and that `?? false`
    // is why it has to change here rather than simply passing: with the key gone it would have kept
    // passing while checking nothing at all — the vacuous-green shape this repo keeps getting caught
    // by. A studio IS in the registry, so without the errand fact the backend derives fresh-only TRUE
    // and drops the errand; this is the one payload field standing between the two.
    useAppStore.getState().setStudioPendingDirective(DEF.id, ERRAND);
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);

    await waitFor(() => {
      const p = launch();
      expect(p?.startupPrompt).toBeTruthy();
      expect(
        p!.startupPromptIsErrand,
        "a studio always has a prior conversation, so only the errand fact keeps its errand alive",
      ).toBe(true);
      expect(
        p!.startupPromptFreshOnly,
        "the computed flag must not come back — the backend derives it now",
      ).toBeUndefined();
    });
  });

  /// THE PAYLOAD, for the init command this time
  /// (`the-launch-resolves-its-own-resume-command-instead-of-receiving-it`). The backend resolves
  /// `initCmd` alongside the renderer and logs a disagreement; it can only do that if the RAW signals
  /// reach it, and nothing else in the suite would notice if they stopped.
  ///
  /// This is the same gap that made the role-gate flip inert for months
  /// (`the-role-gate-flip-never-reached-the-wire`): a backend argument that is accepted and never
  /// sent takes the `None` branch on every real launch, and every test on that flip passed because
  /// each one called the Tauri command directly with the argument the wire never carried.
  it("sends the raw resume signals so the backend can resolve the init command itself", async () => {
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);
    await waitFor(() => {
      const p = launch();
      expect(p, "pty_create was never called").toBeTruthy();
      // The pane's OWN command, before the resolver turned it into a resume form — the `explicit` the
      // backend's rule reads. Sending the RESOLVED one instead would compare a value against itself.
      expect(p!.paneInitCmd, "the raw pane command must be sent, not the resolved one").not.toBeUndefined();
      expect(typeof p!.paneWasClaude).toBe("boolean");
      expect(typeof p!.autoResumeClaude).toBe("boolean");
      // Which branch `resolveEffectiveInitCmd` took. Without it the backend compares against the
      // branch it does not model and warns on every non-Claude launch.
      expect(p!.providerIsClaude, "a studio runs claude").toBe(true);
      // `wasUncleanShutdown` is deliberately NOT here — the backend owns it (`app::recovery`), and
      // the store field is a copy read back from it. Sending it would route a Rust fact through the
      // renderer and back.
      expect(p, "wasUncleanShutdown must not be sent").not.toHaveProperty("wasUncleanShutdown");
    });
  });

  /// THE ACCESS ENV IS GATED BY THE BACKEND, so it has to be told the role
  /// (`the-launch-derives-its-own-access-env-instead-of-receiving-it`).
  ///
  /// A studio is the case the credential gate exists for: `none` on every axis, so it cannot run git
  /// or gh at all and a GitHub credential in its environment widens nothing and risks everything.
  /// The renderer already withholds it; the backend's removal is the SECOND, independent refusal, and
  /// it can only run if `roleCapability` arrives.
  it("sends the role capability so the backend can gate the access env", async () => {
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);
    await waitFor(() => {
      const p = launch();
      expect(p, "pty_create was never called").toBeTruthy();
      expect(p!.roleCapability, "the backend cannot gate a credential without the role").toBeTruthy();
      expect(p!.roleCapability?.git).toBe("none");
      expect(p!.roleCapability?.github).toBe("none");
      // The renderer's own half of the AND: it never placed one to begin with.
      expect(p!.env?.GH_TOKEN, "a studio is denied on both axes").toBeUndefined();
      // The token is NOT sent as a separate argument. The backend reads it out of `env`, which is
      // what makes its pass remove-only — it cannot place a credential the renderer withheld.
      expect(p, "the token must not travel a second time").not.toHaveProperty("ghToken");
    });
  });

  it("launches with no errand when none is pending, and does not invent one", async () => {
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);
    await waitFor(() => expect(launch(), "the studio still launches").toBeTruthy());
    // An ordinary open is not a request. A prompt here would re-greet the session on every launch —
    // the behaviour that got startup prompts removed from this channel in the first place.
    expect(launch()!.startupPrompt).toBeFalsy();
  });
});
