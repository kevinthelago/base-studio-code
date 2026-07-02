import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueCard } from "./IssueCard";
import type { BoardIssue } from "./projectBoard.types";

const baseIssue: BoardIssue = {
  id: "I1",
  number: 42,
  title: "Add export endpoint",
  body: "",
  labels: [{ name: "enhancement", color: "0e8a16" }],
  assignees: [{ login: "octocat" }],
  comments: 3,
  milestone: "v1.0.4",
  state: "OPEN",
};

describe("IssueCard", () => {
  it("renders the issue number, title, milestone, labels and comment count", () => {
    render(<IssueCard issue={baseIssue} />);
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("Add export endpoint")).toBeTruthy();
    expect(screen.getByText("v1.0.4")).toBeTruthy();
    expect(screen.getByText("enhancement")).toBeTruthy();
    expect(screen.getByText(/💬 3/)).toBeTruthy();
  });

  it("shows a placeholder when there are no assignees", () => {
    render(<IssueCard issue={{ ...baseIssue, assignees: [] }} />);
    expect(screen.getByText("?")).toBeTruthy();
  });

  it("fires onClick when the card is clicked", () => {
    const onClick = vi.fn();
    render(<IssueCard issue={baseIssue} onClick={onClick} />);
    fireEvent.click(screen.getByText("Add export endpoint"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
