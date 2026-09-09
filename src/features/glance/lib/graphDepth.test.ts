// The depth rule, tested without a graph — which is the point of it being a pure function. A
// rendering rule you can only check by clicking is one nobody checks, and the two sub-layers here are
// the only route to a verb node.
import { describe, it, expect } from "vitest";
import { opensSubLayer, layerCount, NODE_KIND_MEANING } from "@/features/glance/lib/graphDepth";

describe("the graph's depth follows the session mode", () => {
  it("gives claude ONE layer and no navigation into a new graph", () => {
    expect(layerCount("claude")).toBe(1);
    expect(opensSubLayer("claude", "crate")).toBe(false);
    expect(opensSubLayer("claude", "feature")).toBe(false);
  });

  it("leaves the local path exactly as it was — three layers, both sub-layers", () => {
    // This slice must not change local by accident. Claude is the one gaining a rule.
    expect(layerCount("local")).toBe(3);
    expect(opensSubLayer("local", "crate")).toBe(true);
    expect(opensSubLayer("local", "feature")).toBe(true);
  });

  it("degrades to the LAYERED view for a project in neither mode", () => {
    // The two failures are not symmetrical, and this is the asymmetry written as a test. Showing a
    // sub-layer to a session that did not need it costs a click; hiding navigation from a user who
    // had it removes the only route to a verb node. A machine on `openai`, or one nobody has
    // configured, resolves to no mode and must keep the richer view.
    expect(layerCount(null)).toBe(3);
    expect(opensSubLayer(null, "crate")).toBe(true);
    expect(opensSubLayer(null, "feature")).toBe(true);
  });

  it("states what each node kind IS, not where its data came from", () => {
    // The two kinds existed with no stated meaning and had drifted toward naming their SOURCE — "the
    // plan's roster" and "the crate's roster". One graph answers two questions, and this is the
    // sentence that says which is which.
    expect(NODE_KIND_MEANING.feature).toBe("a UI the user can interact with");
    expect(NODE_KIND_MEANING.surface).toBe("logic, and how the AI interacts with it");
  });
});
