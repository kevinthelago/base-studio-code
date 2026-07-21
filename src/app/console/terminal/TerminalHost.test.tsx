import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { TerminalHost } from "./TerminalHost";
import { TerminalSlot } from "./TerminalSlot";

// #2378 guardrail: there is exactly ONE <TerminalView> per paneId (one xterm, one PTY listener), owned by
// the host and RE-PARENTED between slots — never a second mount, never a remount on hand-off. xterm can't
// init in jsdom, so stub TerminalView with a probe that records every mount/unmount (keyed by paneId) and
// echoes its props; a stable mount count across a surface hand-off is proof the PTY is never torn down.
const rec = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }));
vi.mock("@/app/console/panes/views/TerminalView", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalView: ({ paneId, visible, initialCwd }: { paneId: string; visible?: boolean; initialCwd?: string }) => {
      useEffect(() => {
        rec.mounts.push(paneId);
        return () => { rec.unmounts.push(paneId); };
      }, [paneId]);
      return <div data-testid="tv" data-pane={paneId} data-visible={String(!!visible)} data-cwd={initialCwd ?? ""} />;
    },
  };
});

beforeEach(() => { rec.mounts.length = 0; rec.unmounts.length = 0; });

/** Console cell (primary) + optionally the Glance dock (viewer), both claiming the same agent's terminal. */
function Harness({ showDock, cellVisible = true }: { showDock: boolean; cellVisible?: boolean }) {
  return (
    <TerminalHost>
      <div data-testid="console-cell">
        <TerminalSlot paneId="proj:api" primary visible={cellVisible} initialCwd="/repo" />
      </div>
      {showDock && (
        <div data-testid="glance-dock">
          <TerminalSlot paneId="proj:api" visible />
        </div>
      )}
    </TerminalHost>
  );
}

describe("TerminalHost (#2378)", () => {
  it("mounts exactly one TerminalView for a paneId even with two slots claiming it", () => {
    const { getAllByTestId } = render(<Harness showDock />);
    // One primary + one viewer slot → still a single terminal.
    expect(getAllByTestId("tv")).toHaveLength(1);
    expect(rec.mounts).toEqual(["proj:api"]);
  });

  it("re-parents the SAME terminal node into whichever slot owns it — no remount on hand-off", () => {
    const { getByTestId, rerender } = render(<Harness showDock={false} />);
    const tv = getByTestId("tv");
    // Only the console cell claims it → the terminal lives inside the console cell.
    expect(tv.closest("[data-testid='console-cell']")).toBeTruthy();
    expect(tv.closest("[data-testid='glance-dock']")).toBeFalsy();

    // Open the dock: the dock becomes the owner and the terminal moves into it…
    rerender(<Harness showDock />);
    expect(getByTestId("tv")).toBe(tv);                                   // same DOM node — moved, not recreated
    expect(tv.closest("[data-testid='glance-dock']")).toBeTruthy();
    expect(tv.closest("[data-testid='console-cell']")).toBeFalsy();

    // …close the dock: ownership falls back to the console cell, terminal returns there.
    rerender(<Harness showDock={false} />);
    expect(getByTestId("tv")).toBe(tv);
    expect(tv.closest("[data-testid='console-cell']")).toBeTruthy();

    // Across the whole hand-off the terminal mounted once and never unmounted — the PTY survived.
    expect(rec.mounts).toEqual(["proj:api"]);
    expect(rec.unmounts).toEqual([]);
  });

  it("sources launch props from the primary but visibility from the current owner", () => {
    // Console cell is hidden (a background view) while the dock owns + shows the terminal.
    const { getByTestId } = render(<Harness showDock cellVisible={false} />);
    const tv = getByTestId("tv");
    expect(tv.getAttribute("data-cwd")).toBe("/repo");      // primary (console) supplies initialCwd
    expect(tv.getAttribute("data-visible")).toBe("true");   // owner (dock) supplies visibility
  });

  it("tears the terminal down only when its LAST slot unmounts (parks otherwise)", () => {
    const { queryByTestId, rerender } = render(<Harness showDock />);
    // Dropping the dock leaves the console claim → terminal stays alive.
    rerender(<Harness showDock={false} />);
    expect(queryByTestId("tv")).toBeTruthy();
    expect(rec.unmounts).toEqual([]);

    // Dropping the console cell too (no slots left) → the terminal finally unmounts.
    rerender(
      <TerminalHost>
        <div data-testid="empty" />
      </TerminalHost>,
    );
    expect(queryByTestId("tv")).toBeFalsy();
    expect(rec.unmounts).toEqual(["proj:api"]);
  });
});

