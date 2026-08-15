import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DesignerTerminal } from "@/features/designs/DesignerTerminal";
import { DesignsWorkbench } from "./DesignsWorkbench";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { KeptMountedPage } from "@/app/KeptMountedPage";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
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
  // #3427 — an app-owned studio session must NOT create its terminal until the mount that supplies its
  // launch props has claimed the pane. Without that gate the viewer registered first, `TerminalView`
  // mounted with `initialCwd`/`initCmd` undefined, and the one-shot `pty_create` ran in the app's own
  // directory: no spec CLAUDE.md, no `--continue`, no persona kickoff, and — because
  // `ensure_session_settings` skips an empty cwd — NO ROLE GATE. So the dock alone claiming the pane is
  // the bug, not the contract; these two tests pin both halves of it.
  it("does NOT create the terminal from the dock alone — it waits for the session mount (#3427)", () => {
    const { container } = render(<TerminalHost><DesignerTerminal tech="react" /></TerminalHost>);
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toEqual([]);
  });

  it("claims the designer's stable pane id once the session mount supplies the launch props (#3427)", () => {
    const { container } = render(
      <TerminalHost>
        {/* Stands in for StudioSessionMount: the PRIMARY claim carrying cwd/initCmd. */}
        <TerminalSlot paneId={STUDIO_SESSIONS.designerReact.paneId} primary parked visible={false} initialCwd="/tmp/designer" />
        <DesignerTerminal tech="react" />
      </TerminalHost>,
    );
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toContain(STUDIO_SESSIONS.designerReact.paneId);
  });

  it("opening the page STARTS the session (lazy) and holds a viewer while it is shown", () => {
    render(<TerminalHost><DesignerTerminal tech="react" /></TerminalHost>);
    expect(useAppStore.getState().wantedStudios).toContain("designerReact");
    expect(useAppStore.getState().studioViewers.designerReact).toBe(1);
  });

  it("is inert with no <TerminalHost> ancestor (renders in isolation without crashing)", () => {
    expect(() => render(<DesignerTerminal tech="react" />)).not.toThrow();
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument();
  });
});

