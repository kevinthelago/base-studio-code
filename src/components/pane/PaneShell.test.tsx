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

  it("opens the consolidated menu from the model button (#1181)", () => {
    const onMenuToggle = vi.fn();
    render(
      <PaneShell agent="test" onMenuToggle={onMenuToggle}>
        <div>content</div>
      </PaneShell>
    );
    // The model pill is now the single menu trigger (the ⋯ button is gone).
    expect(screen.queryByTitle("Pane menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Model, screens & pane options"));
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

  it("a RUNNING pane shows the harness + model in the pill (#1181)", () => {
    render(
      <PaneShell agent="worker-A" repo="checkout" role="worker" provider="openai" model="sonnet-4.5" claudeActive>
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("· checkout")).toBeInTheDocument();
    expect(screen.getByText("WORKER")).toBeInTheDocument();       // role badge
    expect(screen.getByText("bsc-agent")).toBeInTheDocument();    // openai ⇒ bsc-agent harness
    expect(screen.getByText("sonnet-4.5")).toBeInTheDocument();   // running model
    expect(screen.queryByText("undetected")).not.toBeInTheDocument();
  });

  it("prefers the actual runningModel from the CLI over the configured one (#1181)", () => {
    render(
      <PaneShell agent="worker-A" provider="claude" model="sonnet-4.5" runningModel="opus-4.5" claudeActive>
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("opus-4.5")).toBeInTheDocument();      // transcript-reported model wins
    expect(screen.queryByText("sonnet-4.5")).not.toBeInTheDocument();
  });

  it("an IDLE pane shows the CONFIGURED model in the pill (not 'undetected') (#…)", () => {
    render(
      <PaneShell agent="worker-A" repo="checkout" role="worker" provider="openai" model="sonnet-4.5" branch="wt/checkout" status="run">
        <div>content</div>
      </PaneShell>
    );
    // The chosen model is always legible — shown even when no live session is detected.
    expect(screen.getByText("sonnet-4.5")).toBeInTheDocument();
    expect(screen.queryByText("undetected")).not.toBeInTheDocument();
    expect(screen.getByText("· checkout")).toBeInTheDocument(); // repo still shown in the header
    // The footer was removed entirely (#1181) — no branch/state strip.
    expect(screen.queryByText("⎇ wt/checkout")).not.toBeInTheDocument();
  });

  it("labels a claude-provider pane as the Claude Code harness when running", () => {
    render(
      <PaneShell agent="director" provider="claude" role="director" claudeActive>
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("DIRECTOR")).toBeInTheDocument();
  });
});
