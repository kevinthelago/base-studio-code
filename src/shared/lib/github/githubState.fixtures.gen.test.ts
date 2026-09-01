// The persisted GitHub board state's MODEL, captured from the LIVE TypeScript so Rust can be proved
// to match it.
//
// ## Why this one
//
// `crates/bsc-project` owns `~/.base-studio-code/github-state.json` — the path, the loader, the
// writer, the envelope check — and says so in its own doc comment: *"The frontend owns the record
// schema … this side treats the payload as OPAQUE-BUT-VALID JSON with that envelope."* So Rust
// persists and guards a structure it cannot read, and every rule about that structure lives here.
// That is the role-gate inversion, written down by the code that suffers from it.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/github/githubState.fixtures.gen.test.ts
//
// A regeneration that changes the file is a CHANGE TO THE PERSISTED MODEL. Read the diff.
//
// ## What is worth pinning, and what is already proved
//
// `filterRecordsToLocal` is the safety rule and the reason this moves at all: a persisted record
// whose local hub was deleted must NOT resurrect the project — only a live fetch may vouch for a
// GitHub-only board. Its three match paths are pinned separately, because a port that kept only the
// title match would still pass a corpus built from today's name-derived keys.
//
// Its dependency is NOT re-proved here: `projectSlug` and `sanitizeProjectKey` are already bound to
// their Rust equivalents by `projectSlug.fixtures.json`, which both sides read
// (`crates/bsc-project/src/lib.rs:1146`). The port reuses those rather than restating them, so this
// fixture deliberately does not become a fourth copy of the slug rule.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  toMinimalGhProjects,
  minimalToGhProject,
  filterRecordsToLocal,
  type GhProjectShape,
  type MinimalGhProject,
} from "@/shared/lib/github/githubState";

const FIXTURE = join(process.cwd(), "src/shared/lib/github/githubState.fixtures.json");

const item = (state?: string) => ({ content: state === undefined ? null : { state } });

/** Fetched boards → minimal records. The TALLY rules are the substance. */
const FETCHES: { name: string; projects: GhProjectShape[] }[] = [
  {
    name: "every item state — OPEN counts open, CLOSED and MERGED count closed, a draft counts as NEITHER",
    projects: [
      {
        id: "PVT_1", number: 7, title: "Studio Code", shortDescription: "the desktop host",
        url: "https://github.com/users/x/projects/7", closed: false, updatedAt: "2026-08-31T12:00:00Z",
        items: {
          totalCount: 42,
          // A draft item (content: null) and an unknown state must BOTH count as neither, which is
          // what makes open + closed less than the item count here.
          nodes: [item("OPEN"), item("OPEN"), item("CLOSED"), item("MERGED"), item(), item("QUEUED")],
        },
        repositories: { nodes: [{ nameWithOwner: "x/base-studio-code" }, { nameWithOwner: "x/mobile" }] },
      },
    ],
  },
  {
    name: "totalCount is the HEADLINE number and is independent of the fetched page",
    projects: [
      {
        id: "PVT_2", number: 1, title: "Big Board", shortDescription: null,
        url: "https://github.com/users/x/projects/1", closed: true, updatedAt: "2026-01-02T03:04:05Z",
        items: { totalCount: 100, nodes: [item("OPEN")] },
        repositories: { nodes: [] },
      },
    ],
  },
  {
    name: "no items and no repos",
    projects: [
      {
        id: "PVT_3", number: 2, title: "Empty", shortDescription: null,
        url: "https://github.com/users/x/projects/2", closed: false, updatedAt: "2026-02-02T00:00:00Z",
        items: { totalCount: 0, nodes: [] },
        repositories: { nodes: [] },
      },
    ],
  },
  { name: "no projects at all", projects: [] },
  {
    name: "several boards keep their order",
    projects: [
      {
        id: "PVT_B", number: 9, title: "Beta", shortDescription: "b",
        url: "u9", closed: false, updatedAt: "2026-03-01T00:00:00Z",
        items: { totalCount: 2, nodes: [item("OPEN"), item("CLOSED")] },
        repositories: { nodes: [{ nameWithOwner: "x/beta" }] },
      },
      {
        id: "PVT_A", number: 8, title: "Alpha", shortDescription: null,
        url: "u8", closed: true, updatedAt: "2026-03-02T00:00:00Z",
        items: { totalCount: 1, nodes: [item("MERGED")] },
        repositories: { nodes: [{ nameWithOwner: "x/alpha" }] },
      },
    ],
  },
];