// #3357: the app-owned session mounts (DebugSessionMount / StudioSessionMount) are off-screen HOLDING
// claims that exist only to keep the PTY alive. Their cwd resolves ASYNC, so they can register AFTER a
// visible dock — under plain "last claim wins" that would silently park a terminal the user is looking at
// off-screen. `parked` makes such a claim own the terminal only when it is the last one standing.
describe("TerminalHost parked holding claims (#3357)", () => {
  /** A studio: a visible page dock plus the off-screen holding mount, in either registration order.
   *  `dockOpen` closes the dock while KEEPING the holding mount's element identity (same key), which is
   *  the real app's shape — `StudioSessionHosts` stays mounted in App.tsx for the session's whole life
   *  while the page dock and the Glance morph come and go. Re-rendering a differently-shaped tree here
   *  would unmount/remount the holding div, briefly dropping the pane to ZERO claims and making the host
   *  tear the terminal down — which would test React's reconciler, not the parked-ownership rule. */
  function StudioHarness({ mountFirst, dockOpen = true }: { mountFirst: boolean; dockOpen?: boolean }) {
    const mount = <div key="m" data-testid="holding"><TerminalSlot paneId="design-studio:designer" primary parked visible={false} initialCwd="/design" /></div>;
    const dock = <div key="d" data-testid="page-dock"><TerminalSlot paneId="design-studio:designer" visible /></div>;
    const both = mountFirst ? [mount, dock] : [dock, mount];
    return <TerminalHost>{dockOpen ? both : [mount]}</TerminalHost>;
  }

  it("never takes ownership from a visible surface, whichever registered first", () => {
    for (const mountFirst of [true, false]) {
      const { getByTestId, unmount } = render(<StudioHarness mountFirst={mountFirst} />);
      const tv = getByTestId("tv");
      expect(tv.closest("[data-testid='page-dock']")).toBeTruthy();
      expect(tv.getAttribute("data-visible")).toBe("true");   // the dock's visibility, not the mount's
      expect(tv.getAttribute("data-cwd")).toBe("/design");    // launch props still come from the primary
      unmount();
    }
  });

  // #3427 regression. The page dock calls `openStudio` and renders its viewer slot in the SAME commit,
  // while the holding mount only appears once an async `setup_*_workspace` invoke resolves — so the dock
  // ALWAYS claimed first. With no primary to source from, the host fell back to the owner's (empty) launch
  // props and TerminalView launched with cwd/initCmd undefined. That is a one-shot launch, so the primary
  // arriving a tick later never repaired it: `pty_create` ran with `cwd=<none>`, the session inherited the
  // app's own working directory instead of the studio workspace, and `ensure_session_settings` was skipped
  // entirely — a permission-less session with no role gate.
  it("does NOT launch an app-owned session before its holding mount claims it (#3427)", () => {
    // ONE tree whose only change is the mount appearing — the real sequence, since `StudioSessionHosts`
    // renders alongside the page for the session's whole life and the mount's own slot is what arrives late.
    const Opening = ({ mounted }: { mounted: boolean }) => (
      <TerminalHost>
        <div key="d" data-testid="page-dock"><TerminalSlot paneId="design-studio:designer" visible /></div>
        {mounted && <div key="m" data-testid="holding"><TerminalSlot paneId="design-studio:designer" primary parked visible={false} initialCwd="/design" /></div>}
      </TerminalHost>
    );
    // First commit: the dock has claimed, the mount's async setup has not resolved. No terminal yet —
    // crucially NOT one launched with an empty cwd.
    const { queryByTestId, rerender } = render(<Opening mounted={false} />);
    expect(queryByTestId("tv")).toBeFalsy();
    expect(rec.mounts).toEqual([]);

    // The mount resolves its workspace dir and registers: NOW the session launches, with its real cwd,
    // into the dock the user is already looking at.
    rerender(<Opening mounted />);
    expect(rec.mounts).toEqual(["design-studio:designer"]);
    const tv = queryByTestId("tv")!;
    expect(tv.getAttribute("data-cwd")).toBe("/design");
    expect(tv.closest("[data-testid='page-dock']")).toBeTruthy();
  });

  it("still launches a FLEET pane from a viewer-only claim — the gate is app-owned ids only (#3427)", () => {
    // A fleet pane's primary is its console grid cell, which legitimately may never mount while Glance
    // shows the terminal. Gating it would hide a working session, so the gate must not reach it.
    render(
      <TerminalHost>
        <div data-testid="glance-dock"><TerminalSlot paneId="proj:api" visible /></div>
      </TerminalHost>,
    );
    expect(rec.mounts).toEqual(["proj:api"]);
  });

  it("owns the terminal (parked, off-screen) once it is the last claim standing", () => {
    const { getByTestId, rerender } = render(<StudioHarness mountFirst />);
    const tv = getByTestId("tv");
    rerender(<StudioHarness mountFirst dockOpen={false} />);
    // The dock closed (page switch / morph close): the SAME terminal parks in the holding mount — not
    // torn down, which is what keeps the session warm for the Glance morph.
    expect(getByTestId("tv")).toBe(tv);
    expect(tv.closest("[data-testid='holding']")).toBeTruthy();
    expect(tv.getAttribute("data-visible")).toBe("false"); // parked ⇒ the mount's visibility now applies
    expect(rec.unmounts).toEqual([]);
  });
});
