import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectPane } from "../screens/projects/ProjectPane";

describe("ProjectPane (v4)", () => {
  it("renders the pane header and the section shells", () => {
    render(<ProjectPane />);
    expect(screen.getByText("Settlement webhooks v2")).toBeTruthy();
    expect(screen.getByText("Context Files")).toBeTruthy();
  });

  it("renders the repo-first structure (repo cards; first repo open shows its milestones)", () => {
    render(<ProjectPane />);
    // both repository cards are present as collapsible headers
    expect(screen.getByText("acme/payments")).toBeTruthy();
    expect(screen.getByText("acme/web-dashboard")).toBeTruthy();
    // the first repo is open by default -> its milestone is visible; the second
    // repo is collapsed, so its milestone is not rendered yet
    expect(screen.getByText("Publisher MVP")).toBeTruthy();
    expect(screen.queryByText("Dashboard live-update")).toBeNull();
  });

  it("renders the agents roster with the per-agent permission editor", () => {
    render(<ProjectPane />);
    expect(screen.getByText("@planner")).toBeTruthy();
    // the framer row is open by default -> its editor shows the capability labels
    expect(screen.getByText("read files")).toBeTruthy();
    expect(screen.getAllByText("allow").length).toBeGreaterThan(0);
  });
});
