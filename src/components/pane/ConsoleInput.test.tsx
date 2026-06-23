import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConsoleInput } from "./ConsoleInput";

describe("ConsoleInput (#1149)", () => {
  it("renders nothing when no Claude session is active", () => {
    const { container } = render(<ConsoleInput active={false} onSend={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the prompt when a Claude session is active", () => {
    render(<ConsoleInput active onSend={vi.fn()} />);
    expect(screen.getByPlaceholderText(/Message the agent/)).toBeInTheDocument();
    expect(screen.getByText("send ⏎")).toBeInTheDocument();
  });

  it("sends the typed text + CR and clears on Enter", () => {
    const onSend = vi.fn();
    render(<ConsoleInput active onSend={onSend} />);
    const input = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "run the tests" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("run the tests\r");
    expect(input.value).toBe("");
  });

  it("inserts a newline on Shift+Enter instead of submitting", () => {
    const onSend = vi.fn();
    render(<ConsoleInput active onSend={onSend} />);
    const input = screen.getByPlaceholderText(/Message the agent/);
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled(); // the textarea inserts the newline; no submit
  });

  it("sends multi-line text as a bracketed paste so newlines don't submit early", () => {
    const onSend = vi.fn();
    render(<ConsoleInput active onSend={onSend} />);
    const input = screen.getByPlaceholderText(/Message the agent/);
    fireEvent.change(input, { target: { value: "first\nsecond" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("\x1b[200~first\nsecond\x1b[201~\r");
  });

  it("sends via the send button too", () => {
    const onSend = vi.fn();
    render(<ConsoleInput active onSend={onSend} />);
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: "hi" } });
    fireEvent.click(screen.getByText("send ⏎"));
    expect(onSend).toHaveBeenCalledWith("hi\r");
  });

  it("forwards Escape (ESC) and an empty-input Ctrl+C (SIGINT) to the PTY", () => {
    const onSend = vi.fn();
    render(<ConsoleInput active onSend={onSend} />);
    const input = screen.getByPlaceholderText(/Message the agent/);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSend).toHaveBeenCalledWith("\x1b");
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith("\x03");
  });

  it("does not intercept Ctrl+C when there is text to copy", () => {
    const onSend = vi.fn();
    render(<ConsoleInput active onSend={onSend} />);
    const input = screen.getByPlaceholderText(/Message the agent/);
    fireEvent.change(input, { target: { value: "keep me" } });
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(onSend).not.toHaveBeenCalledWith("\x03");
  });
});
