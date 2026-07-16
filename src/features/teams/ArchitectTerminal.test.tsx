import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ArchitectTerminal } from "./ArchitectTerminal";
import { ARCHITECT_PANE_ID, ARCHITECT_ALLOWED_COMMANDS } from "./useArchitectTerminal";
import { TeamsPanel } from "./TeamsPanel";
import { useAppStore } from "@/store";

/**
 * #2755 — the Teams Studio's team-architect session: launch wiring (workspace → restricted settings →
 * pty_create with the persona kickoff BAKED into the launch arg). #2759 — the dock is now present on
 * BOTH graph levels (the Teams overview AND an entered team) and PERSISTS across the switch (one PTY,
 * the same DOM node, never killed on navigation). A mirror of DesignerTerminal.test.tsx.
 */

// xterm can't initialize in jsdom (open() needs real DOM measurements) — stub it (same pattern as
// DesignerTerminal.test.tsx / TerminalView.test.tsx).
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

const TEAMS_DIR = "C:/Users/x/.base-studio-code/teams-studio";
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
  useAppStore.setState({ teamsDrill: null });
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (cmd: string) =>
    cmd === "setup_architect_workspace" ? ({ teams_dir: TEAMS_DIR } as never) : (null as never));
});

afterEach(() => cleanup());

describe("useArchitectTerminal launch wiring (#2755)", () => {
  it("sets up the workspace, writes the RESTRICTED role-gated settings, then launches at the workspace cwd", async () => {
    render(<ArchitectTerminal />);

    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));

    // 1 · the workspace command ran first (it mints the cwd + the architect-spec CLAUDE.md).
    expect(callsTo("setup_architect_workspace")).toHaveLength(1);

    // 2 · ensure_session_settings: the architect role gate rendered with the restricted allow-list.
    const [settings] = callsTo("ensure_session_settings");
    expect(settings.cwd).toBe(TEAMS_DIR);
    expect(settings.restrictedAllow).toBe(true);
    expect(settings.replacePermissions).toBe(true);
    // The whole command surface: bsc teams + bsc persona.
    expect(settings.allowedCommands).toEqual(ARCHITECT_ALLOWED_COMMANDS);
    expect(settings.allowedCommands).toEqual(["bsc teams", "bsc persona"]);
    // git + gh are denied OUTRIGHT (the role's `none` tiers → the bare tools, not write prefixes);
    // `bsc ui` is denied too (ui:none — the architect never touches the UI-kit store).
    expect(settings.deniedCommands).toContain("git");
    expect(settings.deniedCommands).toContain("gh");
    expect(settings.deniedCommands).toContain("bsc ui");
    // Every file-write tool + the web tools are denied (code:none, net:none).
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]) {
      expect(settings.denyToolRules).toContain(t);
    }
    // No write-glob allows leak in (the architect has no carve-out); Read stays granted.
    expect(settings.allowToolRules).toEqual(["Read"]);

    // 3 · pty_create: the stable pane id, the workspace cwd, resume behavior, and the persona kickoff
    // BAKED into the launch arg (never typed after idle detection).
    const [pty] = callsTo("pty_create");
    expect(pty.paneId).toBe(ARCHITECT_PANE_ID);
    expect(pty.paneId).toBe("teams-studio:architect");
    expect(pty.cwd).toBe(TEAMS_DIR);
    expect(pty.continueSession).toBe(true);
    expect(pty.startupPromptFreshOnly).toBe(true);
    expect(pty.initCmd).toContain("claude --continue");
    expect(String(pty.startupPrompt)).toContain("bsc teams");
    expect(String(pty.startupPrompt)).toContain("bsc persona");
    // The runtime scope doc (#2470 integration): the architect renders ui:"none" (not a kit session).
    expect(pty.env).toEqual({ BSC_SCOPES: JSON.stringify({ ui: "none" }) });
  });

  it("does NOT launch when the workspace setup fails (no ungated session on an empty cwd)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "setup_architect_workspace") throw new Error("boom");
      return null as never;
    });
    render(<ArchitectTerminal />);
    await waitFor(() => expect(callsTo("setup_architect_workspace")).toHaveLength(1));
    expect(callsTo("ensure_session_settings")).toHaveLength(0);
    expect(callsTo("pty_create")).toHaveLength(0);
  });

  it("only unmounting (leaving the Teams tab) kills the PTY", async () => {
    const { unmount } = render(<ArchitectTerminal />);
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));
    expect(callsTo("pty_kill")).toHaveLength(0);
    unmount();
    expect(callsTo("pty_kill")).toHaveLength(1);
    expect(callsTo("pty_kill")[0].paneId).toBe(ARCHITECT_PANE_ID);
  });
});

describe("TeamsPanel architect dock — present on ALL graph levels (#2759)", () => {
  /** Enter a team from the Teams overview by clicking its card (the [data-node] wrapper). */
  const enter = (name: string) =>
    fireEvent.click(screen.getAllByText(name).map((el) => el.closest("[data-node]")).find(Boolean) as HTMLElement);
  /** Climb back to the overview via the "Teams" breadcrumb crumb. */
  const toTeams = () => fireEvent.click(screen.getByText("Teams"));

  it("is present on the top-level Teams overview (not only inside a team)", async () => {
    render(<TeamsPanel />);
    // The overview now docks the architect session too — a team is created/refined from here.
    expect(screen.getByTestId("architect-terminal")).toBeInTheDocument();
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));
  });

  it("persists across the overview↔team switch — the SAME node, one PTY, never killed on navigation", async () => {
    render(<TeamsPanel />);
    const onOverview = screen.getByTestId("architect-terminal");
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));

    // Enter a team → React reconciles ONE GraphCanvas/terminal, so the dock is the SAME DOM node
    // (a remount would give a fresh node and a second pty_create).
    const team = useAppStore.getState().teams[0].name;
    enter(team);
    expect(screen.getByTestId("architect-terminal")).toBe(onOverview);

    // Climb back to the overview → still the same node.
    toTeams();
    expect(screen.getByTestId("architect-terminal")).toBe(onOverview);

    // The session launched EXACTLY once and was never torn down while navigating levels.
    expect(callsTo("pty_create")).toHaveLength(1);
    expect(callsTo("pty_kill")).toHaveLength(0);
  });
});
