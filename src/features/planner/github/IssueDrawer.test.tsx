import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueDrawer } from "./IssueDrawer";
import type { BoardIssue } from "./projectBoard.types";

const issue: BoardIssue = {
  id: "I1",
  number: 99,
  title: "Design the drawer",
  body: "A longer body describing the work.",
  labels: [{ name: "ui", color: "5319e7" }],
  assignees: [{ login: "octocat" }],
  comments: 0,
  milestone: "v1.0.5",
  state: "OPEN",
};

describe("IssueDrawer", () => {
  it("renders the issue header, state, milestone and body", () => {
    render(<IssueDrawer issue={issue} onClose={() => {}} />);
    expect(screen.getByText("#99")).toBeTruthy();
    expect(screen.getByText("Design the drawer")).toBeTruthy();
    expect(screen.getByText(/●\s*open/)).toBeTruthy();  // the state chip specifically (not the "open on github"/"open in pane" buttons)
    expect(screen.getByText("v1.0.5")).toBeTruthy();
    expect(screen.getByText(/A longer body describing the work\./)).toBeTruthy();
    expect(screen.getByText("@octocat")).toBeTruthy();
  });

  it("shows the no-description placeholder when body is empty", () => {
    render(<IssueDrawer issue={{ ...issue, body: "" }} onClose={() => {}} />);
    expect(screen.getByText("No description.")).toBeTruthy();
  });

  it("fires onClose from the close button", () => {
    const onClose = vi.fn();
    render(<IssueDrawer issue={issue} onClose={onClose} />);
    fireEvent.click(screen.getByText("close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
