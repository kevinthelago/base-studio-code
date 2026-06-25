import { describe, it, expect } from "vitest";
import { MODELS, MODEL_IDS, modelTier, tierToModelId } from "./models";

describe("console model catalog", () => {
  it("offers the three tiers cheapest → deepest", () => {
    expect(MODEL_IDS).toEqual(["haiku-4.5", "sonnet-4.5", "opus-4.5"]);
    expect(MODELS.map((m) => m.tone)).toEqual(["fast", "balanced", "deep"]);
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
