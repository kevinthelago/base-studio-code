// A STUDIO LAUNCHES THE HARNESS ITS PANE RESOLVED.
//
// MEASURED ON THE RUNNING APP, 2026-09-01. Every architect session died ~20-30s after it opened, and the log
// says exactly why in two lines:
//
//     11:49:00 pty[network-finance:architect] created · provider=bsc-agent · launch=claude --continue …
//     11:49:22 [reaper] reaping idle pane network-finance:architect
//
// `provider=bsc-agent` and `launch=claude` in ONE line: the renderer composed the command from one rule and
// the harness from another, and handed `pty_create` both. `pty_create` installed the SELECTED harness's
// shell wrapper, so nothing wrapped `claude`, the OSC-100 `run` marker never fired, and the reaper took the
// session as idle.
//
// THE LAUNCH RESOLVES BOTH NOW, from one place (`frontend-state-2-pty-create-takes-a-pane-id`):
// `launch_plan` reads the pane's stored provider and the fleet-wide choice, and builds a studio's command with
// `Prose::studio_init_cmd` from THAT harness — so the two cannot come apart, because there is only one of
// each. The Rust resolver's tests own that. This file keeps the two things still true on this side: the
// `studioInitCmd` rule a studio mount still renders (and that the Rust port mirrors byte for byte), and that
// the view no longer SENDS a harness or a command, so there is no second copy left to disagree.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { StudioSessionMount } from "@/features/studio-sessions/StudioSessionMount";
import { NetworkArchitectMount, networkArchitectPaneId } from "@/features/studio-sessions/NetworkArchitectMount";
import { studioSessionDef, studioInitCmd } from "@/features/studio-sessions/lib/studioSessions";
import { useAppStore } from "@/store";
import { invoke } from "@tauri-apps/api/core";

const DEF = studioSessionDef("designerReact")!;
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
    if (cmd === "pty_create") return { isNew: true, launchesAgent: false };
    return "";
  });
  useAppStore.setState({
    paneStartupPromptText: {}, studioPendingDirective: {}, paneContinue: {},
    // The user's fleet-wide choice: run the agents on a local model — the setting that made the architect
    // unlaunchable.
    paneProviders: {}, fleetPaneStreams: {}, fleetHarness: "bsc-agent",
  });
});
afterEach(cleanup);

/** The `pty_create` payload for `paneId`, or undefined if that launch never happened. */
const launchOf = (paneId: string) => {
  const call = vi.mocked(invoke).mock.calls.find(
    (c) => c[0] === "pty_create" && (c[1] as { paneId?: string } | undefined)?.paneId === paneId,
  );
  return call?.[1] as Record<string, unknown> | undefined;
};

describe("the init command a studio launches with", () => {
  it("names the harness, not claude", () => {
    expect(studioInitCmd("bsc-agent").startsWith("bsc-agent --continue")).toBe(true);
    // No stray `claude` anywhere in the line — the fallback arm has to be the harness too, or a studio with
    // nothing to resume starts the wrong program on its second breath.
    expect(studioInitCmd("bsc-agent")).not.toContain("claude");
    // The diagnostic that made #3374 findable is still in it (both arms).
    expect(studioInitCmd("bsc-agent")).toContain("studio-resume.log");
    expect(studioInitCmd("bsc-agent")).toContain("no prior session resumed");
  });

  it("is byte-identical to what a Claude studio always launched", () => {
    // Behaviour for the harness this line used to hardcode must not move at all — and the Rust port
    // (`Prose::studio_init_cmd`) is held to the same bytes by the launch-plan parity run.
    expect(studioInitCmd("claude")).toBe(
      'claude --continue 2>>"${BSC_LOG_DIR:-/tmp}/studio-resume.log"'
      + ' || { echo "[studio] no prior session resumed — starting fresh (why: ${BSC_LOG_DIR:-/tmp}/studio-resume.log)"; claude; }',
    );
  });

  it("falls back to claude for an empty harness rather than emitting a bare ` --continue`", () => {
    // A blank harness would render `" --continue …"`, which bash runs as `--continue` — command not found, an
    // instantly idle pane, and a reap. Degrade to the old default instead.
    expect(studioInitCmd("").startsWith("claude --continue")).toBe(true);
  });
});

describe("the harness and the command are the launch's, never the view's", () => {
  it("a network architect's launch carries neither", async () => {
    const paneId = networkArchitectPaneId(NETWORK);
    render(<TerminalHost><NetworkArchitectMount networkId={NETWORK} /></TerminalHost>);
    await waitFor(() => expect(launchOf(paneId), "no architect session launched at all").toBeTruthy());
    // THE ASSERTION THAT KEEPS THE BUG IMPOSSIBLE: with neither on the wire, the launch cannot be handed a
    // harness from one rule and a command from another.
    expect(launchOf(paneId), "the harness is resolved by the launch").not.toHaveProperty("providerId");
    expect(launchOf(paneId), "the command is resolved by the launch").not.toHaveProperty("initCmd");
  });

  it("nor does a studio's — the rule is the pane's, not the network's", async () => {
    render(<TerminalHost><StudioSessionMount studio={DEF.id} /></TerminalHost>);
    await waitFor(() => expect(launchOf(DEF.paneId), "pty_create was never called").toBeTruthy());
    expect(launchOf(DEF.paneId)).not.toHaveProperty("providerId");
    expect(launchOf(DEF.paneId)).not.toHaveProperty("initCmd");
  });
});
