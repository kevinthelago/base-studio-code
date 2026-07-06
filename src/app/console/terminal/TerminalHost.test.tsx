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
