import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolsView } from "./ToolsView";

describe("ToolsView (#1149)", () => {
  it("renders the role's capability posture from the role model", () => {
    render(<ToolsView role="director" />);
    expect(screen.getByText("ROLE · DIRECTOR")).toBeInTheDocument();
    // director: github write, git write, code none — the rows + their tiers show.
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText("git")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    // a director has no code writes
    expect(screen.getByText(/read-only role/)).toBeInTheDocument();
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
