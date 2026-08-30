import { describe, it, expect } from "vitest";
import { paneHarness } from "@/store";
import type { AppStore } from "@/store/types";

const PANE = "studio-code:blueprint";

/** Just enough store for the resolver — it reads four fields and nothing else. */
function state(over: Partial<AppStore> = {}): AppStore {
  return {
    paneProviders: {}, fleetPaneStreams: {}, llmProvider: "anthropic", fleetHarness: "claude",
    ...over,
  } as unknown as AppStore;
}
const streamWith = (model?: string) => ({ [PANE]: { id: "blueprint", model } } as never);

describe("paneHarness — the harness a pane actually launches on", () => {
  it("derives bsc-agent from the STREAM when no provider was ever stored", () => {
    // THE BUG. Measured on the live store: fleetPaneStreams held model qwen3.5:9b and paneModels
    // agreed, while paneProviders was empty — because it is written once at seat time and this pane
    // was seated before the model existed. `?? "claude"` then won over the roster every launch.
    expect(paneHarness(state({ fleetPaneStreams: streamWith("qwen3.5:9b") }), PANE)).toBe("bsc-agent");
  });

  it("prefers an explicitly STORED provider over the stream — a deliberate choice still wins", () => {
    const s = state({ paneProviders: { [PANE]: "claude" } as never, fleetPaneStreams: streamWith("qwen3.5:9b") });
    expect(paneHarness(s, PANE)).toBe("claude");
  });

  it("keeps a Claude-tier stream model on claude — only a NON-tier model means local", () => {
    for (const tier of ["opus-4.5", "sonnet-4.5", "haiku-4.5"]) {
      expect(paneHarness(state({ fleetPaneStreams: streamWith(tier) }), PANE), tier).toBe("claude");
    }
  });

  it("falls back to the fleet-wide harness for a pane with no stream at all", () => {
    expect(paneHarness(state(), PANE)).toBe("claude");
    expect(paneHarness(state({ fleetHarness: "bsc-agent" }), PANE)).toBe("bsc-agent");
  });

  it("honours a provider that forces bsc-agent fleet-wide, even with no stream", () => {
    // A local LlmProvider implies the harness regardless of the toggle (`effectiveHarness`).
    expect(paneHarness(state({ llmProvider: "ollama" as never }), PANE)).toBe("bsc-agent");
  });

  it("ignores a junk stored provider rather than passing it through", () => {
    // The stored map is persisted JSON; a value that is not a harness must not reach pty_create.
    const s = state({ paneProviders: { [PANE]: "gemini" } as never, fleetPaneStreams: streamWith("qwen3.5:9b") });
    expect(paneHarness(s, PANE)).toBe("bsc-agent");
  });

  it("a stream with NO model leaves the pane on the fleet default", () => {
    expect(paneHarness(state({ fleetPaneStreams: streamWith(undefined) }), PANE)).toBe("claude");
  });
});
