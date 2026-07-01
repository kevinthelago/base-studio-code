import { describe, it, expect } from "vitest";
import { space, pad, flexStyle } from "./space";

describe("space()", () => {
  it("maps named rungs to their pixel values", () => {
    expect(space("xs")).toBe(4);
    expect(space("sm")).toBe(8);
    expect(space("md")).toBe(12);
    expect(space("lg")).toBe(16);
    expect(space("xl")).toBe(24);
  });
  it("passes raw pixel numbers through unchanged", () => {
    expect(space(10)).toBe(10);
    expect(space(0)).toBe(0);
  });
  it("returns undefined for undefined", () => {
    expect(space(undefined)).toBeUndefined();
  });
});

describe("pad()", () => {
  it("renders a single Space as an all-sides padding", () => {
    expect(pad("md")).toBe("12px");
  });
  it("renders a [block, inline] pair", () => {
    expect(pad(["sm", "lg"])).toBe("8px 16px");
    expect(pad([10, 12])).toBe("10px 12px");
  });
  it("returns undefined for undefined", () => {
    expect(pad(undefined)).toBeUndefined();
  });
});

describe("flexStyle()", () => {
  it("maps friendly align/justify names to flexbox values", () => {
    expect(flexStyle({ align: "center", justify: "between" })).toMatchObject({
      alignItems: "center",
      justifyContent: "space-between",
    });
    expect(flexStyle({ align: "start", justify: "end" })).toMatchObject({
      alignItems: "flex-start",
      justifyContent: "flex-end",
    });
  });
  it("sets gap from a Space and flexWrap only when wrap is true", () => {
    expect(flexStyle({ gap: "sm", wrap: true })).toMatchObject({ gap: 8, flexWrap: "wrap" });
    expect(flexStyle({ gap: 10 }).flexWrap).toBeUndefined();
  });
  it("omits keys that were not provided", () => {
    expect(flexStyle({})).toEqual({});
  });
});
