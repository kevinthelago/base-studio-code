import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlanceChatDock } from "./GlanceChatDock";

// Since #2378 the dock renders a <TerminalSlot> (the app-level TerminalHost owns the real terminal) — stub
// it to test the dock SHELL (header · tab switching · close · terminal mount/visibility). Its visibility
// prop is what the dock controls, so the same data-pane/data-visible assertions hold.
vi.mock("@/app/console/terminal/TerminalSlot", () => ({
  TerminalSlot: ({ paneId, visible }: { paneId: string; visible: boolean }) => (
    <div data-testid="terminal" data-pane={paneId} data-visible={visible} />
  ),
}));
vi.mock("./GlanceSessionLog", () => ({
  GlanceSessionLog: ({ paneId }: { paneId: string }) => <div data-testid="logs" data-pane={paneId} />,
}));

describe("GlanceChatDock", () => {
  it("shows the agent name/role and the live stream by default", () => {
    render(<GlanceChatDock paneId="proj:api" name="api-worker" role="worker" onClose={() => {}} />);
    expect(screen.getByText("api-worker")).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    const term = screen.getByTestId("terminal");
    expect(term).toHaveAttribute("data-pane", "proj:api");
    expect(term).toHaveAttribute("data-visible", "true");
    expect(screen.queryByTestId("logs")).not.toBeInTheDocument();
  });

  it("switches to the Logs tab and HIDES (does not unmount) the terminal so the PTY survives", () => {
    render(<GlanceChatDock paneId="proj:api" name="api-worker" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(screen.getByTestId("logs")).toBeInTheDocument();
    // The terminal stays MOUNTED (its PTY reconnect isn't torn down), just hidden.
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-visible", "false");
  });

  it("fires onClose (collapse — agent stays alive) from the ✕ button", () => {
    const onClose = vi.fn();
    render(<GlanceChatDock paneId="proj:api" name="api-worker" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse stream (agent stays alive)" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the End-session button only when onEnd is given, and fires it (#3049)", () => {
    // No onEnd → collapse-only (the ✕); the kill affordance is absent.
    const { rerender } = render(<GlanceChatDock paneId="proj:api" name="api-worker" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
    // With onEnd → the End-session (kill) button appears and calls onEnd, distinct from onClose.
    const onEnd = vi.fn();
    rerender(<GlanceChatDock paneId="proj:api" name="api-worker" onClose={() => {}} onEnd={onEnd} />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("renders NO chat text-input — the terminal is the input surface (#3523)", () => {
    // A Claude CLI session types into its own TUI inside the terminal; the separate "message the agent"
    // box was a redundant second input. It is gone: no textbox, no Send.
    render(<GlanceChatDock paneId="proj:api" name="api-worker" onClose={() => {}} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByPlaceholderText(/Message the agent/)).toBeNull();
    // The terminal still fills the stream body.
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-visible", "true");
  });
});
