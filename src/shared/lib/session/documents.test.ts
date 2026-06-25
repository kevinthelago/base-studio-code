import { describe, it, expect } from "vitest";
import {
  filterDocuments, scopeToProject, DOC_FILTERS,
  collectTags, filterByTags, matchesQuery, selectDocuments, groupByKind,
  type Doc,
} from "./documents";

const doc = (p: Partial<Doc> & Pick<Doc, "relpath" | "kind">): Doc => ({
  name: p.relpath.split("/").pop()!,
  title: p.title ?? p.relpath.split("/").pop()!.replace(/\.md$/, ""),
  project: p.project ?? null,
  repo: p.repo ?? null,
  tags: p.tags ?? [],
  size_bytes: p.size_bytes ?? 0,
  modified_secs: p.modified_secs ?? 0,
  ...p,
});

const DOCS: Doc[] = [
  doc({ relpath: "documents/rust-errors.md", title: "Rust error handling", kind: "reusable", tags: ["rust"] }),
  doc({ relpath: "documents/react-testing.md", title: "React testing", kind: "reusable", tags: ["react", "vitest"] }),
  doc({ relpath: "projects/WoTos/goal.md", title: "Goal", kind: "project", project: "WoTos" }),
  doc({ relpath: "projects/WoTos/architecture.md", title: "Architecture", kind: "project", project: "WoTos" }),
  doc({ relpath: "projects/WoTos/wotos-ui/CLAUDE.local.md", title: "wotos-ui plan", kind: "repo", project: "WoTos", repo: "wotos-ui" }),
];

describe("filterDocuments", () => {
  it("returns everything for filter 'all' and an empty query", () => {
    expect(filterDocuments(DOCS, "all", "")).toHaveLength(DOCS.length);
  });

  it("filters by kind", () => {
    expect(filterDocuments(DOCS, "reusable", "").map(d => d.relpath)).toEqual([
      "documents/rust-errors.md", "documents/react-testing.md",
    ]);
    expect(filterDocuments(DOCS, "project", "").every(d => d.kind === "project")).toBe(true);
    expect(filterDocuments(DOCS, "repo", "")).toHaveLength(1);
  });

  it("searches title, tags, project, and repo case-insensitively", () => {
    expect(filterDocuments(DOCS, "all", "REACT").map(d => d.relpath)).toEqual(["documents/react-testing.md"]);
    expect(filterDocuments(DOCS, "all", "vitest").map(d => d.relpath)).toEqual(["documents/react-testing.md"]);
    // Project key is searchable — all three WoTos docs match.
    expect(filterDocuments(DOCS, "all", "wotos")).toHaveLength(3);
    // Repo name is searchable.
    expect(filterDocuments(DOCS, "all", "wotos-ui").map(d => d.relpath)).toEqual([
      "projects/WoTos/wotos-ui/CLAUDE.local.md",
    ]);
  });

  it("combines kind filter and query", () => {
    // 'goal' only exists under the project kind.
    expect(filterDocuments(DOCS, "reusable", "goal")).toHaveLength(0);
    expect(filterDocuments(DOCS, "project", "goal").map(d => d.relpath)).toEqual(["projects/WoTos/goal.md"]);
  });

  it("preserves input order (backend already sorts by recency)", () => {
    const ordered = filterDocuments(DOCS, "all", "");
    expect(ordered.map(d => d.relpath)).toEqual(DOCS.map(d => d.relpath));
  });

  it("exposes the filter chips in display order", () => {
    expect(DOC_FILTERS).toEqual(["all", "reusable", "project", "repo"]);
  });
});

