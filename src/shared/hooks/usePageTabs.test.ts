import { describe, it, expect } from "vitest";
import { orderTabs } from "./usePageTabs";
import type { TabItem } from "@/app/chrome/TabBar";

const DEFS: TabItem[] = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
];

describe("orderTabs", () => {
  it("returns defs unchanged when there's no persisted order", () => {
    expect(orderTabs(DEFS, undefined).map(t => t.id)).toEqual(["a", "b", "c"]);
    expect(orderTabs(DEFS, []).map(t => t.id)).toEqual(["a", "b", "c"]);
  });

  it("applies the persisted order (front tab = the user's preference)", () => {
    expect(orderTabs(DEFS, ["c", "a", "b"]).map(t => t.id)).toEqual(["c", "a", "b"]);
  });

  it("appends new defs not present in the persisted order", () => {
    // Only a,c remembered; b is new → appended after the remembered ones.
    expect(orderTabs(DEFS, ["c", "a"]).map(t => t.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores stale ids in the persisted order", () => {
    expect(orderTabs(DEFS, ["gone", "b", "a", "stale"]).map(t => t.id)).toEqual(["b", "a", "c"]);
  });
});
