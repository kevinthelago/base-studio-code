import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LibrarianTerminal } from "@/features/algorithms/LibrarianTerminal";
import { AlgorithmsWorkspace } from "@/features/algorithms/AlgorithmsWorkspace";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { useAppStore } from "@/store";
import { STUDIO_SESSIONS } from "@/features/studio-sessions";

/**
 * #2787 — the Algorithms tab's librarian dock, REWRITTEN for #3357.
 *
 * The dock no longer owns the session: the librarian was migrated off its bespoke `useLibrarianTerminal`
 * (`useScreenSession`) xterm onto the shared TerminalHost, so the dock is a VIEWER that drops a
 * <TerminalSlot> for the stable pane id — which is what lets the Glance `librarian` node MORPH into the
 * live session. Launch wiring is asserted in `features/studio-sessions/StudioSessionMount.test.tsx`, and the
 * restricted permission payload (the security guard the bespoke launch used to carry) in
 * `app/console/lib/sessionLaunch.test.ts`.
 */

// Stub the real terminal — this file is about the dock's claim + lifecycle registration, not xterm/PTY.
vi.mock("@/app/console/panes/views/TerminalView", () => ({
  TerminalView: ({ paneId }: { paneId: string }) => <div data-testid="tv" data-pane={paneId} />,
}));

/** The pane ids the rendered <TerminalSlot>s claimed, read off the host's stable container nodes. */
const claimedPanes = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("[data-terminal-container]")).map((el) => (el as HTMLElement).dataset.terminalContainer);

beforeEach(() => {
  useAppStore.setState({
    wantedStudios: [], studioViewers: {},
    activeWorkspace: "algorithms",
  });
});
afterEach(() => cleanup());

