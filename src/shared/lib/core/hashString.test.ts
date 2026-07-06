import { describe, it, expect } from "vitest";
import { hashString } from "./hashString";

describe("hashString (#2256)", () => {
  it("is deterministic for the same input", () => {
    expect(hashString("hello world")).toBe(hashString("hello world"));
    expect(hashString("")).toBe(hashString(""));
  });

  it("changes when the content changes (so a stage edit is detectable)", () => {
    expect(hashString("goal v1")).not.toBe(hashString("goal v2"));
    expect(hashString("a")).not.toBe(hashString("b"));
    // A single-char change is caught.
    expect(hashString("the plan")).not.toBe(hashString("the plans"));
  });

  it("distinguishes same-length near-collisions via the length prefix + hash", () => {
    expect(hashString("ab")).not.toBe(hashString("ba"));
  });

  it("emits a stable, sign-free base36 shape", () => {
    expect(hashString("x")).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    expect(hashString("anything")).not.toContain("-".repeat(2)); // no leading '-' from a negative hash
  });
});
