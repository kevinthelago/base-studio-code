import { describe, it, expect } from "vitest";
import { validateKitNode, NODE_CONTRACT } from "./schema";
import { demoSpec } from "./demoSpec";

// The kinds the TS union + KitRenderer support. Kept in lockstep with the contract by the sync test
// below — add a kind to kit-nodes.json (+ the union + the renderer) and this list, together.
const UNION_KINDS = ["card", "header", "field", "button", "row", "toggle", "tag", "text"];

describe("KitNode contract", () => {
  it("the contract kinds match the TS union kinds (no drift)", () => {
    expect(Object.keys(NODE_CONTRACT.nodes).sort()).toEqual([...UNION_KINDS].sort());
  });

  it("every kind declares its required fields as a subset of its allowed fields", () => {
    for (const [kind, spec] of Object.entries(NODE_CONTRACT.nodes)) {
      for (const req of spec.required) {
        expect(spec.fields, `${kind}.required "${req}" must be an allowed field`).toContain(req);
      }
      for (const enumField of Object.keys(spec.enums ?? {})) {
        expect(spec.fields, `${kind}.enums "${enumField}" must be an allowed field`).toContain(enumField);
      }
    }
  });
});

describe("validateKitNode", () => {
  it("accepts the demo spec end-to-end", () => {
    expect(validateKitNode(demoSpec)).toEqual([]);
  });

  it("rejects a non-object node", () => {
    expect(validateKitNode(42)).toEqual(["$: expected a node object"]);
  });

  it("rejects a missing kind", () => {
    expect(validateKitNode({ title: "x" })).toEqual(['$: missing string "kind"']);
  });

  it("rejects an unknown kind", () => {
    expect(validateKitNode({ kind: "widget" })).toEqual(['$: unknown kind "widget"']);
  });

  it("reports a missing required field", () => {
    // field requires control + label
    expect(validateKitNode({ kind: "field", control: "text" })).toEqual([
      '$: missing required field "label" for kind "field"',
    ]);
  });

  it("reports an unknown field", () => {
    expect(validateKitNode({ kind: "tag", label: "x", bogus: 1 })).toEqual([
      '$: unknown field "bogus" for kind "tag"',
    ]);
  });

  it("reports an out-of-set enum value", () => {
    const errs = validateKitNode({ kind: "field", control: "radio", label: "x" });
    expect(errs).toContain('$.control: "radio" not one of text, password, select');
  });

  it("recurses into children and reports the nested path", () => {
    const bad = { kind: "card", children: [{ kind: "button" /* missing label */ }] };
    expect(validateKitNode(bad)).toEqual([
      '$.children[0]: missing required field "label" for kind "button"',
    ]);
  });

  it("recurses into a nested header node", () => {
    const bad = { kind: "card", header: { kind: "header" /* missing title */ }, children: [] };
    expect(validateKitNode(bad)).toEqual([
      '$.header: missing required field "title" for kind "header"',
    ]);
  });
});