describe("scopeToProject", () => {
  it("keeps project and repo docs whose key is one of the candidate keys", () => {
    const out = scopeToProject(DOCS, ["WoTos"]);
    expect(out.map(d => d.relpath)).toEqual([
      "projects/WoTos/goal.md", "projects/WoTos/architecture.md", "projects/WoTos/wotos-ui/CLAUDE.local.md",
    ]);
  });

  it("matches any of several candidate keys (a project can have >1 folder)", () => {
    const docs: Doc[] = [
      doc({ relpath: "projects/WoToS/goal.md", kind: "project", project: "WoToS" }),
      doc({ relpath: "projects/PVT_abc/goal.md", kind: "project", project: "PVT_abc" }),
      doc({ relpath: "projects/Other/goal.md", kind: "project", project: "Other" }),
    ];
    expect(scopeToProject(docs, ["WoToS", "PVT_abc"]).map(d => d.project)).toEqual(["WoToS", "PVT_abc"]);
  });

  it("excludes reusable docs even if a key coincides", () => {
    expect(scopeToProject(DOCS, ["WoTos"]).every(d => d.kind === "project" || d.kind === "repo")).toBe(true);
  });

  it("returns nothing for an empty key list", () => {
    expect(scopeToProject(DOCS, [])).toEqual([]);
  });
});

describe("collectTags", () => {
  it("returns the distinct tags across all docs, sorted", () => {
    expect(collectTags(DOCS)).toEqual(["react", "rust", "vitest"]);
  });

  it("returns an empty list when no doc carries tags", () => {
    expect(collectTags([doc({ relpath: "a.md", kind: "project", project: "x" })])).toEqual([]);
  });
});

describe("filterByTags", () => {
  it("imposes no constraint for an empty selection", () => {
    expect(filterByTags(DOCS, [])).toHaveLength(DOCS.length);
  });

  it("keeps docs carrying the selected tag", () => {
    expect(filterByTags(DOCS, ["react"]).map(d => d.relpath)).toEqual(["documents/react-testing.md"]);
  });

  it("requires ALL selected tags (AND semantics)", () => {
    expect(filterByTags(DOCS, ["react", "vitest"]).map(d => d.relpath)).toEqual(["documents/react-testing.md"]);
    // rust + react is carried by no single doc.
    expect(filterByTags(DOCS, ["rust", "react"])).toHaveLength(0);
  });
});

describe("matchesQuery (full-text incl. body)", () => {
  const d = DOCS[0]; // Rust error handling, tag rust

  it("matches everything for an empty query", () => {
    expect(matchesQuery(d, "")).toBe(true);
  });

  it("matches the title case-insensitively without a body", () => {
    expect(matchesQuery(d, "ERROR")).toBe(true);
    expect(matchesQuery(d, "react")).toBe(false);
  });

  it("matches body content only when the body is supplied", () => {
    expect(matchesQuery(d, "anyhow")).toBe(false);
    expect(matchesQuery(d, "anyhow", "Use the anyhow crate for context.")).toBe(true);
  });

  it("still matches metadata (tags/project/repo) so existing search keeps working", () => {
    expect(matchesQuery(d, "rust")).toBe(true);
  });
});

describe("selectDocuments (kind + tags + query pipeline)", () => {
  it("composes the source filter, tag facet, and free-text query", () => {
    const out = selectDocuments(DOCS, { filter: "reusable", tags: ["react"], query: "test" });
    expect(out.map(d => d.relpath)).toEqual(["documents/react-testing.md"]);
  });

  it("searches bodies via the injected map", () => {
    const bodies = { "documents/rust-errors.md": "prefer the thiserror derive" };
    const out = selectDocuments(DOCS, { filter: "all", tags: [], query: "thiserror" }, bodies);
    expect(out.map(d => d.relpath)).toEqual(["documents/rust-errors.md"]);
  });

  it("returns everything for the default selection", () => {
    expect(selectDocuments(DOCS, { filter: "all", tags: [], query: "" })).toHaveLength(DOCS.length);
  });
});

describe("groupByKind", () => {
  it("buckets docs under reusable/project/repo headers in display order", () => {
    const groups = groupByKind(DOCS);
    expect(groups.map(g => g.kind)).toEqual(["reusable", "project", "repo"]);
    expect(groups[0].docs).toHaveLength(2);
    expect(groups[1].docs).toHaveLength(2);
    expect(groups[2].docs).toHaveLength(1);
  });

  it("drops empty groups", () => {
    const onlyReusable = DOCS.filter(d => d.kind === "reusable");
    expect(groupByKind(onlyReusable).map(g => g.kind)).toEqual(["reusable"]);
  });
});
