// THE SEAM: StudioSessionMount → TerminalHost → TerminalSlot → TerminalView → pty_create.
//
// A studio woken to serve an ask has to reach its agent WITH the request. That used to be proved here on the
// `pty_create` payload, because the renderer carried the errand from the store to the launch — and lost it
// in silence when a one-shot read beat an async seed. MEASURED ON THE RUNNING APP, 2026-08-28: a cold-start
// `bsc session ask designerReact` reported "the session was started with your request in its launch prompt"
// while the process it started was `claude --model sonnet --continue`, with no prompt at all.
//
// THE LAUNCH IS RESOLVED IN RUST NOW (`frontend-state-2-pty-create-takes-a-pane-id`). `session::system::apply`
// queues the ask as the pane's errand and `pty_create` takes it when the pane really launches, so the errand
// never crosses the renderer and the race this file guarded has nowhere left to happen. The delivery is owned
// by the Rust tests (`session::pane_launch`, and `launch_plan::tests::an_errand_is_never_suppressed_on_a_studio_with_history`).
//
// What stays true at THIS seam is the other half, and it is what this file pins: the view hands `pty_create`
// ONLY what it alone holds. A derived value coming back onto this payload is a second copy of a rule the
// backend owns — the shape that let the renderer's copy and the launch's copy disagree for months.
//
// Only what jsdom cannot run (xterm) and the Tauri bridge are mocked. The mount, the host, the slot and the
// view are all real.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { StudioSessionMount } from "@/features/studio-sessions/StudioSessionMount";
import { studioSessionDef } from "@/features/studio-sessions/lib/studioSessions";
import { useAppStore } from "@/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const DEF = studioSessionDef("designerReact")!;
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
  vi.mocked(listen).mockClear();
  vi.mocked(invoke).mockImplementation(async (cmd: string, payload?: unknown) => {
    // The workspace setup the mount awaits BEFORE it seeds anything.
    if (cmd === DEF.setupCommand) return { [DEF.dirKey]: "/studio/design/react" };
    if (cmd === "pty_pane_runtime") {
      const ids = (payload as { paneIds?: string[] } | undefined)?.paneIds ?? [];
      return ids.map((paneId) => ({ paneId, live: false }));
    }
    if (cmd === "pty_create") return { isNew: true, launchesAgent: true };
    return "";
  });
  useAppStore.setState({ paneStartupPromptText: {}, studioPendingDirective: {}, paneContinue: {} });
});
afterEach(cleanup);

/** The `pty_create` payload, or undefined if the launch never happened. */
const launchCall = () => vi.mocked(invoke).mock.calls.findIndex((c) => c[0] === "pty_create");
const launch = () => {
  const i = launchCall();
  return i < 0 ? undefined : (vi.mocked(invoke).mock.calls[i][1] as Record<string, unknown>);
};

/** Every value the launch DERIVES from the pane id and the stores. None of them may ride this payload. */
const DERIVED = [
  "cwd", "initCmd", "startupPrompt", "startupPromptIsErrand", "continueSession", "checkpointDoc",
  "paneInitCmd", "paneWasClaude", "autoResumeClaude", "providerIsClaude", "providerId", "model",
  "env", "roleCapability", "streamId", "flowPush", "userDeniedCommands", "mcpLibrary", "personaMcpIds",
  "namespaceHooks", "sandboxRole",
];

describe("a studio's launch", () => {
  it("hands pty_create only its pane id, its size and the restore fact", async () => {
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);
    await waitFor(() => expect(launch(), "pty_create was never called — no session launched at all").toBeTruthy());
    const p = launch()!;
    expect(p.paneId).toBe(DEF.paneId);
    expect(typeof p.cols).toBe("number");
    expect(typeof p.rows).toBe("number");
    expect(p.restoreRequested, "an ordinary open is not the crash-restore relaunch").toBe(false);
    for (const key of DERIVED) {
      expect(p, `\`${key}\` is resolved by the launch from the stores — sending it is a second copy`).not.toHaveProperty(key);
    }
  });

  it("does not carry a pending errand — the backend queued it where the launch takes it", async () => {
    useAppStore.getState().setStudioPendingDirective(DEF.id, ERRAND);
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);
    await waitFor(() => expect(launch(), "the studio still launches").toBeTruthy());
    expect(JSON.stringify(launch()), "the request text must not travel through the renderer").not.toContain("loop 42");
  });

  it("sends no credential: the launch reads it from the saved state itself", async () => {
    useAppStore.setState({ githubToken: "ghp_seam_test_value_never_sent" } as never);
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);
    await waitFor(() => expect(launch()).toBeTruthy());
    expect(JSON.stringify(launch())).not.toContain("ghp_seam_test_value_never_sent");
  });

  it("subscribes to its readiness verdict BEFORE it asks for the launch", async () => {
    // The backend runs the probe right after it launches; a listener attached afterwards could miss a fast one,
    // and the verdict is what hides a terminal that cannot work.
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);
    await waitFor(() => expect(launch()).toBeTruthy());
    const listened = vi.mocked(listen).mock.calls.findIndex(([event]) => event === `pty_readiness_${DEF.paneId}`);
    expect(listened, "the view never listened for its readiness verdict").toBeGreaterThanOrEqual(0);
    expect(
      vi.mocked(listen).mock.invocationCallOrder[listened],
      "the readiness listener must be attached before pty_create is invoked",
    ).toBeLessThan(vi.mocked(invoke).mock.invocationCallOrder[launchCall()]);
  });
});
