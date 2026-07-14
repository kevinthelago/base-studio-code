import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SoundsWorkspace } from "./SoundsWorkspace";

// jsdom has no Web Audio, so playCue is a no-op there anyway — mock it to assert the click WIRING
// (which cue got played) without needing a real AudioContext.
vi.mock("./lib/synth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/synth")>();
  return { ...actual, playCue: vi.fn(() => 0.2) };
});
import { playCue } from "./lib/synth";

describe("SoundsWorkspace (#3072)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the starter kit's cues grouped by category", () => {
    render(<SoundsWorkspace />);
    expect(screen.getByText("Signal kit")).toBeInTheDocument();
    expect(screen.getByText("Click")).toBeInTheDocument();
    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(screen.getByText("UI feedback")).toBeInTheDocument();      // a category header
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  it("synthesizes the cue when its card is clicked", () => {
    render(<SoundsWorkspace />);
    fireEvent.click(screen.getByText("Click"));
    expect(playCue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(playCue).mock.calls[0][0].id).toBe("click");
  });
});
