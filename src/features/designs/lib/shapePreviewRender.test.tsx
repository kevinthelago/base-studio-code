// shapePreview render verification (#3439) — the shape-tier data must render in the REAL target
// components without crashing and produce NON-EMPTY output (the acceptance's "previews with real data,
// never a broken preview"). jsdom has no layout, but it renders the DOM tree and throws on a bad access —
// which is exactly the risk (feeding generated objects into a component that hard-reads a field). The
// visual polish is confirmed in-app; this pins the crash-safety + non-emptiness headlessly.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
// Barrel-free import of the real dataset source — see shapePreview.test.ts for why the barrel is avoided.
// eslint-disable-next-line no-restricted-imports -- barrel-free path avoids the module-init cycle (#3439)
import { datasetForStructure } from "@/features/algorithms/viz/previewDataset";
import { ActivityFeed } from "@/shared/ui/data/ActivityFeed";
import { CollectionPage } from "@/shared/ui/pages/CollectionPage";
import { NetworkPage } from "@/shared/ui/pages/NetworkPage";
import { Tree, type TreeNodeData } from "@/shared/ui/layouts/Tree";
import { shapePreviewData } from "./shapePreview";
import type { ComponentRecord, DataShape, PropSpec } from "./model";

const prop = (name: string, type: string): PropSpec => ({ name, type, req: false, desc: "" });
const comp = (shapes: DataShape[], props: PropSpec[]): ComponentRecord => ({
  id: "c", name: "C", kitId: "react-ui", role: "composite", version: "1.0.0", used: 0,
  tags: [], variants: [], composes: [], props, whenUse: [], whenNot: [], src: "", srcText: "", shapes,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const listItems = (): any[] => JSON.parse(shapePreviewData(comp(["list"], [prop("items", "T[]")]), datasetForStructure).items);
const graphData = () => {
  const o = shapePreviewData(comp(["graph"], [prop("nodes", "T[]"), prop("edges", "T[]")]), datasetForStructure);
  return { nodes: JSON.parse(o.nodes), edges: JSON.parse(o.edges) };
};
const treeNodes = (): TreeNodeData[] => JSON.parse(shapePreviewData(comp(["tree"], [prop("nodes", "T[]")]), datasetForStructure).nodes);

describe("shape-tier data renders in the real components (#3439)", () => {
  it("ActivityFeed renders the generated items — Avatar(login) + action, no crash", () => {
    const items = listItems();
    expect(items.length).toBeGreaterThan(0);
    const { container } = render(<ActivityFeed items={items} hint="" loading={false} tone={{}} />);
    expect(container.textContent).toContain("updated"); // the action column of every row
  });

  it("CollectionPage renders the generated items — title rows, no crash", () => {
    const items = listItems();
    const { container } = render(<CollectionPage title="Preview" items={items} />);
    expect(container.textContent).toContain("Item 1"); // a CollectionItem.title
  });

  it("NetworkPage renders the generated nodes + edges, no crash", () => {
    const { nodes, edges } = graphData();
    expect(nodes.length).toBeGreaterThan(0);
    const { container } = render(<NetworkPage title="Preview" nodes={nodes} edges={edges} />);
    // a node label (or its id fallback) is painted somewhere in the tree
    expect(container.textContent).toContain(String(nodes[0].label));
  });

  it("Tree renders the generated nested forest, no crash (#3790)", () => {
    const nodes = treeNodes();
    expect(nodes.length).toBe(1);
    const { container } = render(<Tree nodes={nodes} />);
    // the BST root label is painted (a node value)
    expect(container.textContent).toContain(String(nodes[0].label));
  });
});
