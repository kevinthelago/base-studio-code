import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PaneShell } from "../../components/pane/PaneShell";

describe("PaneShell", () => {
  it("renders the agent name", () => {
    render(
      <PaneShell agent="my-agent">
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("my-agent")).toBeInTheDocument();
  });

  it("renders children", () => {
    render(
      <PaneShell agent="test">
        <div data-testid="child">inner content</div>
      </PaneShell>
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("calls onFocus when the pane is clicked", () => {
    const onFocus = vi.fn();
    render(
      <PaneShell agent="test" onFocus={onFocus}>
        <div>content</div>
      </PaneShell>
    );
    fireEvent.click(screen.getByText("test"));
    expect(onFocus).toHaveBeenCalled();
  });

  it("calls onMenuToggle when the menu button is clicked", () => {
    const onMenuToggle = vi.fn();
    render(
      <PaneShell agent="test" onMenuToggle={onMenuToggle}>
        <div>content</div>
      </PaneShell>
    );
    fireEvent.click(screen.getByTitle("Pane menu"));
    expect(onMenuToggle).toHaveBeenCalled();
  });

  it("calls onPickDirectory when the folder button is clicked", () => {
    const onPickDirectory = vi.fn();
    render(
      <PaneShell agent="test" onPickDirectory={onPickDirectory}>
        <div>content</div>
      </PaneShell>
    );
    fireEvent.click(screen.getByTitle("Open project directory"));
    expect(onPickDirectory).toHaveBeenCalled();
  });

  it("shows repo and branch when git info is provided", () => {
    render(
      <PaneShell agent="test" repo="my-repo" branch="main">
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("my-repo")).toBeInTheDocument();
  });

  it("shows dirty indicator when repo is dirty", () => {
    render(
      <PaneShell agent="test" repo="my-repo" branch="main" dirty={true}>
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("●")).toBeInTheDocument();
  });

  it("applies focused class when focused prop is true", () => {
    const { container } = render(
      <PaneShell agent="test" focused={true}>
        <div>content</div>
      </PaneShell>
    );
    expect(container.firstChild).toHaveClass("focused");
  });

  it("enters rename mode when agent name is clicked", () => {
    render(
      <PaneShell agent="my-agent">
        <div>content</div>
      </PaneShell>
    );
    fireEvent.click(screen.getByTitle("Click to rename"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
