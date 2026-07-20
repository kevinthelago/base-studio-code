import { describe, it, expect } from "vitest";
import { visitNodes, collectActions } from "./specWalk";
import { validateGeneralNode } from "./generalNode";
import type { GeneralNode } from "./generalNode";

const spec: GeneralNode = {
  type: "Card",
  props: { title: "T" },
  children: [
    {
      type: "TextField",
      props: { label: "Name" },
      binds: { value: "name" },
      actions: { onChange: "setName" },
    },
    {
      type: "Row",
      children: [
        { type: "Toggle", binds: { on: "on" }, actions: { onClick: "toggle" } },
        { type: "Button", children: "Save", actions: { onClick: "save" } },
      ],
    },
    { type: "Button", children: "Cancel", actions: { onClick: "cancel" } },
    { type: "Button", children: "Save again", actions: { onClick: "save" } }, // duplicate action name
  ],
};

describe("visitNodes (#2868)", () => {
  // The fixture is a REAL spec, not a shape invented for the walker: if it stopped validating, a walk
  // over it would be proving something about a tree the renderer would refuse.
  it("the fixture is a valid spec", () => {
    expect(validateGeneralNode(spec)).toEqual([]);
  });

  it("visits every node depth-first, descending into children", () => {
    const types: string[] = [];
    visitNodes(spec, (n) => types.push(n.type));
    expect(types).toEqual(["Card", "TextField", "Row", "Toggle", "Button", "Button", "Button"]);
  });

  // #3500 — the old walk knew two container kinds BY NAME, so a node in any other slot was invisible
  // to it. Descending structurally means a node nested in ANY `node`-typed prop is found.
  it("visits nodes nested in a prop slot, not just children", () => {
    const types: string[] = [];
    visitNodes(
      {
        type: "Card",
        props: { header: { type: "Text", children: "H" } },
        children: [{ type: "Text", children: "body" }],
      },
      (n) => types.push(n.type),
    );
    expect(types).toEqual(["Card", "Text", "Text"]);
  });
});

describe("collectActions (#2868)", () => {
  it("collects distinct action names across the tree, first-seen order", () => {
    expect(collectActions(spec)).toEqual(["setName", "toggle", "save", "cancel"]);
  });

  it("is empty when nothing carries an action", () => {
    expect(collectActions({ type: "Toggle", binds: { on: "x" } })).toEqual([]);
  });

  // Both wiring routes reach the renderer, so both must be collected — a host that resolved only the
  // `actions` map would leave every declared-prop handler dead.
  it("collects an action named through a declared function PROP as well as the actions map", () => {
    const node: GeneralNode = {
      type: "Dialog",
      props: { title: "t", children: "c", actions: "a", onDismiss: "closeDialog" },
    };
    expect(validateGeneralNode(node)).toEqual([]);
    expect(collectActions(node)).toEqual(["closeDialog"]);
  });

  it("does not mistake a plain data prop for an action name", () => {
    expect(collectActions({ type: "Text", props: { tone: "dim" }, children: "x" })).toEqual([]);
  });
});
