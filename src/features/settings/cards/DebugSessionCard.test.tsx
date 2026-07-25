import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DebugSessionCard } from "./DebugSessionCard";
import { useAppStore } from "@/store";

describe("DebugSessionCard", () => {
  beforeEach(() => useAppStore.setState({ debugSession: false, autoSpawnDebugSessions: false }));

  it("shows both switches, and both start OFF", () => {
    render(<DebugSessionCard />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(2);
    for (const s of switches) expect(s).toHaveAttribute("aria-checked", "false");
  });

  it("toggles auto-spawn — the OUTER gate of the auto-spawn boundary (#3498)", () => {
    render(<DebugSessionCard />);
    // `ToggleRow` renders its switch with no accessible name (the title is sibling text), so the two
    // switches can only be told apart positionally. Assert the ORDER explicitly rather than trusting
    // an index silently: the auto-spawn row is second, after the graph-visibility row.
    expect(screen.getByText(/Show the debug session/i)).toBeInTheDocument();
    expect(screen.getByText(/start a debug session automatically/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("switch")[1]);
    expect(useAppStore.getState().autoSpawnDebugSessions).toBe(true);
    // …and it does not drag the unrelated visibility flag along with it.
    expect(useAppStore.getState().debugSession).toBe(false);
  });

  it("states in the UI that ONLY the debugger can be auto-spawned", () => {
    // The narrowness of this capability has to be legible where it is enabled, not only in code — a
    // toggle that reads as "let the app start sessions" would invite a far broader assumption than
    // the gate actually permits.
    render(<DebugSessionCard />);
    expect(screen.getByText(/only the/i)).toBeInTheDocument();
    expect(screen.getByText(/Off by default/i)).toBeInTheDocument();
  });
});
