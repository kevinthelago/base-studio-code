import { describe, it, expect } from "vitest";
import { composerBytes } from "../lib/composer";

describe("composerBytes", () => {
  it("appends a carriage return so claude submits the line", () => {
    expect(composerBytes("hello")).toBe("hello\r");
  });

  it("preserves the draft verbatim (no trimming)", () => {
    expect(composerBytes("  spaced  ")).toBe("  spaced  \r");
  });

  it("sends a bare carriage return for an empty draft", () => {
    expect(composerBytes("")).toBe("\r");
  });
});
