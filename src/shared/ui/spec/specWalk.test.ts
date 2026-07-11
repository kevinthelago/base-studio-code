import { describe, it, expect } from "vitest";
import { visitNodes, collectActions } from "./specWalk";
import type { KitNode } from "./schema";

const spec: KitNode = {
  kind: "card", title: "T", children: [
    { kind: "field", control: "text", label: "Name", bind: "name" },
    { kind: "row", children: [
      { kind: "toggle", bind: "on" },
      { kind: "button", label: "Save", action: "save" },
    ] },
    { kind: "button", label: "Cancel", action: "cancel" },
    { kind: "button", label: "Save again", action: "save" }, // duplicate action name
  ],
};

describe("visitNodes (#2868)", () => {
  it("visits every node depth-first, descending into card + row children", () => {
    const kinds: string[] = [];
    visitNodes(spec, (n) => kinds.push(n.kind));
    expect(kinds).toEqual(["card", "field", "row", "toggle", "button", "button", "button"]);
  });

  it("visits a card's header node too", () => {
    const kinds: string[] = [];
    visitNodes({ kind: "card", header: { kind: "header", title: "H" }, children: [] }, (n) => kinds.push(n.kind));
    expect(kinds).toEqual(["card", "header"]);
  });
});

describe("collectActions (#2868)", () => {
  it("collects distinct button action names across the tree, first-seen order", () => {
    expect(collectActions(spec)).toEqual(["save", "cancel"]);
  });

  it("is empty when no button carries an action", () => {
    expect(collectActions({ kind: "toggle", bind: "x" })).toEqual([]);
  });
});
