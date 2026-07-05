import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlanceChatDock } from "./GlanceChatDock";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";

// xterm doesn't init in jsdom (term.open needs real DOM measurements), and the Logs tab polls `bsc` —
// so stub both to test the dock SHELL (header · tab switching · close · terminal mount/visibility · chat input).
vi.mock("@/app/console/panes/views/TerminalView", () => ({
  TerminalView: ({ paneId, visible }: { paneId: string; visible: boolean }) => (
    <div data-testid="terminal" data-pane={paneId} data-visible={visible} />
  ),
}));
vi.mock("./GlanceSessionLog", () => ({
  GlanceSessionLog: ({ paneId }: { paneId: string }) => <div data-testid="logs" data-pane={paneId} />,
}));
vi.mock("@/shared/lib/core/safeInvoke", () => ({ fireInvoke: vi.fn() }));

describe("GlanceChatDock", () => {
  beforeEach(() => vi.clearAllMocks());
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

  it("sends a chat message to the agent's PTY via the Send button (pty_write + Enter)", () => {
    render(<GlanceChatDock paneId="proj:api" name="api-worker" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: "run the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(fireInvoke).toHaveBeenCalledWith("pty_write", { paneId: "proj:api", data: "run the tests\r" }, expect.anything());
  });

  it("sends on Enter and clears the input; a blank message is a no-op", () => {
    render(<GlanceChatDock paneId="proj:api" name="api-worker" onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/Message the agent/) as HTMLInputElement;
    // Blank → Send is disabled and Enter does nothing.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fireInvoke).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fireInvoke).toHaveBeenCalledWith("pty_write", { paneId: "proj:api", data: "hi\r" }, expect.anything());
    expect(input.value).toBe("");
  });
});
