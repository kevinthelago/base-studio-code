import { describe, it, expect } from "vitest";
import { buildDrafts, mergeDbDrafts, type LocalProjectLite, type DraftRow } from "./drafts";
import type { DbProject } from "./projectsDbBridge";

const lp = (over: Partial<LocalProjectLite> & { key: string }): LocalProjectLite => ({
  title: over.key, hasPlan: true, updatedAt: 0, published: false, ...over,
});

describe("buildDrafts", () => {
  it("includes unpublished local hubs that have a plan", () => {
    const out = buildDrafts([lp({ key: "draft-a" }), lp({ key: "draft-b" })], {}, []);
    expect(out.map(d => d.key).sort()).toEqual(["draft-a", "draft-b"]);
  });

  it("skips bare, untitled scaffold dirs (no plan, no title)", () => {
    const out = buildDrafts([lp({ key: "scaffold", hasPlan: false, titled: false })], {}, []);
    expect(out).toHaveLength(0);
  });

  it("includes a user-titled hub even without a plan (#2994 — a named draft, e.g. cli-typer)", () => {
    const out = buildDrafts([lp({ key: "cli-typer", title: "cli typer", hasPlan: false, titled: true })], {}, []);
    expect(out).toEqual([{ key: "cli-typer", title: "cli typer", pitch: "", sort: 0 }]);
  });

  it("excludes a published hub even when its key differs in CASE from the board title (#1449)", () => {
    // The bug: folder key "studio-code" but the GitHub board title is "Studio-Code".
    // sanitizeProjectKey is case-preserving, so the title-derived key is "Studio-Code" and never
    // matched the lowercase folder key — yet the reconcile marked the hub published. The hub must
    // not appear in Drafts: the `.published` marker is authoritative.
    const locals = [lp({ key: "studio-code", title: "studio-code", published: true })];
    const publishedTitleKeys = ["Studio-Code"]; // sanitizeProjectKey("Studio-Code")
    const out = buildDrafts(locals, {}, publishedTitleKeys);
    expect(out).toHaveLength(0);
  });

  it("excludes a published hub even with no matching board title or alias", () => {
    const out = buildDrafts([lp({ key: "village-animation-hospital", published: true })], {}, []);
    expect(out).toHaveLength(0);
  });

  it("still excludes via the GitHub-title key when the hub isn't yet marked published", () => {
    // Reconcile hasn't stamped the marker yet, but the board title sanitizes to the folder key.
    const out = buildDrafts([lp({ key: "my-app", published: false })], {}, ["my-app"]);
    expect(out).toHaveLength(0);
  });

  it("excludes via the name-derived slug key of a board title (#2409)", () => {
    // A slug-keyed hub whose board title slugs onto it — the caller passes BOTH key forms of each
    // board title (projectSlug + legacy sanitize), so either matches.
    const out = buildDrafts([lp({ key: "video-game" })], {}, ["video-game", "Video_Game"]);
    expect(out).toHaveLength(0);
  });

  it("merges the store draft map and prefers the newer sort/pitch", () => {
    const locals = [lp({ key: "k", title: "On disk", updatedAt: 100 })];
    const draftMap = { k: { title: "In store", pitch: "pitched", createdAt: 200 } };
    const out = buildDrafts(locals, draftMap, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "k", title: "In store", pitch: "pitched", sort: 200 });
  });

  it("drops a store-draft-map entry whose hub is published (no resurrection)", () => {
    // A published hub also lingering in the store draft map must not be re-added by the map loop.
    const locals = [lp({ key: "pub", published: true })];
    const draftMap = { pub: { title: "Pub", pitch: "", createdAt: 5 } };
    const out = buildDrafts(locals, draftMap, []);
    expect(out).toHaveLength(0);
  });

  it("tolerates a non-array localProjects (defensive, #874)", () => {
    const out = buildDrafts(undefined as unknown as LocalProjectLite[], { k: { title: "K", pitch: "", createdAt: 1 } }, []);
    expect(out.map(d => d.key)).toEqual(["k"]);
  });
});

const dbRow = (over: Partial<DbProject> & { key: string }): DbProject => ({
  title: over.key, pitch: "", blueprint: null, category: null, state: "drafted", createdAt: 0, updatedAt: 0, ...over,
});

describe("mergeDbDrafts (#2995)", () => {
  it("surfaces a DB `drafted` row the store cache lost (durable restart survival)", () => {
    const out = mergeDbDrafts([], [dbRow({ key: "recovered", title: "Recovered", pitch: "from db", updatedAt: 42 })]);
    expect(out).toEqual([{ key: "recovered", title: "Recovered", pitch: "from db", sort: 42 }]);
  });

  it("also surfaces a `planning`-state DB row", () => {
    const out = mergeDbDrafts([], [dbRow({ key: "mid-plan", title: "Mid Plan", state: "planning" })]);
    expect(out.map(d => d.key)).toEqual(["mid-plan"]);
  });

  it("ignores non-draft DB rows (published / created)", () => {
    const out = mergeDbDrafts([], [
      dbRow({ key: "shipped", state: "published" }),
      dbRow({ key: "built", state: "created" }),
    ]);
    expect(out).toHaveLength(0);
  });

  it("keeps the existing entry's title + pitch when present, taking the newer sort", () => {
    const existing: DraftRow[] = [{ key: "k", title: "On disk", pitch: "rich", sort: 100 }];
    const out = mergeDbDrafts(existing, [dbRow({ key: "k", title: "DB title", pitch: "db pitch", updatedAt: 200 })]);
    expect(out).toEqual([{ key: "k", title: "On disk", pitch: "rich", sort: 200 }]);
  });

  it("borrows the DB title/pitch only when the existing entry has none", () => {
    const existing: DraftRow[] = [{ key: "k", title: "", pitch: "", sort: 0 }];
    const out = mergeDbDrafts(existing, [dbRow({ key: "k", title: "DB title", pitch: "db pitch", createdAt: 5 })]);
    expect(out).toEqual([{ key: "k", title: "DB title", pitch: "db pitch", sort: 5 }]);
  });

  it("is additive — every existing row is kept even with no DB match", () => {
    const existing: DraftRow[] = [{ key: "a", title: "A", pitch: "", sort: 1 }];
    const out = mergeDbDrafts(existing, [dbRow({ key: "b", title: "B" })]);
    expect(out.map(d => d.key).sort()).toEqual(["a", "b"]);
  });

  it("tolerates a non-array dbRows (defensive)", () => {
    const existing: DraftRow[] = [{ key: "a", title: "A", pitch: "", sort: 1 }];
    const out = mergeDbDrafts(existing, undefined as unknown as DbProject[]);
    expect(out).toEqual(existing);
  });
});
