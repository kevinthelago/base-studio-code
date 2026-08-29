// The list of pane-keyed maps must not drift from the store (#pane-keyed-store-maps-are-never-pruned).
import { describe, it, expect } from "vitest";
import { PANE_KEYED_MAPS, NOT_PANE_KEYED, looksPaneKeyed, releasePaneState } from "./paneState";
import { useAppStore } from "@/store";

describe("PANE_KEYED_MAPS", () => {
  it("covers every pane-keyed map the store actually declares", () => {
    // THE DRIFT GUARD, and the reason this file exists. A new `paneFoo: Record<string, …>` added to a
    // slice and not listed here would silently start accumulating orphans again — the exact bug this
    // fixes, reintroduced by a one-line addition nobody would think to connect.
    const state = useAppStore.getState() as unknown as Record<string, unknown>;
    const declared = Object.keys(state)
      .filter(looksPaneKeyed)
      .filter((k) => {
        const v = state[k];
        return !!v && typeof v === "object" && !Array.isArray(v);
      })
      .sort();
    // Every map with the shape must be either PRUNED or explicitly EXCLUDED with a reason. A new one
    // that is neither fails here, which is the point — silence is how the orphans accumulated.
    expect(declared).toEqual([...PANE_KEYED_MAPS, ...NOT_PANE_KEYED].sort());
  });
});

describe("NOT_PANE_KEYED", () => {
  it("never overlaps the pruned set", () => {
    // A map in both lists would be pruned AND documented as un-prunable — the two would disagree and
    // the reader could not tell which was true.
    const pruned = new Set<string>(PANE_KEYED_MAPS);
    expect([...NOT_PANE_KEYED].filter((k) => pruned.has(k))).toEqual([]);
  });
});

describe("releasePaneState", () => {
  const state = {
    paneRoles: { a: "worker", b: "director" },
    paneCwds: { a: "/x", b: "/y" },
    paneStatus: { b: "run" },
    // NOT pane-keyed — a credential map keyed by `owner/name`. Must never be touched.
    repoGithubTokens: { "owner/repo": "ghp_secret" },
  } as unknown as Record<string, unknown>;

  it("drops the ids from every pane-keyed map that holds them", () => {
    const out = releasePaneState(state, ["a"]);
    expect(out.paneRoles).toEqual({ b: "director" });
    expect(out.paneCwds).toEqual({ b: "/y" });
  });

  it("leaves maps that are not pane-keyed completely alone", () => {
    // The reason the list is explicit rather than "every object in the state": wrongly deleting a
    // credential costs far more than naming the maps.
    const out = releasePaneState(state, ["owner/repo", "a"]);
    expect(out).not.toHaveProperty("repoGithubTokens");
  });

  it("returns ONLY the maps that changed", () => {
    // Rebuilding untouched maps would replace their identity and invalidate every selector watching
    // them — a re-render storm in the name of tidying up.
    const out = releasePaneState(state, ["a"]);
    expect(Object.keys(out).sort()).toEqual(["paneCwds", "paneRoles"]);
    expect(out).not.toHaveProperty("paneStatus"); // never held "a"
  });

  it("is a no-op for no ids", () => {
    expect(releasePaneState(state, [])).toEqual({});
  });

  it("removes every id it is given", () => {
    const out = releasePaneState(state, ["a", "b"]);
    expect(out.paneRoles).toEqual({});
    expect(out.paneCwds).toEqual({});
    expect(out.paneStatus).toEqual({});
  });
});
