import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title, description, icon, and fires action clicks", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        icon="⌕"
        title="No skills match"
        description="Nothing matches the active filters."
        actions={<button onClick={onClick}>Clear filters</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No skills match" })).toBeInTheDocument();
    expect(screen.getByText("Nothing matches the active filters.")).toBeInTheDocument();
    expect(screen.getByText("⌕")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("omits the icon, description, and actions when not provided", () => {
    render(<EmptyState title="No automations yet" />);
    expect(screen.getByRole("heading", { name: "No automations yet" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders extra content (e.g. a scopes box) below the body", () => {
    render(
      <EmptyState
        variant="card"
        title="GitHub not connected"
        extra={<div data-testid="scopes">repo · project</div>}
      />,
    );
    expect(screen.getByTestId("scopes")).toBeInTheDocument();
  });
});
