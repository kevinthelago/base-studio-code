import { describe, it, expect } from "vitest";
import { grandfatherTriaged, grandfatherLocalPublished } from "./triagedMigration";

const NOW = 1_720_000_000_000;

describe("grandfatherTriaged (#2548)", () => {
  it("marks every published project by its plan key (projectSlug of the board title)", () => {
    const t = grandfatherTriaged([{ title: "Video Game" }, { title: "test with kit" }], {}, NOW);
    expect(t).toEqual({ "video-game": NOW, "test-with-kit": NOW });
  });

  it("marks every project with a planned fleet (streams present)", () => {
    const t = grandfatherTriaged([], { "test-with-kit": { streams: [{ id: "s" }] }, empty: { streams: [] } }, NOW);
    expect(t).toEqual({ "test-with-kit": NOW }); // the empty-fleet project is not grandfathered
  });

  it("unions published + fleeted (a project in both is stamped once)", () => {
    const t = grandfatherTriaged([{ title: "test with kit" }], { "test-with-kit": { streams: [{ id: "s" }] } }, NOW);
    expect(Object.keys(t)).toEqual(["test-with-kit"]);
    expect(t["test-with-kit"]).toBe(NOW);
  });

  it("tolerates missing/empty inputs and records without a title", () => {
    expect(grandfatherTriaged(undefined, undefined, NOW)).toEqual({});
    expect(grandfatherTriaged([{}, { title: "" }], {}, NOW)).toEqual({});
  });
});

describe("grandfatherLocalPublished (#2548 follow-up — local inventory repair)", () => {
  it("stamps every local published hub key by its folder key", () => {
    const t = grandfatherLocalPublished(["Beautiful_Emails", "cancer"], {}, NOW);
    expect(t).toEqual({ Beautiful_Emails: NOW, cancer: NOW });
  });

  it("preserves an already-marked key's timestamp (idempotent, keeps the first)", () => {
    const t = grandfatherLocalPublished(["a", "b"], { a: 111 }, NOW);
    expect(t).toEqual({ a: 111, b: NOW });
  });

  it("tolerates empty/falsey keys", () => {
    expect(grandfatherLocalPublished([], {}, NOW)).toEqual({});
    expect(grandfatherLocalPublished(["", "x"], {}, NOW)).toEqual({ x: NOW });
  });

  it("recovers the empty-triaged case the persist migration missed (empty board/fleets + local hubs)", () => {
    // the exact repro: persisted github records + fleets were empty, so grandfatherTriaged produced {},
    // but the on-disk inventory has published hubs → the repair restores them.
    const fromMigration = grandfatherTriaged(undefined, undefined, NOW);
    expect(fromMigration).toEqual({});
    const repaired = grandfatherLocalPublished(["STEM", "Mantle"], fromMigration, NOW);
    expect(Object.keys(repaired).sort()).toEqual(["Mantle", "STEM"]);
  });
});
