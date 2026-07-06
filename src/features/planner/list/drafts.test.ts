import { describe, it, expect } from "vitest";
import { buildDrafts, type LocalProjectLite } from "./drafts";

const lp = (over: Partial<LocalProjectLite> & { key: string }): LocalProjectLite => ({
  title: over.key, hasPlan: true, updatedAt: 0, published: false, ...over,
});

describe("buildDrafts", () => {
  it("includes unpublished local hubs that have a plan", () => {
    const out = buildDrafts([lp({ key: "draft-a" }), lp({ key: "draft-b" })], {}, []);
    expect(out.map(d => d.key).sort()).toEqual(["draft-a", "draft-b"]);
  });

  it("skips bare scaffold dirs (no plan)", () => {
    const out = buildDrafts([lp({ key: "scaffold", hasPlan: false })], {}, []);
    expect(out).toHaveLength(0);
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
