import { describe, it, expect } from "vitest";
import { toModelId, prettyModel } from "./modelDisplay";

describe("toModelId", () => {
  it("maps Claude transcript ids to the menu's ModelId", () => {
    expect(toModelId("claude-opus-4-5-20250930")).toBe("opus-4.5");
    expect(toModelId("claude-sonnet-4-6")).toBe("sonnet-4.5");
    expect(toModelId("claude-haiku-4-5-20251001")).toBe("haiku-4.5");
  });

  it("returns undefined for non-Claude / unknown models", () => {
    expect(toModelId("gpt-4o")).toBeUndefined();
    expect(toModelId("gemini-2.5-pro")).toBeUndefined();
    expect(toModelId("llama3.1:70b")).toBeUndefined();
    expect(toModelId(undefined)).toBeUndefined();
    expect(toModelId("")).toBeUndefined();
  });
});

describe("prettyModel", () => {
  it("trims a trailing release-date suffix", () => {
    expect(prettyModel("claude-sonnet-4-6-20250930")).toBe("claude-sonnet-4-6");
  });

  it("leaves ids without a date suffix untouched", () => {
    expect(prettyModel("gpt-4o")).toBe("gpt-4o");
    expect(prettyModel("opus-4.5")).toBe("opus-4.5");
  });

  it("returns undefined for a missing id (caller falls back to configured)", () => {
    expect(prettyModel(undefined)).toBeUndefined();
  });
});
