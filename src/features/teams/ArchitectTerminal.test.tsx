import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ArchitectTerminal } from "./ArchitectTerminal";
import { TeamsPanel } from "./TeamsPanel";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { useAppStore } from "@/store";
import { STUDIO_SESSIONS } from "@/features/studio-sessions";

/**
 * #2755 — the Teams Studio's architect dock, REWRITTEN for #3357.
 *
 * The dock no longer owns the session: the architect was migrated off its bespoke `useArchitectTerminal`
 * (`useScreenSession`) xterm onto the shared TerminalHost, so the dock is a VIEWER that drops a
 * <TerminalSlot> for the stable pane id — which is what lets the Glance `architect` node MORPH into the
 * live session. This is also the biggest behavioural WIN of the three: leaving the Teams page used to
 * UNMOUNT this dock and `pty_kill` the architect outright, so the session died on every navigation.
 * Launch wiring is asserted in `features/studio-sessions/StudioSessionMount.test.tsx`, and the restricted
 * permission payload in `app/console/lib/sessionLaunch.test.ts`.
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
    activeWorkspace: "projects", projectsPageMode: "teams",
  });
});
afterEach(() => cleanup());

describe("ArchitectTerminal dock (#3357)", () => {
  it("claims the architect's stable pane id on the shared TerminalHost", () => {
    const { container } = render(<TerminalHost><ArchitectTerminal /></TerminalHost>);
    expect(screen.getByTestId("architect-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toContain(STUDIO_SESSIONS.architect.paneId);
  });

  it("showing the Teams page STARTS the session (lazy) and holds a viewer", () => {
    render(<TerminalHost><ArchitectTerminal /></TerminalHost>);
    expect(useAppStore.getState().wantedStudios).toContain("architect");
    expect(useAppStore.getState().studioViewers.architect).toBe(1);
  });

  it("leaving the Teams page NO LONGER kills the session — the regression this migration fixes", () => {
    // TeamsPanel unmounts when the planner switches off the Teams page, which used to run the hook's
    // cleanup and `pty_kill` the architect. The session must now outlive the dock entirely.
    const { unmount } = render(<TerminalHost><ArchitectTerminal /></TerminalHost>);
    unmount();
    expect(useAppStore.getState().studioViewers.architect).toBe(0);
    expect(useAppStore.getState().wantedStudios).toContain("architect");
  });

  it("is inert with no <TerminalHost> ancestor (renders in isolation without crashing)", () => {
    expect(() => render(<ArchitectTerminal />)).not.toThrow();
    expect(screen.getByTestId("architect-terminal")).toBeInTheDocument();
  });
});

describe("TeamsPanel architect dock — present on ALL graph levels (#2759)", () => {
  /** Enter a team from the Teams overview by clicking its card (the [data-node] wrapper). */
  const enter = (name: string) =>
    fireEvent.click(screen.getAllByText(name).map((el) => el.closest("[data-node]")).find(Boolean) as HTMLElement);
  /** Climb back to the overview via the "Teams" breadcrumb crumb. */
  const toTeams = () => fireEvent.click(screen.getByText("Teams"));

  it("is present on the top-level Teams overview (not only inside a team)", () => {
    const { container } = render(<TerminalHost><TeamsPanel /></TerminalHost>);
    expect(screen.getByTestId("architect-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toContain(STUDIO_SESSIONS.architect.paneId);
  });

  it("persists across the overview↔team switch — the SAME node, one claim, never re-created", () => {
    render(<TerminalHost><TeamsPanel /></TerminalHost>);
    const onOverview = screen.getByTestId("architect-terminal");

    // Enter a team → React reconciles ONE GraphCanvas/dock, so it is the SAME DOM node (a remount would
    // give a fresh node, and — before #3357 — a second pty_create).
    const team = useAppStore.getState().teams[0].name;
    enter(team);
    expect(screen.getByTestId("architect-terminal")).toBe(onOverview);

    // Climb back to the overview → still the same node, still exactly one claim on the architect's pane.
    toTeams();
    expect(screen.getByTestId("architect-terminal")).toBe(onOverview);
    expect(useAppStore.getState().studioViewers.architect).toBe(1);
  });
});
