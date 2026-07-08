import { describe, it, expect } from "vitest";
import { grandfatherTriaged } from "./triagedMigration";

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
