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
  /** A studio: a visible page dock plus the off-screen holding mount, in either registration order. */
  function StudioHarness({ mountFirst }: { mountFirst: boolean }) {
    const mount = <div key="m" data-testid="holding"><TerminalSlot paneId="design-studio:designer" primary parked visible={false} initialCwd="/design" /></div>;
    const dock = <div key="d" data-testid="page-dock"><TerminalSlot paneId="design-studio:designer" visible /></div>;
    return <TerminalHost>{mountFirst ? [mount, dock] : [dock, mount]}</TerminalHost>;
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

  it("owns the terminal (parked, off-screen) once it is the last claim standing", () => {
    const { getByTestId, rerender } = render(<StudioHarness mountFirst />);
    const tv = getByTestId("tv");
    rerender(
      <TerminalHost>
        <div data-testid="holding"><TerminalSlot paneId="design-studio:designer" primary parked visible={false} initialCwd="/design" /></div>
      </TerminalHost>,
    );
    // The dock closed (page switch / morph close): the SAME terminal parks in the holding mount — not
    // torn down, which is what keeps the session warm for the Glance morph.
    expect(getByTestId("tv")).toBe(tv);
    expect(tv.closest("[data-testid='holding']")).toBeTruthy();
    expect(rec.unmounts).toEqual([]);
  });
});
