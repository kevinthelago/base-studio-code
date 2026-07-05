import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlanceChatDock } from "./GlanceChatDock";

// xterm doesn't init in jsdom (term.open needs real DOM measurements), and the Logs tab polls `bsc` —
// so stub both to test the dock SHELL (header · tab switching · close · terminal mount/visibility).
vi.mock("@/app/console/panes/views/TerminalView", () => ({
  TerminalView: ({ paneId, visible }: { paneId: string; visible: boolean }) => (
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

  it("fires onClose from the close button", () => {
    const onClose = vi.fn();
    render(<GlanceChatDock paneId="proj:api" name="api-worker" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close stream" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
