import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PaneShell } from "./PaneShell";

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

  it("no longer renders a directory button in the header", () => {
    render(
      <PaneShell agent="test">
        <div>content</div>
      </PaneShell>
    );
    expect(screen.queryByTitle("Open project directory")).not.toBeInTheDocument();
  });

  it("calls onPickDirectory from the menu's set-cwd action", () => {
    const onPickDirectory = vi.fn();
    render(
      <PaneShell agent="test" menuOpen onPickDirectory={onPickDirectory}>
        <div>content</div>
      </PaneShell>
    );
    fireEvent.click(screen.getByText("set cwd…"));
    expect(onPickDirectory).toHaveBeenCalled();
  });

  it("maximizes via the header toggle when in grid state", () => {
    const onToggleFullscreen = vi.fn();
    render(
      <PaneShell agent="test" onToggleFullscreen={onToggleFullscreen}>
        <div>content</div>
      </PaneShell>
    );
    expect(screen.queryByTitle("Minimize pane")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Maximize pane"));
    expect(onToggleFullscreen).toHaveBeenCalled();
  });

  it("shows the minimize toggle when already fullscreen", () => {
    const onToggleFullscreen = vi.fn();
    render(
      <PaneShell agent="test" fullscreen onToggleFullscreen={onToggleFullscreen}>
        <div>content</div>
      </PaneShell>
    );
    expect(screen.queryByTitle("Maximize pane")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Minimize pane"));
    expect(onToggleFullscreen).toHaveBeenCalled();
  });

  it("applies focused class when focused prop is true", () => {
    const { container } = render(
      <PaneShell agent="test" focused={true}>
        <div>content</div>
      </PaneShell>
    );
    expect(container.firstChild).toHaveClass("focused");
  });

  it("enters rename mode when the agent name is double-clicked", () => {
    render(
      <PaneShell agent="my-agent">
        <div>content</div>
      </PaneShell>
    );
    fireEvent.doubleClick(screen.getByTitle("Click to switch view; double-click to rename"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("opens the view-type dropdown when the agent name is clicked", () => {
    render(
      <PaneShell agent="my-agent">
        <div>content</div>
      </PaneShell>
    );
    fireEvent.click(screen.getByTitle("Click to switch view; double-click to rename"));
    // The dropdown lists the selectable views, each with its hotkey label.
    expect(screen.getByText("Alt+1")).toBeInTheDocument();
  });
});
