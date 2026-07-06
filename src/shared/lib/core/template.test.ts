import { describe, it, expect } from "vitest";
import { fillTemplate } from "./template";

describe("fillTemplate (#2416)", () => {
  it("substitutes every known {{NAME}} placeholder", () => {
    expect(fillTemplate("a {{X}} b {{Y}} c {{X}}", { X: "1", Y: "2" })).toBe("a 1 b 2 c 1");
  });

  it("leaves an unknown placeholder verbatim (visible, not dropped)", () => {
    expect(fillTemplate("keep {{NOPE}} as-is", {})).toBe("keep {{NOPE}} as-is");
  });

  it("inserts $-sequences in values literally (no regex replacement-pattern expansion)", () => {
    expect(fillTemplate("cost: {{V}}", { V: "$100 and $' and $&" })).toBe("cost: $100 and $' and $&");
  });

  it("handles multi-line values (prompt bodies)", () => {
    expect(fillTemplate("A:\n{{BODY}}\nend", { BODY: "line1\nline2" })).toBe("A:\nline1\nline2\nend");
  });
});
