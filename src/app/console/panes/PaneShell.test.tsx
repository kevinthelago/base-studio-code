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

  it("opens the consolidated menu from the compact trigger (#1181/#1319)", () => {
    const onMenuToggle = vi.fn();
    render(
      <PaneShell agent="test" onMenuToggle={onMenuToggle}>
        <div>content</div>
      </PaneShell>
    );
    // The compact glyph trigger is the single menu opener (the ⋯ button is gone).
    expect(screen.queryByTitle("Pane menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Model, screens & pane options"));
    expect(onMenuToggle).toHaveBeenCalled();
  });

  it("the menu trigger sits at the FAR LEFT of the header, before the agent name (#1319)", () => {
    render(
      <PaneShell agent="lead-agent">
        <div>content</div>
      </PaneShell>
    );
    const trigger = screen.getByTitle("Model, screens & pane options");
    const name = screen.getByText("lead-agent");
    // DOCUMENT_POSITION_FOLLOWING (4) ⇒ name comes AFTER the trigger in document order.
    expect(trigger.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders NO standalone status dot — liveness lives on the trigger glyph (#1319)", () => {
    const { container } = render(
      <PaneShell agent="test" status="run" claudeActive>
        <div>content</div>
      </PaneShell>
    );
    const header = container.querySelector(".pane > div") as HTMLElement;
    const trigger = screen.getByTitle("Model, screens & pane options");
    // The only header descendants that animate (pulse) belong to the trigger — there is no
    // separate leftmost status dot sibling.
    const pulsing = Array.from(header.querySelectorAll<HTMLElement>("*")).filter(
      (el) => el.style.animation && el.style.animation.includes("pulse")
    );
    expect(pulsing.length).toBeGreaterThan(0);
    expect(pulsing.every((el) => trigger.contains(el))).toBe(true);
  });

  it("the trigger glyph reflects the ACTIVE view + tints by status (#1319)", () => {
    // Live + a non-default active view ⇒ that view's icon, tinted accent (running).
    const { container, rerender } = render(
      <PaneShell agent="test" active="branches" available={["console", "branches"]} status="run" claudeActive>
        <div>content</div>
      </PaneShell>
    );
    const trigger = () => screen.getByTitle("Model, screens & pane options");
    let svg = trigger().querySelector("svg") as SVGElement;
    expect(svg.getAttribute("class") ?? "").toContain("lucide-git-branch"); // branches view glyph
    expect(svg.style.color).toBe("var(--accent)");                          // running ⇒ accent
    expect(svg.style.animation).toContain("pulse");                         // running ⇒ pulses

    // Idle console pane ⇒ console (terminal) glyph, the idle state color, no pulse.
    rerender(
      <PaneShell agent="test" active="console" available={["console", "branches"]} status="idle">
        <div>content</div>
      </PaneShell>
    );
    svg = trigger().querySelector("svg") as SVGElement;
    expect(svg.getAttribute("class") ?? "").toContain("lucide-terminal");
    expect(svg.style.color).toBe("var(--state-idle)");
    expect(svg.style.animation === "none" || svg.style.animation === "").toBe(true);
    expect(container).toBeTruthy();
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
    fireEvent.doubleClick(screen.getByTitle(/double-click to rename/));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("keeps repo + role badges in the header (#1319 — harness/model text removed)", () => {
    render(
      <PaneShell agent="worker-A" repo="checkout" role="worker" provider="openai" model="sonnet-4.5" claudeActive>
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("· checkout")).toBeInTheDocument();
    expect(screen.getByText("WORKER")).toBeInTheDocument();          // role badge
    // The header no longer spells out the harness or model — that moved into the menu (#1319).
    expect(screen.queryByText("bsc-agent")).not.toBeInTheDocument();
    expect(screen.queryByText("sonnet-4.5")).not.toBeInTheDocument();
    expect(screen.queryByText("undetected")).not.toBeInTheDocument();
  });

  it("surfaces the harness + provider inside the opened menu, not the header (#1319)", () => {
    render(
      <PaneShell agent="worker-A" provider="openai" model="sonnet-4.5" menuOpen claudeActive>
        <div>content</div>
      </PaneShell>
    );
    // openai ⇒ bsc-agent harness, now shown inside PaneMenu's header.
    expect(screen.getByText("bsc-agent")).toBeInTheDocument();
    // The configured model is offered as a row inside the menu (model selection lives there).
    expect(screen.getByText("sonnet-4.5")).toBeInTheDocument();
  });

  it("labels a claude-provider pane as the Claude Code harness inside the menu", () => {
    render(
      <PaneShell agent="director" provider="claude" role="director" menuOpen claudeActive>
        <div>content</div>
      </PaneShell>
    );
    expect(screen.getByText("Claude Code")).toBeInTheDocument();   // in the menu header
    expect(screen.getByText("DIRECTOR")).toBeInTheDocument();      // role badge (header)
  });
});
