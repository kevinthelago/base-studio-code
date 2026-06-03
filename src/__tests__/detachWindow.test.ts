import { describe, it, expect } from "vitest";
import { detachedTabIndex } from "../lib/detachWindow";

describe("detachedTabIndex", () => {
  it("parses a valid detachTab index", () => {
    expect(detachedTabIndex("?detachTab=0")).toBe(0);
    expect(detachedTabIndex("?detachTab=3")).toBe(3);
    expect(detachedTabIndex("?foo=1&detachTab=2")).toBe(2);
  });
  it("returns null when the param is absent (main window)", () => {
    expect(detachedTabIndex("")).toBeNull();
    expect(detachedTabIndex("?other=1")).toBeNull();
  });
  it("returns null for non-integer / negative values", () => {
    expect(detachedTabIndex("?detachTab=x")).toBeNull();
    expect(detachedTabIndex("?detachTab=-1")).toBeNull();
    expect(detachedTabIndex("?detachTab=1.5")).toBeNull();
  });
});
