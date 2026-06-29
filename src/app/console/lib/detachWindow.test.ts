import { describe, it, expect } from "vitest";
import { detachMarker, detachedTabId, detachedSection } from "./detachWindow";

describe("detachMarker", () => {
  it("accepts a well-formed tab marker", () => {
    expect(detachMarker({ kind: "tab", tabId: "tab_abc" })).toEqual({ kind: "tab", tabId: "tab_abc" });
  });
  it("accepts a well-formed section marker", () => {
    expect(detachMarker({ kind: "section", page: "github", section: "repos" })).toEqual({
      kind: "section", page: "github", section: "repos",
    });
  });
  it("rejects malformed / absent markers (main window)", () => {
    expect(detachMarker(undefined)).toBeNull();
    expect(detachMarker(null)).toBeNull();
    expect(detachMarker({})).toBeNull();
    expect(detachMarker({ kind: "tab" })).toBeNull();           // missing tabId
    expect(detachMarker({ kind: "section", page: "x" })).toBeNull(); // missing section
    expect(detachMarker("?detachTab=x")).toBeNull();            // not an object
  });
});

describe("detachedTabId", () => {
  it("reads the detached tab's stable id from the injected marker", () => {
    expect(detachedTabId({ kind: "tab", tabId: "tab_abc" })).toBe("tab_abc");
  });
  it("returns null for a section marker or the main window", () => {
    expect(detachedTabId({ kind: "section", page: "github", section: "repos" })).toBeNull();
    expect(detachedTabId(undefined)).toBeNull();
  });
});

describe("detachedSection", () => {
  it("reads <page>/<section> from the injected marker", () => {
    expect(detachedSection({ kind: "section", page: "github", section: "repos" })).toEqual({
      page: "github", section: "repos",
    });
  });
  it("returns null for a tab marker or the main window", () => {
    expect(detachedSection({ kind: "tab", tabId: "tab_abc" })).toBeNull();
    expect(detachedSection(undefined)).toBeNull();
  });
});
