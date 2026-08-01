// The structural half of the shadow verdict (#4169) — "graph-identical" vs "differs in N nodes".
import { describe, it, expect } from "vitest";
import { outlineJsx } from "./jsxOutline";
import { diffOutlines } from "./outlineDiff";

const diff = (file: string, graph: string) => diffOutlines(outlineJsx(file), outlineJsx(graph));

describe("diffOutlines", () => {
  it("calls a transcription identical even though the sources differ", () => {
    // The graph copy is the file with a generated header, the CSS import stripped and a sibling specifier
    // rewritten — all of which a text diff would report and none of which is drift.
    const file = `import "./mcp.css";\nimport { Tab } from "./Tab";\nexport const P = () => <Screen><Tab /></Screen>;`;
    const graph = `// MCP workspace, AS GRAPH SOURCE (#3656).\nimport { Tab } from "@/components/mcp-tab";\nexport const P = () => <Screen><Tab /></Screen>;`;
    const d = diff(file, graph);
    expect(d.identical).toBe(true);
    expect(d.differing).toBe(0);
    expect(d.fileNodes).toBe(2);
  });

  it("counts an element the file gained and the graph node never did", () => {
    const d = diff(`const P = <Screen><A /><B /></Screen>;`, `const P = <Screen><A /></Screen>;`);
    expect(d.identical).toBe(false);
    expect(d.differing).toBe(1);
    expect(d.onlyInFile).toEqual(["Screen>B"]);
    expect(d.onlyInGraph).toEqual([]);
  });

  it("counts repetition — two of three chips is drift, not a match", () => {
    const d = diff(`const P = <Row><Chip /><Chip /><Chip /></Row>;`, `const P = <Row><Chip /><Chip /></Row>;`);
    expect(d.differing).toBe(1);
    expect(d.onlyInFile).toEqual(["Row>Chip"]);
  });

  it("reports both directions — the graph node can also carry what the file dropped", () => {
    const d = diff(`const P = <Screen><A /></Screen>;`, `const P = <Screen><Legacy /></Screen>;`);
    expect(d.differing).toBe(2);
    expect(d.onlyInFile).toEqual(["Screen>A"]);
    expect(d.onlyInGraph).toEqual(["Screen>Legacy"]);
  });

  it("treats a re-parented element as drift — nesting is part of the skeleton", () => {
    const d = diff(`const P = <Screen><Card><Chip /></Card></Screen>;`, `const P = <Screen><Card /><Chip /></Screen>;`);
    expect(d.onlyInFile).toEqual(["Screen>Card>Chip"]);
    expect(d.onlyInGraph).toEqual(["Screen>Chip"]);
  });

  it("does NOT treat a reordering of siblings as drift", () => {
    // The paths are a multiset: same elements, same parents, different order ⇒ the same page.
    expect(diff(`const P = <Row><A /><B /></Row>;`, `const P = <Row><B /><A /></Row>;`).identical).toBe(true);
  });

  it("caps the samples but never the count", () => {
    const many = (n: number) => `const P = <Row>${Array.from({ length: n }, (_, i) => `<C${i} />`).join("")}</Row>;`;
    const d = diff(many(40), `const P = <Row />;`);
    expect(d.differing).toBe(40);
    expect(d.onlyInFile).toHaveLength(12);
  });
});
