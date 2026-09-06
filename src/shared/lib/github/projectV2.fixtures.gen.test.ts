// The ProjectV2 GraphQL WALK, captured from the live TypeScript so Rust can be proved to match.
//
// `projectV2.ts` is what every board-shaped read of GitHub goes through: read the Status
// single-select options, then iterate items and keep only real Issues. Rust already owns the
// transport (`crates/bsc-github`) and the persisted board state (`board_state.rs`), so it parses a
// `projectsV2` payload it could not previously interpret.
//
// ## The rules a port drifts on, each with its own case
//
//   * `parseProjectV2Fields` requires BOTH `name === "Status"` AND the presence of `options`. A
//     Status field with no options must NOT match — otherwise a later, real Status field is shadowed
//     by an earlier degenerate one and the board loses every column.
//   * The FIRST matching field wins, and the option ORDER is board order. A set comparison, or a
//     Rust `HashMap`, destroys exactly the property the columns are rendered from.
//   * `parseProjectV2Items` skips `content: null` (a DRAFT item) and anything whose `__typename` is
//     not `Issue` — a PullRequest in a board is ordinary, and treating one as an issue would put it
//     in front of an agent as work to do.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/github/projectV2.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseProjectV2Fields,
  parseProjectV2Items,
  statusFieldValue,
  type ProjectV2Item,
  type ProjectV2Node,
} from "@/shared/lib/github/projectV2";

const FIXTURE = join(process.cwd(), "src/shared/lib/github/projectV2.fixtures.json");

const opt = (id: string, name: string, color: string) => ({ id, name, color });

/** Field-shapes, including the two degenerate ones that separate a right port from a wrong one. */
const FIELD_CASES: { label: string; node: ProjectV2Node | undefined }[] = [
  { label: "absent node", node: undefined },
  { label: "no fields at all", node: { items: { nodes: [] } } },
  { label: "empty field list", node: { fields: { nodes: [] }, items: { nodes: [] } } },
  {
    label: "a Status field with options",
    node: {
      fields: { nodes: [{ id: "f1", name: "Status", options: [opt("o1", "Todo", "GRAY"), opt("o2", "Done", "GREEN")] }] },
      items: { nodes: [] },
    },
  },
  {
    label: "a Status field with NO options must not match",
    node: { fields: { nodes: [{ id: "f1", name: "Status" }] }, items: { nodes: [] } },
  },
  {
    label: "an optionless Status must not shadow the real one that follows it",
    node: {
      fields: {
        nodes: [
          { id: "f0", name: "Status" },
          { id: "f1", name: "Status", options: [opt("o1", "Todo", "GRAY")] },
        ],
      },
      items: { nodes: [] },
    },
  },
  {
    label: "a non-Status field with options is ignored",
    node: {
      fields: { nodes: [{ id: "f9", name: "Priority", options: [opt("p1", "High", "RED")] }] },
      items: { nodes: [] },
    },
  },
  {
    label: "option ORDER is board order and is preserved",
    node: {
      fields: {
        nodes: [
          { id: "f1", name: "Status", options: [opt("o3", "Zeta", "RED"), opt("o1", "Alpha", "GRAY"), opt("o2", "Mid", "BLUE")] },
        ],
      },
      items: { nodes: [] },
    },
  },
];

const item = (id: string, typename: string | null | undefined, fvs: unknown[]): ProjectV2Item =>
  ({
    id,
    fieldValues: { nodes: fvs as never },
    content: typename === null ? null : ({ __typename: typename, number: Number(id.replace(/\D/g, "")) || 0 } as never),
  }) as ProjectV2Item;

const ITEM_CASES: { label: string; node: ProjectV2Node | undefined }[] = [
  { label: "absent node", node: undefined },
  { label: "no items", node: { items: { nodes: [] } } },
  {
    label: "a draft item (content null) is skipped",
    node: { items: { nodes: [item("i1", null, [])] } },
  },
  {
    label: "a PullRequest is skipped, an Issue is kept",
    node: { items: { nodes: [item("i1", "PullRequest", []), item("i2", "Issue", [])] } },
  },
  {
    label: "a missing __typename is skipped",
    node: { items: { nodes: [item("i1", undefined, [])] } },
  },
  {
    label: "casing matters — `issue` is not `Issue`",
    node: { items: { nodes: [item("i1", "issue", [])] } },
  },
  {
    label: "item ORDER survives the filter",
    node: {
      items: {
        nodes: [
          item("i1", "Issue", []),
          item("i2", "PullRequest", []),
          item("i3", "Issue", []),
        ],
      },
    },
  },
];

/** Status field-value lookup, including the shapes with no `field` at all. */
const STATUS_CASES: { label: string; item: ProjectV2Item }[] = [
  { label: "no field values", item: item("i1", "Issue", []) },
  { label: "a Status value", item: item("i1", "Issue", [{ name: "Todo", optionId: "o1", field: { name: "Status" } }]) },
  {
    label: "the FIRST Status value wins",
    item: item("i1", "Issue", [
      { name: "Todo", optionId: "o1", field: { name: "Status" } },
      { name: "Done", optionId: "o2", field: { name: "Status" } },
    ]),
  },
  {
    label: "a field-value with no `field` is skipped, not thrown on",
    item: item("i1", "Issue", [{ name: "orphan" }, { name: "Todo", optionId: "o1", field: { name: "Status" } }]),
  },
  {
    label: "a non-Status field is ignored",
    item: item("i1", "Issue", [{ name: "High", optionId: "p1", field: { name: "Priority" } }]),
  },
];

describe("projectV2 fixture", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const doc = {
      note: "GENERATED from the live TypeScript — see projectV2.fixtures.gen.test.ts",
      fields: FIELD_CASES.map((c) => ({
        label: c.label,
        node: c.node ?? null,
        // The STATE's value, in order — never a count, which would read the same for a port that
        // returned the right number of wrong options.
        options: parseProjectV2Fields(c.node),
      })),
      items: ITEM_CASES.map((c) => ({
        label: c.label,
        node: c.node ?? null,
        // Record the surviving item IDS in order: `parseProjectV2Items` takes a caller-supplied
        // `mapIssue`, so the portable rule is WHICH items survive the filter and in what order.
        keptIds: parseProjectV2Items<{ __typename?: string }, string>(c.node, (_c, it) => it.id),
      })),
      status: STATUS_CASES.map((c) => ({
        label: c.label,
        item: c.item,
        value: statusFieldValue(c.item) ?? null,
      })),
    };
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });
});
