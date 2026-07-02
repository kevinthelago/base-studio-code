import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WriteBar } from "./WriteBar";

function baseProps() {
  return {
    writeStatus: "idle" as "idle" | "ok" | "error",
    writeMsg: "",
    reading: false,
    writing: false,
    setReadTick: vi.fn(),
    handleWrite: vi.fn(),
  };
}

describe("WriteBar", () => {
  it("renders the idle hint and both action buttons", () => {
    render(<WriteBar {...baseProps()} />);
    expect(screen.getByText("CLAUDE.md and .claude/settings.json")).toBeInTheDocument();
    expect(screen.getByText("↺ read from disk")).toBeInTheDocument();
    expect(screen.getByText("↓ write to disk")).toBeInTheDocument();
  });

  it("shows the success and error messages by status", () => {
    const { rerender } = render(<WriteBar {...baseProps()} writeStatus="ok" writeMsg="Written to disk." />);
    expect(screen.getByText(/Written to disk\./)).toBeInTheDocument();
    rerender(<WriteBar {...baseProps()} writeStatus="error" writeMsg="boom" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("bumps the read tick and triggers a write on click", () => {
    const props = baseProps();
    render(<WriteBar {...props} />);
    fireEvent.click(screen.getByText("↺ read from disk"));
    expect(props.setReadTick).toHaveBeenCalled();
    fireEvent.click(screen.getByText("↓ write to disk"));
    expect(props.handleWrite).toHaveBeenCalled();
  });
});
