import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { LibrarianTerminal } from "./LibrarianTerminal";
import { LIBRARIAN_PANE_ID, LIBRARIAN_ALLOWED_COMMANDS } from "./useLibrarianTerminal";
import { AlgorithmsWorkspace } from "./AlgorithmsWorkspace";

/**
 * #2787 — the Algorithms tab's knowledge-store librarian session: launch wiring (workspace → restricted
 * settings → pty_create with the persona kickoff BAKED into the launch arg) + the dock placement (docked
 * below the Algorithms graph). A mirror of ArchitectTerminal.test.tsx.
 */

// xterm can't initialize in jsdom (open() needs real DOM measurements) — stub it (same pattern as
// ArchitectTerminal.test.tsx / DesignerTerminal.test.tsx).
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

const ALGO_DIR = "C:/Users/x/.base-studio-code/algorithms-studio";
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
    cmd === "setup_librarian_workspace" ? ({ algorithms_dir: ALGO_DIR } as never) : (null as never));
});

afterEach(() => cleanup());

describe("useLibrarianTerminal launch wiring (#2787)", () => {
  it("sets up the workspace, writes the RESTRICTED role-gated settings, then launches at the workspace cwd", async () => {
    render(<LibrarianTerminal />);

    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));

    // 1 · the workspace command ran first (it mints the cwd + the librarian-spec CLAUDE.md).
    expect(callsTo("setup_librarian_workspace")).toHaveLength(1);

    // 2 · ensure_session_settings: the librarian role gate rendered with the restricted allow-list.
    const [settings] = callsTo("ensure_session_settings");
    expect(settings.cwd).toBe(ALGO_DIR);
    expect(settings.restrictedAllow).toBe(true);
    expect(settings.replacePermissions).toBe(true);
    // The whole command surface: bsc graph.
    expect(settings.allowedCommands).toEqual(LIBRARIAN_ALLOWED_COMMANDS);
    expect(settings.allowedCommands).toEqual(["bsc graph"]);
    // git + gh are denied OUTRIGHT (the role's `none` tiers → the bare tools); `bsc ui` denied too (ui:none).
    expect(settings.deniedCommands).toContain("git");
    expect(settings.deniedCommands).toContain("gh");
    expect(settings.deniedCommands).toContain("bsc ui");
    // Every file-write tool + the web tools are denied (code:none, net:none).
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]) {
      expect(settings.denyToolRules).toContain(t);
    }
    // No write-glob allows leak in (the librarian has no carve-out); Read stays granted.
    expect(settings.allowToolRules).toEqual(["Read"]);

    // 3 · pty_create: the stable pane id, the workspace cwd, resume behavior, and the persona kickoff
    // BAKED into the launch arg (never typed after idle detection).
    const [pty] = callsTo("pty_create");
    expect(pty.paneId).toBe(LIBRARIAN_PANE_ID);
    expect(pty.paneId).toBe("algorithms-studio:librarian");
    expect(pty.cwd).toBe(ALGO_DIR);
    expect(pty.continueSession).toBe(true);
    expect(pty.startupPromptFreshOnly).toBe(true);
    expect(pty.initCmd).toContain("claude --continue");
    expect(String(pty.startupPrompt)).toContain("bsc graph");
    // The runtime scope doc (#2470): the librarian renders ui:"none" (not a kit session).
    expect(pty.env).toEqual({ BSC_SCOPES: JSON.stringify({ ui: "none" }) });
  });

  it("does NOT launch when the workspace setup fails (no ungated session on an empty cwd)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "setup_librarian_workspace") throw new Error("boom");
      return null as never;
    });
    render(<LibrarianTerminal />);
    await waitFor(() => expect(callsTo("setup_librarian_workspace")).toHaveLength(1));
    expect(callsTo("ensure_session_settings")).toHaveLength(0);
    expect(callsTo("pty_create")).toHaveLength(0);
  });

  it("only unmounting (leaving the Algorithms tab) kills the PTY", async () => {
    const { unmount } = render(<LibrarianTerminal />);
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));
    expect(callsTo("pty_kill")).toHaveLength(0);
    unmount();
    expect(callsTo("pty_kill")).toHaveLength(1);
    expect(callsTo("pty_kill")[0].paneId).toBe(LIBRARIAN_PANE_ID);
  });
});

describe("AlgorithmsWorkspace librarian dock (#2787)", () => {
  it("docks the librarian session below the graph, spawning exactly one PTY", async () => {
    render(<AlgorithmsWorkspace />);
    // The dock is present from the first render — no toggle gates it.
    expect(screen.getByTestId("librarian-terminal")).toBeInTheDocument();
    await waitFor(() => expect(callsTo("pty_create")).toHaveLength(1));
    expect(callsTo("pty_create")[0].paneId).toBe(LIBRARIAN_PANE_ID);
  });

  it("clicking a graph node still drives the inspector with the dock present", () => {
    render(<AlgorithmsWorkspace />);
    fireEvent.click(screen.getAllByText("Merge Sort")[0]);
    expect(screen.getByText(/Split, sort halves, merge/)).toBeTruthy(); // inspector-unique summary
  });
});