describe("DesignsWorkbench always-on designer panel (#2597)", () => {
  // The toggle #2597 deleted (5c6bc19b) was an ACTION-BAR control:
  //
  //     <Box as="button" className="ds-act" aria-expanded={designerOpen} onClick={toggleDesigner}>✦ Designer</Box>
  //
  // This case used to pin its absence with `queryByRole("button", { name: /Designer/ })` over the whole
  // page. That went red — not because the toggle came back, but because the MIGRATION worked: the dock and
  // its banner became graph records (`designerterminal.json`, `designerloopbanner.json`), so the studio's
  // own component rail now lists them BY NAME and two `.ds-comprow` rows match `/Designer/`. A name regex
  // over every button cannot tell a control from a catalogue entry, and the catalogue is exactly what this
  // studio is for — every component migrated from here will keep widening the collision.
  //
  // So assert the SHAPE instead of the count: a button named "Designer…" is allowed to exist as long as it
  // is a rail row. Re-add the toggle and it is a `.ds-act`, not a `.ds-comprow`, and this fails again —
  // which an id/name allow-list of the two colliding records would NOT have caught.
  // Cost note: this is the only case here that renders the WHOLE workbench, and the component rail is not
  // virtualised — one row per record. Against the full seed (382 and climbing, since turning files into
  // records is the point) it takes ~4-7s in jsdom: inside the 5s limit ALONE, over it under full-suite
  // load. That is why this file once passed 7/7 in a worktree and still reported FAIL at the repo root.
  // Raising the timeout would buy a few hundred records and then fail again with a less obvious cause, so
  // seed a representative slice and keep the cost constant — including the Designer-named records, without
  // which the assertion below passes vacuously.
  const railSample = () => {
    const designer = SEED_COMPONENTS.filter((c) => /Designer/.test(c.name));
    expect(designer.length).toBeGreaterThan(1); // the collision is the point; a seed without it proves nothing
    return [...designer, ...SEED_COMPONENTS.filter((c) => !/Designer/.test(c.name)).slice(0, 5)];
  };

  it("docks the designer session in the studio's GraphCanvas from the first render, with no toggle button", () => {
    useAppStore.setState({ components: railSample() });
    render(<TerminalHost><DesignsWorkbench /></TerminalHost>);
    const panel = screen.getByTestId("designer-terminal");
    expect(panel).toBeInTheDocument();
    expect(panel.style.display).not.toBe("none");
    for (const button of screen.queryAllByRole("button", { name: /Designer/ })) {
      expect(button.className).toContain("ds-comprow");
    }
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
      <TerminalHost><KeptMountedPage active={true}><DesignerTerminal tech="react" /></KeptMountedPage></TerminalHost>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.display).toBe("flex");
    expect(useAppStore.getState().studioViewers.designerReact).toBe(1);

    // Switch planner tabs: the page CSS-hides and the shell's page mode moves off "designs".
    showDesigns(false);
    rerender(<TerminalHost><KeptMountedPage active={false}><DesignerTerminal tech="react" /></KeptMountedPage></TerminalHost>);
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument(); // still mounted, just hidden
    expect(useAppStore.getState().studioViewers.designerReact).toBe(0);       // …but no longer WATCHED
    expect(useAppStore.getState().wantedStudios).toContain("designerReact");  // session kept warm

    // Back to Designs: the same session is re-shown (never re-created).
    showDesigns(true);
    rerender(<TerminalHost><KeptMountedPage active={true}><DesignerTerminal tech="react" /></KeptMountedPage></TerminalHost>);
    expect(useAppStore.getState().studioViewers.designerReact).toBe(1);
    expect(useAppStore.getState().wantedStudios).toEqual(["designerReact"]);
  });

  it("UNMOUNTING the dock no longer tears the session down — the terminal is the host's, not the dock's", () => {
    const { unmount } = render(<TerminalHost><DesignerTerminal tech="react" /></TerminalHost>);
    expect(useAppStore.getState().wantedStudios).toContain("designerReact");
    unmount();
    // The old contract killed the PTY here (the tear-off gate case). The session now outlives the dock so
    // the Glance morph can still show it; reclamation is the reaper's job alone.
    expect(useAppStore.getState().studioViewers.designerReact).toBe(0);
    expect(useAppStore.getState().wantedStudios).toContain("designerReact");
  });

  // #system-sessions-are-per-technology — the dock FOLLOWS the workbench's selected KIT's technology
  // (the component store carries `tech` on the kit, one level up from the algorithms graph), and only
  // the ACTIVE technology's session is started.
  it("starts the session for the kit technology it is given, and no other", () => {
    render(<TerminalHost><DesignerTerminal tech="react-native" /></TerminalHost>);
    const st = useAppStore.getState();
    expect(st.wantedStudios).toEqual(["designerReactNative"]);
    expect(st.studioViewers.designerReact ?? 0).toBe(0);
  });

  it("switching kit technology starts the new one and releases the old", () => {
    const { rerender } = render(<TerminalHost><DesignerTerminal tech="react" /></TerminalHost>);
    expect(useAppStore.getState().studioViewers.designerReact).toBe(1);

    rerender(<TerminalHost><DesignerTerminal tech="react-native" /></TerminalHost>);
    const st = useAppStore.getState();
    expect(st.studioViewers.designerReactNative).toBe(1);
    // Zero viewers ARMS the reaper; it stays WANTED, so switching back reattaches to the same session.
    expect(st.studioViewers.designerReact).toBe(0);
    expect(st.wantedStudios).toContain("designerReact");
  });

  it("shows an EMPTY dock for a kit whose technology has no designer", () => {
    // A user-authored kit may declare no `tech` at all (the field is optional), which must not fall
    // back to the react designer — a wrong-but-populated dock looks like it is working.
    const { container } = render(<TerminalHost><DesignerTerminal tech="" /></TerminalHost>);
    expect(screen.getByTestId("designer-terminal")).toBeInTheDocument();
    expect(claimedPanes(container)).toEqual([]);
    expect(useAppStore.getState().wantedStudios).toEqual([]);
  });
});
