import { describe, it, expect } from "vitest";
import { MODELS, MODEL_IDS, DEFAULT_MODEL_ID, modelTier, tierToModelId } from "./models";

describe("console model catalog", () => {
  it("offers the three tiers cheapest → deepest", () => {
    expect(MODEL_IDS).toEqual(["haiku-4.5", "sonnet-4.5", "opus-4.5"]);
    expect(MODELS.map((m) => m.tone)).toEqual(["fast", "balanced", "deep"]);
  });

  // #2416: the per-pane tier default moved to `@data/console/model-defaults.json` — the previously
  // scattered `"sonnet-4.5"` literals (session slice seed, PaneShell fallback) now read this.
  it("DEFAULT_MODEL_ID resolves from @data and stays the balanced tier (#2416)", () => {
    expect(DEFAULT_MODEL_ID).toBe("sonnet-4.5");
    expect(MODEL_IDS).toContain(DEFAULT_MODEL_ID);
  });

  it("modelTier maps an id to its CLI tier alias", () => {
    expect(modelTier("opus-4.5")).toBe("opus");
    expect(modelTier("sonnet-4.5")).toBe("sonnet");
    expect(modelTier("haiku-4.5")).toBe("haiku");
  });

  it("tierToModelId round-trips and is undefined for an unknown tier", () => {
    for (const id of MODEL_IDS) expect(tierToModelId(modelTier(id))).toBe(id);
    expect(tierToModelId("gpt")).toBeUndefined();
    expect(tierToModelId("default")).toBeUndefined();
  });
});
