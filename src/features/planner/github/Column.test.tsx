import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Column } from "./Column";
import type { BoardColumn, BoardIssue } from "./projectBoard.types";

const col: BoardColumn = { id: "todo", name: "To do", color: "var(--fg-dim)" };

const issue: BoardIssue = {
  id: "I1",
  number: 7,
  title: "Wire the board",
  body: "",
  labels: [],
  assignees: [],
  comments: 0,
  milestone: null,
  state: "OPEN",
};

describe("Column", () => {
  it("renders the column name, count and its issue cards", () => {
    render(<Column col={col} issues={[issue]} onIssueClick={() => {}} />);
    expect(screen.getByText("To do")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("Wire the board")).toBeTruthy();
    expect(screen.getByText("+ new card")).toBeTruthy();
  });

  it("passes the issue number to onIssueClick when a card is clicked", () => {
    const onIssueClick = vi.fn();
    render(<Column col={col} issues={[issue]} onIssueClick={onIssueClick} />);
    fireEvent.click(screen.getByText("Wire the board"));
    expect(onIssueClick).toHaveBeenCalledWith(7);
  });
});