/** Records → the inflated shape the progress meters recompute from. */
const RECORDS: { name: string; record: MinimalGhProject }[] = [
  {
    name: "stubs are synthesized so the progress fraction is reproduced exactly",
    record: {
      id: "PVT_1", number: 7, title: "Studio Code", shortDescription: "the desktop host",
      url: "u", closed: false, updatedAt: "2026-08-31T12:00:00Z",
      itemsTotalCount: 42, openCount: 2, closedCount: 3, repos: ["x/base-studio-code"],
    },
  },
  {
    name: "a record with no items synthesizes no stubs",
    record: {
      id: "PVT_3", number: 2, title: "Empty", shortDescription: null,
      url: "u", closed: false, updatedAt: "2026-02-02T00:00:00Z",
      itemsTotalCount: 0, openCount: 0, closedCount: 0, repos: [],
    },
  },
];

const rec = (title: string, id = title): MinimalGhProject => ({
  id, number: 1, title, shortDescription: null, url: "u", closed: false,
  updatedAt: "2026-01-01T00:00:00Z", itemsTotalCount: 0, openCount: 0, closedCount: 0, repos: [],
});

/**
 * THE DON'T-RESURRECT RULE. Each of the three match paths gets its own case, because a port that
 * implemented only the title match would still pass a corpus whose keys are all name-derived.
 */
const FILTERS: { name: string; records: MinimalGhProject[]; locals: { key: string; title: string }[] }[] = [
  {
    name: "MATCH PATH 1 — the local key is the record's name-derived projectSlug",
    records: [rec("Studio Code")],
    locals: [{ key: "studio-code", title: "something else entirely" }],
  },
  {
    name: "MATCH PATH 2 — a grandfathered hub keyed by the legacy sanitizeProjectKey",
    records: [rec("My Project!")],
    locals: [{ key: "My_Project_", title: "unrelated" }],
  },
  {
    name: "MATCH PATH 3 — the titles match case-insensitively, whatever the key is",
    records: [rec("Studio Code")],
    locals: [{ key: "p-9f3a2b", title: "STUDIO CODE" }],
  },
  {
    name: "THE RULE ITSELF — a record with no local project is DROPPED, never resurrected",
    records: [rec("Deleted Project"), rec("Studio Code")],
    locals: [{ key: "studio-code", title: "Studio Code" }],
  },
  // These two pin the RESULT, not the short-circuit. Verified by probe: deleting the
  // `locals.length === 0` guard changes nothing, because with no locals every predicate is false and
  // the filter returns empty regardless. The guards are an optimisation the source happens to have.
  { name: "no records — empty in, empty out", records: [], locals: [{ key: "studio-code", title: "Studio Code" }] },
  { name: "no locals — everything is dropped, since nothing can vouch for a record", records: [rec("Studio Code")], locals: [] },
  {
    name: "surviving records keep their ORDER, not the locals' order",
    records: [rec("Zulu"), rec("Alpha"), rec("Mike")],
    locals: [{ key: "alpha", title: "Alpha" }, { key: "mike", title: "Mike" }, { key: "zulu", title: "Zulu" }],
  },
];

function build() {
  return {
    note: "GENERATED from the live TypeScript — see githubState.fixtures.gen.test.ts",
    fetches: FETCHES.map(({ name, projects }) => ({ name, projects, records: toMinimalGhProjects(projects) })),
    inflate: RECORDS.map(({ name, record }) => ({ name, record, project: minimalToGhProject(record) })),
    filters: FILTERS.map(({ name, records, locals }) => ({
      name, records, locals, kept: filterRecordsToLocal(records, locals),
    })),
  };
}

describe("the persisted GitHub board model is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const built = build();
    const text = JSON.stringify(built, null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("pins every item-state rule, including the two that count as NEITHER", () => {
    const built = build();
    const r = built.fetches[0].records[0];
    expect(r.openCount, "two OPEN").toBe(2);
    expect(r.closedCount, "CLOSED + MERGED").toBe(2);
    expect(r.itemsTotalCount, "the headline count, not the page").toBe(42);
    expect(r.openCount + r.closedCount, "a draft and an unknown state count as neither").toBeLessThan(
      built.fetches[0].projects[0].items.nodes.length,
    );
  });

  /** Each match path must be reachable ALONE, or a port could implement one and pass. */
  it("exercises each of the three match paths in isolation", () => {
    const built = build();
    for (const n of ["MATCH PATH 1", "MATCH PATH 2", "MATCH PATH 3"]) {
      const c = built.filters.find((f) => f.name.startsWith(n));
      expect(c, n).toBeDefined();
      expect(c!.kept.length, `${n} must keep exactly one record`).toBe(1);
    }
  });

  it("pins the don't-resurrect rule with a record that has no local project", () => {
    const built = build();
    const c = built.filters.find((f) => f.name.startsWith("THE RULE ITSELF"))!;
    expect(c.kept.map((r) => r.title)).toEqual(["Studio Code"]);
  });
});
