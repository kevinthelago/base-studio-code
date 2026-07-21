import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SoundsWorkspace } from "./SoundsWorkspace";

// jsdom has no Web Audio, so playCue is a no-op there anyway — mock it to assert the click WIRING
// (which cue got played) without needing a real AudioContext.
vi.mock("./lib/synth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/synth")>();
  return { ...actual, playCue: vi.fn(() => 0.2) };
});
import { playCue } from "./lib/synth";

// The page rides the shared GraphCanvas + useGraphViewport (pan/zoom), which need rAF + ResizeObserver.
beforeAll(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

describe("SoundsWorkspace (#3077 — composition graph)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the kit's composition graph — a node per primitive, voice, and cue", () => {
    const { container } = render(<SoundsWorkspace />);
    // 5 primitives + 7 voices + 5 cues = 17 nodes.
    expect(container.querySelectorAll(".snd-node")).toHaveLength(17);
    // A primitive reads distinctly (dashed violet descriptor), like the Algorithms primitives.
    expect(container.querySelector('[data-snd-node="p:sine"]')?.className).toContain("snd-primitive");
    // The toolbar summarizes the kit.
    expect(screen.getByText((c) => c.includes("5 cues") && c.includes("7 voices") && c.includes("5 primitives"))).toBeInTheDocument();
  });

  it("plays a cue and shows its layers in the inspector when its node is clicked", () => {
    const { container } = render(<SoundsWorkspace />);
    const clickNode = container.querySelector('[data-snd-node="c:click"]') as HTMLElement;
    fireEvent.click(clickNode);
    expect(playCue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(playCue).mock.calls[0][0].id).toBe("click");
    // The inspector reflects the selection: the cue's layers + a Play button.
    expect(screen.getByText("Layers")).toBeInTheDocument();
    expect(screen.getByText("Play")).toBeInTheDocument();
  });

  it("plays a voice in isolation (an ephemeral single-layer cue) when its node is clicked", () => {
    const { container } = render(<SoundsWorkspace />);
    fireEvent.click(container.querySelector('[data-snd-node="v:blip"]') as HTMLElement);
    expect(playCue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(playCue).mock.calls[0][0].layers).toEqual([{ voice: "blip", at: 0 }]);
  });
});
