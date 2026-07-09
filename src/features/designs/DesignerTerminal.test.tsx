import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { DesignerTerminal } from "./DesignerTerminal";
import { DESIGNER_PANE_ID, DESIGNER_ALLOWED_COMMANDS } from "./useDesignerTerminal";
import { DesignsWorkbench } from "./DesignsWorkbench";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { useAppStore } from "@/store";

/**
 * #2471 — the Design Studio's designer session: launch wiring (workspace → restricted settings →
 * pty_create with the persona kickoff BAKED into the launch arg) and the collapse contract (the
 * panel CSS-hides; the PTY is NOT killed).
 */

// xterm can't initialize in jsdom (open() needs real DOM measurements) — stub it (same pattern as
// TerminalView.test.tsx).
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    dispose = vi.fn();
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = vi.fn();
  }
  return { FitAddon };
});
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const DESIGN_DIR = "C:/Users/x/.base-studio-code/design-studio";
const invokeMock = vi.mocked(invoke);

/** All calls to a given command, as their args objects. */
const callsTo = (cmd: string) =>
  invokeMock.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args as Record<string, unknown>);

beforeAll(() => {
  // jsdom reports 0 layout; run rAF synchronously so the mount-time launch chain fires in-test.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (cmd: string) =>
    cmd === "setup_designer_workspace" ? ({ design_dir: DESIGN_DIR } as never) : (null as never));
});

afterEach(() => cleanup());

describe("useDesignerTerminal launch wiring (#2471)", () => {
  it("sets up the workspace, writes the RESTRICTED role-gated settings, then launches at the workspace cwd", async () => {
    render(<DesignerTerminal />);

    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));

    // 1 · the workspace command ran first (it mints the cwd + the designer-spec CLAUDE.md).
    expect(callsTo("setup_designer_workspace")).toHaveLength(1);

    // 2 · ensure_session_settings: the designer role gate rendered with the restricted allow-list.
    const [settings] = callsTo("ensure_session_settings");
    expect(settings.cwd).toBe(DESIGN_DIR);
    expect(settings.restrictedAllow).toBe(true);
    expect(settings.replacePermissions).toBe(true);
    // The whole command surface: bsc ui + the deprecated bsc component alias (#2469-safe).
    expect(settings.allowedCommands).toEqual(DESIGNER_ALLOWED_COMMANDS);
    expect(settings.allowedCommands).toEqual(["bsc ui", "bsc component"]);
    // git + gh are denied OUTRIGHT (the role's `none` tiers → the bare tools, not write prefixes).
    expect(settings.deniedCommands).toContain("git");
    expect(settings.deniedCommands).toContain("gh");
    // Every file-write tool + the web tools are denied (code:none, net:none).
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]) {
      expect(settings.denyToolRules).toContain(t);
    }
    // No write-glob allows leak in (the designer has no carve-out); Read stays granted.
    expect(settings.allowToolRules).toEqual(["Read"]);

    // 3 · pty_create: the stable pane id, the workspace cwd, resume behavior, and the persona
    // kickoff BAKED into the launch arg (never typed after idle detection).
    const [pty] = callsTo("pty_create");
    expect(pty.paneId).toBe(DESIGNER_PANE_ID);
    expect(pty.paneId).toBe("design-studio:designer");
    expect(pty.cwd).toBe(DESIGN_DIR);
    expect(pty.continueSession).toBe(true);
    expect(pty.startupPromptFreshOnly).toBe(true);
    expect(pty.initCmd).toContain("claude --continue");
    expect(String(pty.startupPrompt)).toContain("bsc ui");
    expect(String(pty.startupPrompt)).toContain("bsc ui validate");
    // The runtime scope doc (#2470 integration): the designer is the one ui:"write" launch.
    expect(pty.env).toEqual({ BSC_SCOPES: JSON.stringify({ ui: "write" }) });
  });

  it("does NOT launch when the workspace setup fails (no ungated session on an empty cwd)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "setup_designer_workspace") throw new Error("boom");
      return null as never;
    });
    render(<DesignerTerminal />);
    await waitFor(() => expect(callsTo("setup_designer_workspace")).toHaveLength(1));
    expect(callsTo("ensure_session_settings")).toHaveLength(0);
    expect(callsTo("pty_create")).toHaveLength(0);
  });

  it("stays mounted and visible (always-on, no collapse); only unmounting kills the PTY (#2597)", async () => {
    const { unmount } = render(<DesignerTerminal />);
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));

    // The panel is always visible — there is no display:none collapse state anymore.
    const panel = screen.getByTestId("designer-terminal");
    expect(panel).toBeInTheDocument();
    expect(panel.style.display).not.toBe("none");
    expect(callsTo("pty_kill")).toHaveLength(0);

    // Only a real unmount (leaving the Design Studio) tears the session down.
    unmount();
    expect(callsTo("pty_kill")).toHaveLength(1);
    expect(callsTo("pty_kill")[0].paneId).toBe(DESIGNER_PANE_ID);
  });
});

describe("DesignsWorkbench always-on designer panel (#2597)", () => {
  beforeEach(() => {
    useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS });
  });

  it("mounts the designer session immediately, docked in the center column, with no toggle button", async () => {
    render(<DesignsWorkbench />);
    // Present from the first render — no ✦ Designer button gates it; the panel is docked in the
    // center column (below the graph), not a full-width overlay, and it spawns exactly one PTY.
    const panel = screen.getByTestId("designer-terminal");
    expect(panel).toBeInTheDocument();
    expect(panel.style.display).not.toBe("none");
    expect(screen.queryByRole("button", { name: /Designer/ })).toBeNull();
    expect(panel.closest(".ds-center")).toBeTruthy();
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));
  });
});
