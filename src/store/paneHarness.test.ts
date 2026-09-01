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

  it("does NOT let the LLM provider override the fleet-harness toggle", () => {
    // THE BUG THIS REPLACES, and the assertion it replaces asserted it: a local `llmProvider` used to
    // imply the harness "regardless of the toggle". So designating ONE project local — which is done
    // per pane — put every studio, every network architect, the planner and every un-designated fleet
    // pane on the local model, and the stored `fleetHarness` was never read.
    //
    // The two settings answer different questions: the provider says WHICH MODEL a bsc-agent session
    // talks to, the toggle says WHETHER a session is one.
    expect(paneHarness(state({ llmProvider: "ollama" as never }), PANE)).toBe("claude");
    // ...and the toggle still decides, on a local provider as on any other.
    expect(paneHarness(state({ llmProvider: "ollama" as never, fleetHarness: "bsc-agent" }), PANE)).toBe("bsc-agent");
  });

  // THE LIVE STORE, VERBATIM (~/.local/share/com.basestudio.code/app-state.json, 2026-09-01). Two panes
  // were designated local by hand; every other session ran local anyway. This is the whole report
  // ("all sessions are running the local model now ... only twitter-clone-test was designated to be
  // local") reduced to the four fields the resolver reads.
  it("leaves every UN-designated pane on claude while the designated ones stay local", () => {
    const live = state({
      llmProvider: "ollama" as never,
      fleetHarness: "claude",
      paneProviders: {
        "twitter-clone-test:director": "bsc-agent",
        "twitter-clone-test:api": "bsc-agent",
      } as never,
    });
    // The two the user designated — unchanged, because an explicit choice is nearest and always won.
    expect(paneHarness(live, "twitter-clone-test:director")).toBe("bsc-agent");
    expect(paneHarness(live, "twitter-clone-test:api")).toBe("bsc-agent");
    // Everything else — the studios, a network architect, another project's director. All of these
    // returned "bsc-agent" before, and not one of them had been designated anything.
    for (const pane of [
      "design-studio:designer-react",
      "algorithms-studio:librarian-rust",
      "teams-studio:architect",
      "sound-studio:sound-designer",
      "network-finance:architect",
      "studio-code:director",
    ]) {
      expect(paneHarness(live, pane), pane).toBe("claude");
    }
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
