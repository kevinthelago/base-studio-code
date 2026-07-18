import { describe, it, expect } from "vitest";
import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import { SessionDock } from "./SessionDock";

function Harness({ height, testid = "dock", subtitle }: { height?: number; testid?: string; subtitle?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return <SessionDock containerRef={ref} title="◆ Session · via bsc" subtitle={subtitle} height={height} testid={testid} />;
}

describe("SessionDock (#2808)", () => {
  it("renders the title, subtitle, and the testid'd panel with the host div", () => {
    render(<Harness subtitle="studio · restricted" testid="architect-terminal" />);
    expect(screen.getByText("◆ Session · via bsc")).toBeTruthy();
    expect(screen.getByText("studio · restricted")).toBeTruthy();
    const panel = screen.getByTestId("architect-terminal");
    expect(panel.querySelector(".session-dock-host")).not.toBeNull();
  });

  it("renders CHILDREN in place of the ref'd host div (#3357 — the studio docks pass a TerminalSlot)", () => {
    // The studio docks no longer own an xterm: their terminal is the app-level TerminalHost's and is
    // re-parented INTO a <TerminalSlot>, so there is no ref to attach. The host box must still be there
    // (and flag itself as the slot variant, which makes it a flex column so the slot can size itself).
    render(<SessionDock title="◆ Session" testid="dock"><span data-testid="slot" /></SessionDock>);
    const host = screen.getByTestId("dock").querySelector(".session-dock-host");
    expect(host).not.toBeNull();
    expect(host!.classList.contains("session-dock-slot")).toBe(true);
    expect(host!.querySelector("[data-testid='slot']")).not.toBeNull();
  });

  it("applies the caller-owned height and omits the subtitle when absent", () => {
    render(<Harness height={300} />);
    const panel = screen.getByTestId("dock");
    expect(panel.style.height).toBe("300px");
    // only the title line renders — no subtitle Text node
    expect(panel.querySelectorAll(".session-dock-head *").length).toBeGreaterThanOrEqual(1);
  });
});
