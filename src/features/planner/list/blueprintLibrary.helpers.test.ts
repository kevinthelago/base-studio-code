import { describe, it, expect } from "vitest";
import { buildBlueprintItems, catHue, prettyGist } from "./blueprintLibrary.helpers";
import type { Blueprint } from "../stages/blueprints";
import type { DraftRow } from "./drafts";

const bp = (over: Partial<Blueprint> & { id: string; name: string }): Blueprint => ({
  desc: "", sections: [], category: "greenfield", ...over,
});
const draft = (over: Partial<DraftRow> & { key: string }): DraftRow => ({
  title: over.key, pitch: "", sort: 0, ...over,
});

describe("prettyGist", () => {
  it("returns undefined for a missing gist", () => {
    expect(prettyGist(undefined)).toBeUndefined();
  });
  it("strips protocol/www and truncates a long url", () => {
    expect(prettyGist({ state: "synced", url: "https://www.gist.github.com/short" })).toBe("gist.github.com/short");
    const long = "https://example.com/" + "a".repeat(40);
    const out = prettyGist({ state: "synced", url: long })!;
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(31); // 30 chars + ellipsis
  });
  it("falls back to a shortened id when there is no url", () => {
    expect(prettyGist({ state: "synced", id: "abcdef1234567" })).toBe("gist · abcdef1");
  });
});

describe("catHue", () => {
  it("produces an oklch string keyed by the category hue", () => {
    expect(catHue("greenfield")).toMatch(/^oklch\(0\.75 0\.13 \d/);
  });
  it("uses the fallback hue for an unknown category", () => {
    expect(catHue("nope" as never)).toBe("oklch(0.75 0.13 70)");
  });
});

describe("buildBlueprintItems", () => {
  it("maps library blueprints, flagging built-ins and gist labels", () => {
    const items = buildBlueprintItems(
      [
        bp({ id: "a", name: "Alpha", origin: "built-in", sections: [{} as never, {} as never] }),
        bp({ id: "b", name: "Beta", gist: { state: "synced", id: "deadbeef99" } }),
      ],
      [],
      {},
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "a", kind: "library", name: "Alpha", builtIn: true, stages: 2 });
    expect(items[1]).toMatchObject({ id: "b", kind: "library", gistLabel: "gist · deadbee" });
  });

  it("appends authoring drafts as draft items", () => {
    const items = buildBlueprintItems([], [draft({ key: "k1", title: "Draft One", pitch: "p" })], {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "draft:k1", kind: "draft", draftKey: "k1", name: "Draft One", pitch: "p" });
  });

  it("lets a saved blueprint win the name dedup over an open draft", () => {
    const items = buildBlueprintItems(
      [bp({ id: "a", name: "Shared" })],
      [draft({ key: "k1", title: "shared" })],
      {},
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("library");
  });

  it("prefers the plan-authored blueprint's identity for a draft", () => {
    const items = buildBlueprintItems(
      [],
      [draft({ key: "k1", title: "fallback" })],
      { k1: bp({ id: "auth", name: "Authored", category: "harden", sections: [{} as never] }) },
    );
    expect(items[0]).toMatchObject({ name: "Authored", category: "harden", stages: 1 });
  });
});
