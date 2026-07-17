import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { DesignerTerminal } from "./DesignerTerminal";
import { DESIGNER_PANE_ID, DESIGNER_ALLOWED_COMMANDS } from "./useDesignerTerminal";
import { DesignsWorkbench } from "./DesignsWorkbench";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { KeptMountedPage } from "@/app/KeptMountedPage";
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
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => "");
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
    // The whole command surface: bsc ui + the deprecated bsc component alias (#2469-safe), plus the
    // designer→debug channel (#3300) — file/list requests, but NOT resolve (the debug session's job).
    expect(settings.allowedCommands).toEqual(DESIGNER_ALLOWED_COMMANDS);
    expect(settings.allowedCommands).toEqual(["bsc ui", "bsc component", "bsc request new", "bsc request list"]);
    expect(settings.allowedCommands).not.toContain("bsc request resolve");
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
    // The designer→debug charter (#3300): on a bsc ui wall, file a request instead of asking for perms.
    expect(String(pty.startupPrompt)).toContain("bsc request new");
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

  it("mounts the designer session immediately, docked in the studio's GraphCanvas, with no toggle button", async () => {
    render(<DesignsWorkbench />);
    // Present from the first render — no ✦ Designer button gates it; the panel is docked below the graph
    // in the studio's GraphCanvas shell (#2766), not a full-width overlay, and it spawns exactly one PTY.
    const panel = screen.getByTestId("designer-terminal");
    expect(panel).toBeInTheDocument();
    expect(panel.style.display).not.toBe("none");
    expect(screen.queryByRole("button", { name: /Designer/ })).toBeNull();
    expect(panel.closest(".ds-graph")).toBeTruthy();
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));
  });
});

describe("designer PTY survives a planner-tab switch (kept-mounted, #2826)", () => {
  // The Design Studio is a Planner tab (projectsPageMode "designs"), rendered through the SAME
  // `KeptMountedPage` treatment ProjectsWorkspace gives it (src/features/planner/index.tsx): switching
  // to another planner tab toggles the page's `active` (display: flex ↔ none) WITHOUT unmounting, so the
  // always-on designer session is never torn down and its PTY is never relaunched. Before the page rode
  // KeptMountedPage the tab switch unmounted DesignsWorkbench → DesignerTerminal → the shared
  // useScreenSession cleanup fired pty_kill, and returning re-spawned it. This reproduces the switch via
  // the `active` prop and asserts the PTY lifecycle across an away-and-back cycle: one pty_create, no
  // pty_kill, no relaunch — the guard that would have caught the original bug.
  it("keeps the session mounted (CSS-hidden) across a tab switch and never relaunches the PTY", async () => {
    const { rerender, container } = render(
      <KeptMountedPage active={true}>
        <DesignerTerminal />
      </KeptMountedPage>,
    );
    // On the Designs tab: the session mounts and spawns exactly one PTY.
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.display).toBe("flex"); // shown
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument();

    // Switch to another planner tab → active=false. The page CSS-hides but STAYS mounted: no pty_kill.
    rerender(
      <KeptMountedPage active={false}>
        <DesignerTerminal />
      </KeptMountedPage>,
    );
    expect(wrapper.style.display).toBe("none"); // hidden, not unmounted
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument();
    expect(callsTo("pty_kill")).toHaveLength(0);

    // Switch back to the Designs tab → active=true. Same mount — the PTY was never re-created.
    rerender(
      <KeptMountedPage active={true}>
        <DesignerTerminal />
      </KeptMountedPage>,
    );
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument();
    expect(callsTo("pty_create")).toHaveLength(1); // NOT 2 — no relaunch
    expect(callsTo("pty_kill")).toHaveLength(0);
  });

  it("fully tears the session down (pty_kill) only when the page is UNMOUNTED — e.g. torn off (gate drops)", async () => {
    // The single-owner gate: when the Designs tab is torn into its own window, the main window's
    // KeptMountedPage `gate` drops to false → it returns null and unmounts, releasing the one PTY for the
    // detached window. That real unmount (unlike a tab switch) MUST run the cleanup and kill the PTY.
    const { rerender } = render(
      <KeptMountedPage active={true} gate={true}>
        <DesignerTerminal />
      </KeptMountedPage>,
    );
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));
    expect(callsTo("pty_kill")).toHaveLength(0);

    // gate=false → KeptMountedPage returns null → the page unmounts → the PTY is killed.
    rerender(
      <KeptMountedPage active={true} gate={false}>
        <DesignerTerminal />
      </KeptMountedPage>,
    );
    expect(screen.queryByTestId("designer-terminal")).toBeNull();
    expect(callsTo("pty_kill")).toHaveLength(1);
    expect(callsTo("pty_kill")[0].paneId).toBe(DESIGNER_PANE_ID);
  });
});
