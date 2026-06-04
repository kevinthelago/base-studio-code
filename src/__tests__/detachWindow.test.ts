import { describe, it, expect } from "vitest";
import { detachedTabId, detachedSection } from "../lib/detachWindow";

describe("detachedTabId", () => {
  it("parses the detached tab's stable id", () => {
    expect(detachedTabId("?detachTab=tab_abc")).toBe("tab_abc");
    expect(detachedTabId("?foo=1&detachTab=tab_xyz")).toBe("tab_xyz");
  });
  it("returns null when absent (main window)", () => {
    expect(detachedTabId("")).toBeNull();
    expect(detachedTabId("?other=1")).toBeNull();
  });
});

describe("detachedSection", () => {
  it("parses ?detach=<page>&section=<id>", () => {
    expect(detachedSection("?detach=github&section=repos")).toEqual({ page: "github", section: "repos" });
  });
  it("returns null when either part is missing", () => {
    expect(detachedSection("?detach=github")).toBeNull();
    expect(detachedSection("?section=repos")).toBeNull();
    expect(detachedSection("")).toBeNull();
  });
});
