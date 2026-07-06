// #2446 — the persisted GitHub-state model: fetched boards boil down to minimal records (progress
// counts derived like projectProgress), expand back losslessly for the existing rendering paths, and
// the local-existence filter enforces the don't-resurrect rule.
import { describe, it, expect } from "vitest";
import {
  toMinimalGhProjects, minimalToGhProject, filterRecordsToLocal,
  type GhProjectShape, type MinimalGhProject,
} from "./githubState";

const wire = (over: Partial<GhProjectShape> = {}): GhProjectShape => ({
  id: "PVT_1", number: 3, title: "Acme CRM", shortDescription: "a crm", url: "https://gh/p/3",
  closed: false, updatedAt: "2026-07-01T00:00:00Z",
  items: {
    totalCount: 6,
    nodes: [
      { content: { state: "OPEN" } },
      { content: { state: "OPEN" } },
      { content: { state: "CLOSED" } },
      { content: { state: "MERGED" } }, // a merged PR counts as closed (mirrors projectProgress)
      { content: null },                // a draft item counts as neither
    ],
  },
  repositories: { nodes: [{ nameWithOwner: "o/r1" }, { nameWithOwner: "o/r2" }] },
  ...over,
});

const record = (over: Partial<MinimalGhProject> = {}): MinimalGhProject => ({
  id: "PVT_1", number: 3, title: "Acme CRM", shortDescription: null, url: "", closed: false,
  updatedAt: "", itemsTotalCount: 4, openCount: 3, closedCount: 1, repos: ["o/r"],
  ...over,
});

describe("toMinimalGhProjects", () => {
  it("derives open/closed counts from the item states (MERGED ⇒ closed; drafts ⇒ neither)", () => {
    const [r] = toMinimalGhProjects([wire()]);
    expect(r).toMatchObject({
      id: "PVT_1", number: 3, title: "Acme CRM", shortDescription: "a crm", url: "https://gh/p/3",
      closed: false, updatedAt: "2026-07-01T00:00:00Z",
      itemsTotalCount: 6, openCount: 2, closedCount: 2, repos: ["o/r1", "o/r2"],
    });
  });
});

describe("minimalToGhProject", () => {
  it("expands back to the GhProject shape with the SAME progress a projectProgress-style scan derives", () => {
    const p = minimalToGhProject(record({ itemsTotalCount: 9, openCount: 3, closedCount: 2 }));
    expect(p.items.totalCount).toBe(9);
    const states = p.items.nodes.map((n) => n.content?.state);
    expect(states.filter((s) => s === "OPEN")).toHaveLength(3);
    expect(states.filter((s) => s === "CLOSED")).toHaveLength(2);
    expect(p.repositories.nodes).toEqual([{ nameWithOwner: "o/r" }]);
  });

  it("round-trips through toMinimalGhProjects unchanged", () => {
    const r = record({ itemsTotalCount: 5, openCount: 2, closedCount: 3, repos: ["a/b"] });
    expect(toMinimalGhProjects([minimalToGhProject(r)])).toEqual([r]);
  });
});

describe("filterRecordsToLocal — the don't-resurrect rule (#2446)", () => {
  it("keeps a record whose slug(title) matches a local key (today's name-derived hubs)", () => {
    const out = filterRecordsToLocal([record()], [{ key: "acme-crm", title: "whatever" }]);
    expect(out).toHaveLength(1);
  });

  it("keeps a record covering a LEGACY sanitize-keyed hub or a case-insensitive title match", () => {
    // Legacy `sanitizeProjectKey("Acme CRM")` keeps case → "Acme_CRM".
    expect(filterRecordsToLocal([record()], [{ key: "Acme_CRM", title: "x" }])).toHaveLength(1);
    // A minted-id hub matches by title (same set the #2445 overlay uses).
    expect(filterRecordsToLocal([record()], [{ key: "p-legacy1", title: "acme crm" }])).toHaveLength(1);
  });

  it("drops a record whose project no longer exists locally (deleted hub is NOT resurrected)", () => {
    const out = filterRecordsToLocal(
      [record(), record({ id: "PVT_2", title: "Ghost App" })],
      [{ key: "acme-crm", title: "Acme CRM" }],
    );
    expect(out.map((r) => r.title)).toEqual(["Acme CRM"]);
  });

  it("returns [] when nothing exists locally", () => {
    expect(filterRecordsToLocal([record()], [])).toEqual([]);
  });
});
