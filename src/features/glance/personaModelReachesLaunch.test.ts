// A PERSONA'S LOCAL MODEL MUST REACH THE LAUNCH (`a-personas-local-model-reaches-the-launch`).
//
// MAINTAINER 2026-09-02: "these nodes are still being opened into a claude cli sessions."
//
// The persona carried `qwen3.5:35b-a3b` and the terminal ran Claude. Two independent places dropped it,
// and BOTH failed silently — `ClaudeCodeAdapter.model_flag` maps the known tiers and ignores anything
// else, so a local name handed to Claude Code produces no error at all, just the wrong harness.
import { describe, it, expect } from "vitest";
import { providerForModel } from "@/app/console/lib/models";
import { streamPaneWiring } from "@/store/slices/projects";
// A cross-feature `import type` (allowed by #1545); `AgentStream` is not on the planner barrel — the
// same import `GlanceWorkspace` itself uses for `FleetPlan`.
import type { AgentStream } from "@/features/planner/fleet/planFleet";

const stream = (over: Partial<AgentStream> = {}): AgentStream =>
  ({ id: "s", name: "s", repo: "acme/r", owns: [], ...over }) as AgentStream;

describe("the harness a model implies", () => {
  it("sends a non-tier model to bsc-agent, and a tier to the default", () => {
    expect(providerForModel("qwen3.5:35b-a3b")).toBe("bsc-agent");
    expect(providerForModel("sonnet-4.5")).toBeUndefined();
    // unset is a real state — NOT "claude"
    expect(providerForModel(undefined)).toBeUndefined();
    expect(providerForModel("")).toBeUndefined();
  });
});

describe("a persona's model survives streamPaneWiring", () => {
  it("adopts a LOCAL model from the persona and derives bsc-agent", () => {
    // The regression: this used to adopt `persona.model` only when it was a Claude tier, so a local
    // name was dropped here and the session launched on Claude Code with nothing reporting it.
    const w = streamPaneWiring(stream(), { role: "worker", model: "qwen3.5:35b-a3b" });
    expect(w.model).toBe("qwen3.5:35b-a3b");
    expect(w.provider).toBe("bsc-agent");
  });

  it("still adopts a tier from the persona, with no provider override", () => {
    const w = streamPaneWiring(stream(), { role: "worker", model: "sonnet-4.5" });
    expect(w.model).toBe("sonnet-4.5");
    expect(w.provider).toBeUndefined();
  });

  it("lets the STREAM's own model win over the persona's", () => {
    // Nearest-first precedence: a fleet stream's model beats the persona's default.
    const w = streamPaneWiring(stream({ model: "haiku-4.5" }), { role: "worker", model: "qwen3.5:9b" });
    expect(w.model).toBe("haiku-4.5");
    expect(w.provider).toBeUndefined();
  });

  it("carries a local model from the STREAM too", () => {
    const w = streamPaneWiring(stream({ model: "qwen3.5:9b" }), { role: "worker" });
    expect(w.model).toBe("qwen3.5:9b");
    expect(w.provider).toBe("bsc-agent");
  });
});
