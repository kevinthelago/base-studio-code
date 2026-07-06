import { describe, it, expect } from "vitest";
import { resolveReopen } from "./reopenProject";
import { projectSlug } from "@/shared/lib/core/projectPaths";
import type { LocalProjectLite } from "./drafts";

const lp = (over: Partial<LocalProjectLite> & { key: string }): LocalProjectLite => ({
  title: over.key, hasPlan: true, updatedAt: 0, published: false, ...over,
});

describe("resolveReopen (#2409 — reopen is derivation, not lookup)", () => {
  it("resolves a board project straight to the hub at its name-derived key (the 'video game' regression)", () => {
    // The bug history: the alias got the RAW title ("video game"), so recovery read the wrong hub.
    // Now the key derives — slug("Video Game") = "video-game" — and the hub at that key wins, no
    // lookup table anywhere.
    const locals = [lp({ key: "video-game", title: "Video Game", published: true }), lp({ key: "other" })];
    const res = resolveReopen("Video Game", locals);
    expect(res.key).toBe("video-game");
    expect(res.hub?.key).toBe("video-game");
    expect(res.candidates).toHaveLength(0); // direct hit — no modal
  });

  it("derives the same key regardless of the title's casing/spacing (one hub, ever)", () => {
    const locals = [lp({ key: "video-game", title: "Video Game" })];
    for (const title of ["video game", "VIDEO GAME", "  Video  Game  "]) {
      expect(resolveReopen(title, locals).hub?.key).toBe("video-game");
    }
  });

  it("mismatch: no hub at the slug → every local hub is a candidate, legacy title-key first", () => {
    // A grandfathered pre-#2409 hub sits at the LEGACY sanitize key ("Video_Game"); a newer
    // unrelated hub exists too. The legacy exact-key match must rank first and be the suggestion.
    const legacy = lp({ key: "Video_Game", title: "some goal-derived name", updatedAt: 1 });
    const other = lp({ key: "unrelated", title: "Unrelated", updatedAt: 99 });
    const res = resolveReopen("Video Game", [other, legacy]);
    expect(res.hub).toBeNull();
    expect(res.key).toBe("video-game");
    expect(res.candidates[0].key).toBe("Video_Game");
    expect(res.suggested?.key).toBe("Video_Game");
  });

  it("mismatch: a case-insensitive title match outranks unrelated hubs and is suggested", () => {
    // A legacy minted-id hub (#1741) is only findable by its stored title.
    const minted = lp({ key: "p-abc123-xyz", title: "video game", updatedAt: 1 });
    const other = lp({ key: "unrelated", title: "Unrelated", updatedAt: 99 });
    const res = resolveReopen("Video Game", [other, minted]);
    expect(res.hub).toBeNull();
    expect(res.candidates[0].key).toBe("p-abc123-xyz");
    expect(res.suggested?.key).toBe("p-abc123-xyz");
  });

  it("mismatch with no plausible match: candidates by recency, NOTHING auto-suggested", () => {
    const a = lp({ key: "aaa", title: "Alpha", updatedAt: 1 });
    const b = lp({ key: "bbb", title: "Beta", updatedAt: 2 });
    const res = resolveReopen("Brand New Thing", [a, b]);
    expect(res.hub).toBeNull();
    expect(res.candidates.map((c) => c.key)).toEqual(["bbb", "aaa"]); // recency order
    expect(res.suggested).toBeNull(); // never preselect an unrelated hub
  });

  it("no local hubs at all → empty candidates (callers open fresh, no modal)", () => {
    const res = resolveReopen("Anything", []);
    expect(res.hub).toBeNull();
    expect(res.candidates).toHaveLength(0);
    // Defensive: a non-array locals list behaves the same (#874-style guard).
    expect(resolveReopen("Anything", undefined as unknown as LocalProjectLite[]).candidates).toHaveLength(0);
  });

  it("the derived key always equals projectSlug(title) — the ONE identity every store shares", () => {
    for (const title of ["Video Game", "Acme Payments v2!", "🎮🎮"]) {
      expect(resolveReopen(title, []).key).toBe(projectSlug(title));
    }
  });
});
