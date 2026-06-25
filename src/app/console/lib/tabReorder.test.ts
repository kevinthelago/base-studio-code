import { describe, it, expect } from "vitest";
import {
  moveInArray, tabIndexMap, rekeyByTab, rekeyByPaneId, remapFocusQueue,
} from "./tabReorder";

describe("moveInArray", () => {
  it("moves an element forward", () => {
    expect(moveInArray(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });
  it("moves an element backward", () => {
    expect(moveInArray(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });
  it("is a no-op (copy) for from===to or out-of-range", () => {
    expect(moveInArray(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveInArray(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

describe("tabIndexMap (old index -> new index)", () => {
  it("maps a forward move", () => {
    // [A,B,C,D] move 0->2 => [B,C,A,D]; A:0->2, B:1->0, C:2->1, D:3->3
    expect(tabIndexMap(4, 0, 2)).toEqual([2, 0, 1, 3]);
  });
  it("maps a backward move", () => {
    // [A,B,C,D] move 3->1 => [A,D,B,C]; A:0, D:3->1, B:1->2, C:2->3
    expect(tabIndexMap(4, 3, 1)).toEqual([0, 2, 3, 1]);
  });
  it("is identity for a no-op move", () => {
    expect(tabIndexMap(3, 1, 1)).toEqual([0, 1, 2]);
  });
});

describe("rekeyByTab", () => {
  it("rekeys numeric tab keys through the map", () => {
    const map = tabIndexMap(3, 0, 2); // [2,0,1]
    expect(rekeyByTab({ 0: { 0: "x" }, 1: { 0: "y" }, 2: { 0: "z" } }, map))
      .toEqual({ 2: { 0: "x" }, 0: { 0: "y" }, 1: { 0: "z" } });
  });
});

describe("rekeyByPaneId", () => {
  it("rekeys only the tab segment of t{tab}p{pane} keys", () => {
    const map = tabIndexMap(3, 0, 2); // tab 0->2, 1->0, 2->1
    expect(rekeyByPaneId({ "t0p0": "a", "t0p1": "b", "t1p0": "c", "t2p0": "d" }, map))
      .toEqual({ "t2p0": "a", "t2p1": "b", "t0p0": "c", "t1p0": "d" });
  });
  it("passes through keys that aren't pane ids", () => {
    const map = tabIndexMap(2, 0, 1);
    expect(rekeyByPaneId({ "owner/repo": "tok", "t0p0": "x" }, map))
      .toEqual({ "owner/repo": "tok", "t1p0": "x" });
  });
});

describe("remapFocusQueue", () => {
  it("remaps each entry's tab index, keeping pane", () => {
    const map = tabIndexMap(3, 0, 2); // 0->2, 1->0
    expect(remapFocusQueue([{ tab: 0, pane: 1 }, { tab: 1, pane: 0 }], map))
      .toEqual([{ tab: 2, pane: 1 }, { tab: 0, pane: 0 }]);
  });
});
