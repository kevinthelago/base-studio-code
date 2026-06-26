import { describe, it, expect } from "vitest";
import { parseProjectV2Items, parseProjectV2Fields, statusFieldValue, type ProjectV2Node } from "./projectV2";

const node: ProjectV2Node = {
  fields: {
    nodes: [
      { name: "Title" }, // no options — skipped
      { name: "Status", options: [{ id: "o1", name: "Todo", color: "GRAY" }, { id: "o2", name: "Done", color: "GREEN" }] },
    ],
  },
  items: {
    nodes: [
      {
        id: "i1",
        fieldValues: { nodes: [{ field: { name: "Status" }, name: "Todo", optionId: "o1" }] },
        content: { __typename: "Issue", number: 1, title: "first" },
      },
      {
        id: "i2",
        fieldValues: { nodes: [] },
        content: { __typename: "PullRequest", number: 2 }, // not an Issue — skipped
      },
      {
        id: "i3",
        fieldValues: { nodes: [] },
        content: null, // draft / empty — skipped
      },
      {
        id: "i4",
        fieldValues: { nodes: [{ field: { name: "Status" }, name: "Done", optionId: "o2" }] },
        content: { __typename: "Issue", number: 4, title: "fourth" },
      },
    ],
  },
};

describe("parseProjectV2Items", () => {
  it("keeps only Issue content and maps via the callback (id + content + status)", () => {
    const rows = parseProjectV2Items<{ number: number; title: string }, { id: string; n: number; status: string | null }>(
      node,
      (c, item) => ({ id: item.id, n: c.number, status: statusFieldValue(item)?.name ?? null }),
    );
    expect(rows).toEqual([
      { id: "i1", n: 1, status: "Todo" },
      { id: "i4", n: 4, status: "Done" },
    ]);
  });

  it("returns [] for an undefined / empty node", () => {
    expect(parseProjectV2Items(undefined, () => 1)).toEqual([]);
    expect(parseProjectV2Items({ items: { nodes: [] } }, () => 1)).toEqual([]);
  });
});

describe("parseProjectV2Fields", () => {
  it("returns the Status field's options in order", () => {
    expect(parseProjectV2Fields(node).map(o => o.name)).toEqual(["Todo", "Done"]);
  });
  it("returns [] when there's no Status field", () => {
    expect(parseProjectV2Fields({ fields: { nodes: [{ name: "Title" }] }, items: { nodes: [] } })).toEqual([]);
    expect(parseProjectV2Fields(undefined)).toEqual([]);
  });
});

describe("statusFieldValue", () => {
  it("finds the Status single-select value", () => {
    expect(statusFieldValue(node.items.nodes[0])).toMatchObject({ name: "Todo", optionId: "o1" });
    expect(statusFieldValue(node.items.nodes[1])).toBeUndefined();
  });
});
