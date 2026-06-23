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

  it("no longer renders a standalone maximize button in the header (#1149 — it's in the menu)", () => {
    render(
      <PaneShell agent="test">
        <div>content</div>
      </PaneShell>
    );
    expect(screen.queryByTitle("Maximize pane")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Minimize pane")).not.toBeInTheDocument();
  });

  it("maximizes via the pane menu's maximize action", () => {
    const onToggleFullscreen = vi.fn();
    render(
      <PaneShell agent="test" menuOpen onToggleFullscreen={onToggleFullscreen}>
        <div>content</div>
      </PaneShell>
    );
    fireEvent.click(screen.getByText("maximize pane"));
    expect(onToggleFullscreen).toHaveBeenCalled();
  });

  it("shows the menu's minimize action when already fullscreen", () => {
    const onToggleFullscreen = vi.fn();
    render(
      <PaneShell agent="test" fullscreen menuOpen onToggleFullscreen={onToggleFullscreen}>
        <div>content</div>
      </PaneShell>
    );
    fireEvent.click(screen.getByText("minimize pane"));
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
    fireEvent.doubleClick(screen.getByTitle("Double-click to rename"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("opens the view-switcher dropdown from the ▾ button (#1149)", () => {
    render(
      <PaneShell agent="my-agent" active="console" available={["console", "files"]}>
        <div>content</div>
      </PaneShell>
    );
    // The view-switch button is titled "<current view> · switch screen".
    fireEvent.click(screen.getByTitle("Console · switch screen"));
    expect(screen.getByText("SWITCH SCREEN")).toBeInTheDocument();
    expect(screen.getByText("Alt+1")).toBeInTheDocument();
  });

  it("splits the view dropdown into SWITCH SCREEN + INSPECT groups (#1149)", () => {
    render(
      <PaneShell agent="my-agent" active="console" available={["console", "files", "tools"]}>
        <div>content</div>
      </PaneShell>
    );
    fireEvent.click(screen.getByTitle("Console · switch screen"));
    expect(screen.getByText("SWITCH SCREEN")).toBeInTheDocument();
    expect(screen.getByText("INSPECT")).toBeInTheDocument();
    expect(screen.getByText("Tools & permissions")).toBeInTheDocument();
  });

  it("renders the new header chrome: repo, role badge, harness/model pill, and footer state (#1149)", () => {
    render(
      <PaneShell agent="worker-A" repo="checkout" role="worker" provider="openai" model="sonnet-4.5" branch="wt/checkout" status="run">
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("· checkout")).toBeInTheDocument();
    expect(screen.getByText("WORKER")).toBeInTheDocument();       // role badge
    expect(screen.getByText("bsc-agent")).toBeInTheDocument();    // openai ⇒ bsc-agent harness
    expect(screen.getByText("sonnet-4.5")).toBeInTheDocument();   // model
    expect(screen.getByText("⎇ wt/checkout")).toBeInTheDocument();// footer branch
    expect(screen.getByText("running")).toBeInTheDocument();      // footer state
  });

  it("labels a claude-provider pane as the Claude Code harness", () => {
    render(
      <PaneShell agent="director" provider="claude" role="director">
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("DIRECTOR")).toBeInTheDocument();
  });
});
