import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LibrarianTerminal } from "./LibrarianTerminal";
import { AlgorithmsWorkspace } from "./AlgorithmsWorkspace";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
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
    activeWorkspace: "projects", projectsPageMode: "algorithms",
  });
});
afterEach(() => cleanup());

describe("LibrarianTerminal dock (#3357)", () => {
  it("claims the librarian's stable pane id on the shared TerminalHost", () => {
    const { container } = render(<TerminalHost><LibrarianTerminal /></TerminalHost>);
    expect(screen.getByTestId("librarian-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toContain(STUDIO_SESSIONS.librarian.paneId);
  });

  it("showing the Algorithms page STARTS the session (lazy) and holds a viewer", () => {
    render(<TerminalHost><LibrarianTerminal /></TerminalHost>);
    expect(useAppStore.getState().wantedStudios).toContain("librarian");
    expect(useAppStore.getState().studioViewers.librarian).toBe(1);
  });

  it("keeps the session warm when the page is left — only the reaper reclaims it now", () => {
    // The Algorithms page is kept mounted (#2827); leaving it moves the shell's page mode, which drops the
    // VIEWER. Before #3357 an unmount here killed the PTY; the session must now survive both, so the
    // Glance morph can keep showing it.
    const { rerender, unmount } = render(<TerminalHost><LibrarianTerminal /></TerminalHost>);
    useAppStore.setState({ projectsPageMode: "projects" });
    rerender(<TerminalHost><LibrarianTerminal /></TerminalHost>);
    expect(useAppStore.getState().studioViewers.librarian).toBe(0);
    expect(useAppStore.getState().wantedStudios).toContain("librarian");
    unmount();
    expect(useAppStore.getState().wantedStudios).toContain("librarian");
  });

  it("is inert with no <TerminalHost> ancestor (renders in isolation without crashing)", () => {
    expect(() => render(<LibrarianTerminal />)).not.toThrow();
    expect(screen.getByTestId("librarian-terminal")).toBeInTheDocument();
  });
});

describe("AlgorithmsWorkspace librarian dock (#2787)", () => {
  it("docks the librarian session below the graph", () => {
    const { container } = render(<TerminalHost><AlgorithmsWorkspace /></TerminalHost>);
    expect(screen.getByTestId("librarian-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toContain(STUDIO_SESSIONS.librarian.paneId);
  });

  it("clicking a graph node still drives the inspector with the dock present", () => {
    render(<TerminalHost><AlgorithmsWorkspace /></TerminalHost>);
    fireEvent.click(screen.getAllByText("Merge Sort")[0]);
    expect(screen.getByText(/Split, sort halves, merge/)).toBeTruthy(); // inspector-unique summary
  });
});