describe("LibrarianTerminal dock (#3357)", () => {
  // #3427 — an app-owned studio session must NOT create its terminal until the mount that supplies its
  // launch props has claimed the pane. Without that gate the viewer registered first, `TerminalView`
  // mounted with `initialCwd`/`initCmd` undefined, and the one-shot `pty_create` ran in the app's own
  // directory: no spec CLAUDE.md, no `--continue`, no persona kickoff, and — because
  // `ensure_session_settings` skips an empty cwd — NO ROLE GATE. So the dock alone claiming the pane is
  // the bug, not the contract; these two tests pin both halves of it.
  it("does NOT create the terminal from the dock alone — it waits for the session mount (#3427)", () => {
    const { container } = render(<TerminalHost><LibrarianTerminal tech="rust" /></TerminalHost>);
    expect(screen.getByTestId("librarian-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toEqual([]);
  });

  it("claims the librarian's stable pane id once the session mount supplies the launch props (#3427)", () => {
    const { container } = render(
      <TerminalHost>
        {/* Stands in for StudioSessionMount: the PRIMARY claim carrying cwd/initCmd. */}
        <TerminalSlot paneId={STUDIO_SESSIONS.librarianRust.paneId} primary parked visible={false} initialCwd="/tmp/librarian" />
        <LibrarianTerminal tech="rust" />
      </TerminalHost>,
    );
    expect(screen.getByTestId("librarian-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toContain(STUDIO_SESSIONS.librarianRust.paneId);
  });

  it("showing the Algorithms page STARTS the session (lazy) and holds a viewer", () => {
    render(<TerminalHost><LibrarianTerminal tech="rust" /></TerminalHost>);
    expect(useAppStore.getState().wantedStudios).toContain("librarianRust");
    expect(useAppStore.getState().studioViewers.librarianRust).toBe(1);
  });

  it("keeps the session warm when the page is left — only the reaper reclaims it now", () => {
    // The Algorithms page is kept mounted (#2827); leaving it moves the shell's active WORKSPACE
    // (`five-graphs-become-rail-workspaces` — it was the Planner's page mode), which drops the VIEWER.
    // Before #3357 an unmount here killed the PTY; the session must now survive both, so the Glance
    // morph can keep showing it.
    const { rerender, unmount } = render(<TerminalHost><LibrarianTerminal tech="rust" /></TerminalHost>);
    useAppStore.setState({ activeWorkspace: "glance" });
    rerender(<TerminalHost><LibrarianTerminal tech="rust" /></TerminalHost>);
    expect(useAppStore.getState().studioViewers.librarianRust).toBe(0);
    expect(useAppStore.getState().wantedStudios).toContain("librarianRust");
    unmount();
    expect(useAppStore.getState().wantedStudios).toContain("librarianRust");
  });

  // #system-sessions-are-per-technology — the dock FOLLOWS the page's language rather than holding a
  // selection of its own, and only the ACTIVE language's session is started.
  it("starts the session for the language it is given, and no other", () => {
    render(<TerminalHost><LibrarianTerminal tech="python" /></TerminalHost>);
    const st = useAppStore.getState();
    expect(st.wantedStudios).toEqual(["librarianPython"]);
    expect(st.studioViewers.librarianRust ?? 0).toBe(0);
    expect(st.studioViewers.librarianTypescript ?? 0).toBe(0);
  });

  it("switching language starts the new one and releases the old — three languages, one process", () => {
    // The lazy-per-tech guarantee: a rail with three languages must not cost three Claude processes.
    const { rerender } = render(<TerminalHost><LibrarianTerminal tech="rust" /></TerminalHost>);
    expect(useAppStore.getState().studioViewers.librarianRust).toBe(1);

    rerender(<TerminalHost><LibrarianTerminal tech="typescript" /></TerminalHost>);
    const st = useAppStore.getState();
    expect(st.studioViewers.librarianTypescript).toBe(1);
    // The one you left drops to zero viewers, which is what ARMS its reaper. It stays WANTED (warm) —
    // switching back inside the idle window reattaches to the same conversation.
    expect(st.studioViewers.librarianRust).toBe(0);
    expect(st.wantedStudios).toContain("librarianRust");
  });

  it("shows an EMPTY dock for a language with no session rather than another language's", () => {
    // A wrong-but-populated dock looks like it is working. `go` has no librarian, so nothing is claimed
    // and nothing is started.
    const { container } = render(<TerminalHost><LibrarianTerminal tech="go" /></TerminalHost>);
    expect(screen.getByTestId("librarian-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toEqual([]);
    expect(useAppStore.getState().wantedStudios).toEqual([]);
  });

  it("is inert with no <TerminalHost> ancestor (renders in isolation without crashing)", () => {
    expect(() => render(<LibrarianTerminal tech="rust" />)).not.toThrow();
    expect(screen.getByTestId("librarian-terminal")).toBeInTheDocument();
  });
});

describe("AlgorithmsWorkspace librarian dock (#2787)", () => {
  it("docks the librarian session below the graph", () => {
    // The primary claim stands in for StudioSessionMount — without it the #3427 gate correctly withholds
    // the terminal, and this test is about WHERE the dock sits, not about that gate.
    const { container } = render(
      <TerminalHost>
        <TerminalSlot paneId={STUDIO_SESSIONS.librarianRust.paneId} primary parked visible={false} initialCwd="/tmp/librarian" />
        <AlgorithmsWorkspace />
      </TerminalHost>,
    );
    expect(screen.getByTestId("librarian-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toContain(STUDIO_SESSIONS.librarianRust.paneId);
  });

  // Vocabulary updated for the impl-only model (#3390). This asserted the ABSTRACT CONCEPT layer — it
  // clicked a "Merge Sort" concept node and read that concept's prose summary out of the inspector. #2961
  // deleted that layer outright ("a node IS its implementation — there is no concept layer"), removing the
  // concept nodes, the concept-node view in AlgorithmsInspector, and every prose summary; #2971 then dropped
  // the language suffix from impl names. That commit rewrote the algorithms tests to the impl-only model but
  // missed this one, which lives in the DOCK's file — so it has queried a node that cannot exist since.
  //
  // The GUARANTEE is still real and still worth a test, so this is rewritten rather than deleted: it is the
  // only coverage of node-click→inspector with the librarian dock MOUNTED (the #2787 risk is the dock
  // swallowing canvas interaction). AlgorithmsWorkspace.test.tsx covers the same path WITHOUT the dock, so
  // this mirrors its impl-only assertions: click the `merge_sort` impl, read its inspector-unique code.
  it("clicking a graph node still drives the inspector with the dock present", () => {
    render(<TerminalHost><AlgorithmsWorkspace /></TerminalHost>);
    // `merge_sort` is Rust and TypeScript is the default tab
    // (`technology-tabs-for-components-and-algorithms`), so open its language first.
    fireEvent.click(screen.getByText("Rust"));
    fireEvent.click(screen.getAllByText("merge_sort")[0]);
    expect(screen.getByText((c) => c.includes("merge(&left, &right)"))).toBeTruthy(); // inspector-unique code
  });
});
