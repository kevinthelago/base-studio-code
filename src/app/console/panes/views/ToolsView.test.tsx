import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolsView } from "./ToolsView";

describe("ToolsView (#1149)", () => {
  it("renders the role's capability posture from the role model", () => {
    render(<ToolsView role="director" />);
    expect(screen.getByText("ROLE · DIRECTOR")).toBeInTheDocument();
    // director: github read, git read, code write scoped to the plan globs — the rows + tiers show.
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText("git")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    // It carries the PLANNING write surface, so it is not a read-only role — its writes are the
    // plan files, and the pane shows those globs rather than the read-only note.
    expect(screen.queryByText(/read-only role/)).toBeNull();
    expect(screen.getByText("discovery/*")).toBeInTheDocument();
  });

  it("shows a worker's read-only github + the owned-globs note", () => {
    render(<ToolsView role="worker" />);
    expect(screen.getByText("ROLE · WORKER")).toBeInTheDocument();
    expect(screen.getByText(/owned globs only/)).toBeInTheDocument();
  });

  it("falls back to an interactive-console note when no role is assigned", () => {
    render(<ToolsView />);
    expect(screen.getByText(/no least-privilege role applied/)).toBeInTheDocument();
  });
});
