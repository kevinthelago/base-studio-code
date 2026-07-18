import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DesignerTerminal } from "./DesignerTerminal";
import { DesignsWorkbench } from "./DesignsWorkbench";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { KeptMountedPage } from "@/app/KeptMountedPage";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { useAppStore } from "@/store";
import { STUDIO_SESSIONS } from "@/features/studio-sessions";

/**
 * #2471/#2597 — the Design Studio's always-on designer dock, REWRITTEN for #3357.
 *
 * The dock used to OWN the session: it mounted its own xterm via `useDesignerTerminal`
 * (`useScreenSession`) and its unmount fired `pty_kill`. That terminal could not be re-parented, which is
 * exactly why the Glance `designer` node could not morph into it. The session now lives on the shared
 * TerminalHost (`StudioSessionHosts` → `StudioSessionMount`), so this dock is a VIEWER: it drops a
 * <TerminalSlot> for the stable pane id and registers itself with the studios lifecycle. The launch wiring
 * moved with it — asserted in `features/studio-sessions/StudioSessionMount.test.tsx` (seeded launch inputs) and
 * `app/console/lib/sessionLaunch.test.ts` (the restricted permission payload).
 *
 * What must still hold here, and what these tests guard:
 *  • the dock renders (always-on, no toggle button) and is docked in the studio's GraphCanvas;
 *  • it claims the DESIGNER's stable pane id — so the host hands it that one terminal, never a second;
 *  • showing the page OPENS the session (the lazy start) and holds a viewer;
 *  • leaving the page (kept-mounted, CSS-hidden) RELEASES the viewer but does NOT kill the session — the
 *    reversal of the old contract, and the thing that lets the Glance morph keep showing it.
 */

// Stub the real terminal: this file is about the DOCK's claim + lifecycle registration, not about xterm
// or the PTY launch (covered in StudioSessionMount.test.tsx / sessionLaunch.test.ts).
vi.mock("@/app/console/panes/views/TerminalView", () => ({
  TerminalView: ({ paneId }: { paneId: string }) => <div data-testid="tv" data-pane={paneId} />,
}));

/** The pane id a rendered <TerminalSlot> claimed, read off the host's stable container node. */
const claimedPanes = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("[data-terminal-container]")).map((el) => (el as HTMLElement).dataset.terminalContainer);

/** Put the shell on the Designs page (what `useStudioPageShowing` reads), or somewhere else. */
const showDesigns = (on: boolean) =>
  useAppStore.setState({ activeWorkspace: on ? "projects" : "glance", projectsPageMode: "designs" });

beforeEach(() => {
  useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, wantedStudios: [], studioViewers: {} });
  showDesigns(true);
});
afterEach(() => cleanup());

describe("DesignerTerminal dock (#3357)", () => {
  it("claims the designer's stable pane id on the shared TerminalHost", () => {
    const { container } = render(<TerminalHost><DesignerTerminal /></TerminalHost>);
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toContain(STUDIO_SESSIONS.designer.paneId);
  });

  it("opening the page STARTS the session (lazy) and holds a viewer while it is shown", () => {
    render(<TerminalHost><DesignerTerminal /></TerminalHost>);
    expect(useAppStore.getState().wantedStudios).toContain("designer");
    expect(useAppStore.getState().studioViewers.designer).toBe(1);
  });

  it("is inert with no <TerminalHost> ancestor (renders in isolation without crashing)", () => {
    expect(() => render(<DesignerTerminal />)).not.toThrow();
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument();
  });
});

describe("DesignsWorkbench always-on designer panel (#2597)", () => {
  it("docks the designer session in the studio's GraphCanvas from the first render, with no toggle button", () => {
    render(<TerminalHost><DesignsWorkbench /></TerminalHost>);
    const panel = screen.getByTestId("designer-terminal");
    expect(panel).toBeInTheDocument();
    expect(panel.style.display).not.toBe("none");
    expect(screen.queryByRole("button", { name: /Designer/ })).toBeNull();
    expect(panel.closest(".ds-graph")).toBeTruthy();
  });
});

describe("designer session survives a planner-tab switch (#2826, re-based on #3357)", () => {
  // The Design Studio is a Planner tab rendered through `KeptMountedPage`: switching planner tabs toggles
  // `active` (display: flex ↔ none) WITHOUT unmounting. Before #3357 the session's survival depended on
  // that mount surviving — a real unmount (the tear-off gate) killed the PTY. Now survival is owned by
  // TerminalHost, so BOTH a hide AND a full unmount leave the session running; only the idle reaper (or an
  // explicit End session) reclaims it. This asserts the new contract at both levels.
  it("releases only the VIEWER when the page is hidden — the session stays wanted (and warm)", () => {
    const { rerender, container } = render(
      <TerminalHost><KeptMountedPage active={true}><DesignerTerminal /></KeptMountedPage></TerminalHost>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.display).toBe("flex");
    expect(useAppStore.getState().studioViewers.designer).toBe(1);

    // Switch planner tabs: the page CSS-hides and the shell's page mode moves off "designs".
    showDesigns(false);
    rerender(<TerminalHost><KeptMountedPage active={false}><DesignerTerminal /></KeptMountedPage></TerminalHost>);
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument(); // still mounted, just hidden
    expect(useAppStore.getState().studioViewers.designer).toBe(0);       // …but no longer WATCHED
    expect(useAppStore.getState().wantedStudios).toContain("designer");  // session kept warm

    // Back to Designs: the same session is re-shown (never re-created).
    showDesigns(true);
    rerender(<TerminalHost><KeptMountedPage active={true}><DesignerTerminal /></KeptMountedPage></TerminalHost>);
    expect(useAppStore.getState().studioViewers.designer).toBe(1);
    expect(useAppStore.getState().wantedStudios).toEqual(["designer"]);
  });

  it("UNMOUNTING the dock no longer tears the session down — the terminal is the host's, not the dock's", () => {
    const { unmount } = render(<TerminalHost><DesignerTerminal /></TerminalHost>);
    expect(useAppStore.getState().wantedStudios).toContain("designer");
    unmount();
    // The old contract killed the PTY here (the tear-off gate case). The session now outlives the dock so
    // the Glance morph can still show it; reclamation is the reaper's job alone.
    expect(useAppStore.getState().studioViewers.designer).toBe(0);
    expect(useAppStore.getState().wantedStudios).toContain("designer");
  });
});
