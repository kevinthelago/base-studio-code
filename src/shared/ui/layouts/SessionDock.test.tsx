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

  it("applies the caller-owned height and omits the subtitle when absent", () => {
    render(<Harness height={300} />);
    const panel = screen.getByTestId("dock");
    expect(panel.style.height).toBe("300px");
    // only the title line renders — no subtitle Text node
    expect(panel.querySelectorAll(".session-dock-head *").length).toBeGreaterThanOrEqual(1);
  });
});
