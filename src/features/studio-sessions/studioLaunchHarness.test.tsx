// A STUDIO LAUNCHES THE HARNESS ITS PANE RESOLVED — asserted on the `pty_create` payload.
//
// MEASURED ON THE RUNNING APP, 2026-09-01. Every architect session died ~20-30s after it opened, and
// the log says exactly why in two lines:
//
//     11:49:00 pty[network-finance:architect] created · provider=bsc-agent · launch=claude --continue …
//     11:49:22 [reaper] reaping idle pane network-finance:architect
//     11:49:22 pane[network-finance:architect] stopped · reaped · Idle too long
//
// `provider=bsc-agent` and `launch=claude` in ONE line. `STUDIO_INIT_CMD` was a literal string naming
// claude, while `TerminalView` hands `pty_create` the harness `paneHarness` resolves — and the
// fleet-wide setting had made that `bsc-agent`. Two failures out of one line:
//
//   1. the architect ran Claude Code, never the local model that was selected;
//   2. `pty_create` installs the SELECTED harness's shell wrapper — `bsc-agent() { __bsc_state run; … }`
//      — so nothing wrapped `claude`, the OSC-100 `run` marker was never emitted, and the backend
//      reaper read the session as `Idle`. That is the 10-second grace instead of the 5-minute silence
//      ceiling, so the session was reclaimed before the user could type into it.
//
// The director was untouched throughout, because it launches through `LaunchPlan::Prompt` and that arm
// asks `harness.launch_command`. This file pins the studio path to the same rule.
//
// The seam is real end-to-end (mount → TerminalHost → TerminalSlot → TerminalView → pty_create); only
// xterm and the Tauri bridge are mocked, for the reason `studioLaunchSeam.test.tsx` gives: a test that
// stops at the store passes while the launch is wrong.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { StudioSessionMount } from "@/features/studio-sessions/StudioSessionMount";
import { NetworkArchitectMount, networkArchitectPaneId } from "@/features/studio-sessions/NetworkArchitectMount";
import { STUDIO_SESSIONS, studioInitCmd } from "@/features/studio-sessions/lib/studioSessions";
import { useAppStore } from "@/store";
import { invoke } from "@tauri-apps/api/core";

const DEF = STUDIO_SESSIONS.designerReact;
const NETWORK = "network-finance";

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
    if (cmd === DEF.setupCommand) return { [DEF.dirKey]: "/studio/design/react" };
    if (cmd === "setup_network_architect_workspace") return { network_dir: "/networks/finance" };
    if (cmd === "pty_pane_runtime") {
      const ids = (payload as { paneIds?: string[] } | undefined)?.paneIds ?? [];
      return ids.map((paneId) => ({ paneId, live: false }));
    }
    if (cmd === "pty_create") return true;
    return "";
  });
  useAppStore.setState({
    paneStartupPromptText: {}, studioPendingDirective: {}, paneContinue: {},
    // The user's fleet-wide choice: run the agents on a local model. This is the ONLY thing that made
    // the architect unlaunchable, and nothing about it is exotic — it is one Settings toggle.
    paneProviders: {}, fleetPaneStreams: {}, fleetHarness: "bsc-agent",
  });
});
afterEach(cleanup);

/** The `pty_create` payload for `paneId`, or undefined if that launch never happened. */
const launchOf = (paneId: string) => {
  const call = vi.mocked(invoke).mock.calls.find(
    (c) => c[0] === "pty_create" && (c[1] as { paneId?: string } | undefined)?.paneId === paneId,
  );
  return call?.[1] as { paneId?: string; initCmd?: string; providerId?: string } | undefined;
};

describe("the init command a studio launches with", () => {
  it("names the harness, not claude", () => {
    expect(studioInitCmd("bsc-agent").startsWith("bsc-agent --continue")).toBe(true);
    // No stray `claude` anywhere in the line — the fallback arm has to be the harness too, or a
    // studio with nothing to resume starts the wrong program on its second breath.
    expect(studioInitCmd("bsc-agent")).not.toContain("claude");
    // The diagnostic that made #3374 findable is still in it (both arms).
    expect(studioInitCmd("bsc-agent")).toContain("studio-resume.log");
    expect(studioInitCmd("bsc-agent")).toContain("no prior session resumed");
  });

  it("is byte-identical to what a Claude studio always launched", () => {
    // Behaviour for the harness this line used to hardcode must not move at all.
    expect(studioInitCmd("claude")).toBe(
      'claude --continue 2>>"${BSC_LOG_DIR:-/tmp}/studio-resume.log"'
      + ' || { echo "[studio] no prior session resumed — starting fresh (why: ${BSC_LOG_DIR:-/tmp}/studio-resume.log)"; claude; }',
    );
  });

  it("falls back to claude for an empty harness rather than emitting a bare ` --continue`", () => {
    // A blank harness would render `" --continue …"`, which bash runs as `--continue` — command not
    // found, an instantly idle pane, and a reap. Degrade to the old default instead.
    expect(studioInitCmd("").startsWith("claude --continue")).toBe(true);
  });
});

describe("a network architect on a local model", () => {
  it("launches bsc-agent — the same harness pty_create is told to install", async () => {
    const paneId = networkArchitectPaneId(NETWORK);
    render(<TerminalHost><NetworkArchitectMount networkId={NETWORK} /></TerminalHost>);

    await waitFor(() => {
      const p = launchOf(paneId);
      expect(p, "pty_create was never called — no architect session launched at all").toBeTruthy();
      // THE ASSERTION THAT WOULD HAVE CAUGHT IT: the launch and the harness must be the same program.
      // Before this they were `claude --continue …` and `bsc-agent`, in one `pty_create` call.
      expect(p!.providerId).toBe("bsc-agent");
      // LITERALS, not `studioInitCmd("bsc-agent")`. Asserting against the same helper the mount calls
      // would pass the moment the helper exists, whatever the mount actually passed — and the mount
      // passing the wrong thing IS the bug. This is the shape the log line has to show.
      expect(p!.initCmd, "the architect launched a harness nobody installed a wrapper for")
        .toMatch(/^bsc-agent --continue /);
      expect(p!.initCmd).not.toContain("claude");
    });
  });
});

describe("a studio on a local model", () => {
  it("launches bsc-agent too — the rule is the pane's, not the network's", async () => {
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);
    await waitFor(() => {
      const p = launchOf(DEF.paneId);
      expect(p, "pty_create was never called").toBeTruthy();
      expect(p!.providerId).toBe("bsc-agent");
      expect(p!.initCmd).toMatch(/^bsc-agent --continue /);
      expect(p!.initCmd).not.toContain("claude");
    });
  });
});
