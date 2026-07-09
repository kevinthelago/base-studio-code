import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";

// #2656: the design-contribution store slice — persisted downloaded-blueprint token overlays that
// apply live via applyContributionsToRoot (compose-don't-mutate). The managed <style> id is
// "bsc-ui-contributions" (contributions.ts).
describe("design contributions store (#2656)", () => {
  beforeEach(() => {
    useAppStore.setState({ designContributions: [] });
    document.getElementById("bsc-ui-contributions")?.remove();
  });

  it("addDesignContribution registers + applies to :root, upserting by source", () => {
    useAppStore.getState().addDesignContribution({ source: "bp-1", tokens: { "--graph-category-sim": "#111111" } });
    expect(useAppStore.getState().designContributions).toHaveLength(1);
    expect(document.getElementById("bsc-ui-contributions")?.textContent).toContain("--graph-category-sim: #111111;");

    // same source replaces (no duplicate), and the live style updates
    useAppStore.getState().addDesignContribution({ source: "bp-1", tokens: { "--graph-category-sim": "#222222" } });
    expect(useAppStore.getState().designContributions).toHaveLength(1);
    expect(document.getElementById("bsc-ui-contributions")?.textContent).toContain("#222222");
  });

  it("removeDesignContribution drops the source + re-applies the rest", () => {
    const s = useAppStore.getState();
    s.addDesignContribution({ source: "a", tokens: { "--graph-category-x": "#abcdef" } });
    s.addDesignContribution({ source: "b", tokens: { "--graph-category-y": "#fedcba" } });
    useAppStore.getState().removeDesignContribution("a");
    expect(useAppStore.getState().designContributions.map((o) => o.source)).toEqual(["b"]);
    const css = document.getElementById("bsc-ui-contributions")?.textContent ?? "";
    expect(css).not.toContain("--graph-category-x");
    expect(css).toContain("--graph-category-y: #fedcba;");
  });
});
