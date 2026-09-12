// The GitHub cache says WHEN it was fetched, and "never fetched" is its own answer
// (`frontend-state-7-the-github-cluster-is-an-honest-cache`).
//
// The defect this pins is the one every slice under `epic-the-frontend-derives-its-state-from-the-crates`
// has removed somewhere else: AN ABSENCE RENDERING AS A FACT. `githubRepos: []` is what the store holds
// when the fetch never ran, when it failed, when there is no token — and when the account genuinely has
// no repositories. Four different situations, one rendering.
//
// These are assertions about the three answers being KEPT APART. A test that only checked `fresh` would
// pass against a module that collapsed `stale` into it, and a test that only checked the happy path would
// pass against one that returned an empty list for a cache nobody ever filled.
import { describe, it, expect } from "vitest";
import { DEFAULT_MAX_AGE_SECS } from "@/shared/lib/github/github";
import {
  readGithubCache,
  cachedValue,
  isFreshCache,
  githubCacheNote,
  describeCacheAge,
  GITHUB_CACHE_FRESH_MS,
} from "@/shared/lib/github/githubState";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

/** A read of a value that WAS fetched `agoMs` ago. */
const at = <T,>(value: T, agoMs: number) =>
  readGithubCache({ hydrated: true, value, fetchedAt: NOW - agoMs, now: NOW });

describe("the freshness window is the app's ONE window", () => {
  it("equals DEFAULT_MAX_AGE_SECS, so the backend and the renderer cannot disagree", () => {
    // The number is declared twice — here and in `github.ts` — because importing `github.ts` into the
    // pure model would create a cycle through the store. This is what stops the duplication drifting
    // into the exact disagreement it was duplicated to avoid: the backend serving a body it calls
    // fresh while the renderer labels the same age stale.
    expect(GITHUB_CACHE_FRESH_MS).toBe(DEFAULT_MAX_AGE_SECS * 1000);
  });
});

describe("never-fetched is its own answer, and never an empty one", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["zero — the epoch is not a fetch time", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("a %s fetch time reads never-fetched", (_label, fetchedAt) => {
    const view = readGithubCache({ hydrated: true, value: [], fetchedAt: fetchedAt as number, now: NOW });
    expect(view?.status).toBe("never-fetched");
    expect(view?.fetchedAt).toBeNull();
    expect(view?.ageMs).toBeNull();
  });

  it("withholds the VALUE, so an unprovenanced list cannot be rendered as the answer", () => {
    // The legacy-snapshot case: 84 real repos with no recorded fetch time. We cannot say when they
    // were loaded, so we must not present them. Handing the array back here is what would let a
    // caller render "84 repos accessible" about a fetch nobody can date.
    const view = readGithubCache({ hydrated: true, value: ["a", "b"], fetchedAt: undefined, now: NOW });
    expect(view?.status).toBe("never-fetched");
    expect(view?.value).toBeNull();
    expect(cachedValue(view)).toBeNull();
  });

  it("is DISTINCT from a genuinely empty list that WAS fetched", () => {
    // The whole point of the slice, in one assertion. Same rendered value, different answers.
    const neverRan = readGithubCache({ hydrated: true, value: [], fetchedAt: null, now: NOW });
    const trulyEmpty = at([], 1 * MIN);
    expect(neverRan?.status).toBe("never-fetched");
    expect(trulyEmpty?.status).toBe("fresh");
    expect(cachedValue(neverRan)).toBeNull();
    expect(cachedValue(trulyEmpty)).toEqual([]);
  });
});

describe("fresh and stale are kept apart", () => {
  it("inside the window is fresh", () => {
    expect(at(["r"], 1 * MIN)?.status).toBe("fresh");
  });

  it("exactly AT the window is still fresh — the boundary is inclusive", () => {
    expect(at(["r"], GITHUB_CACHE_FRESH_MS)?.status).toBe("fresh");
  });

  it("one millisecond past the window is stale", () => {
    expect(at(["r"], GITHUB_CACHE_FRESH_MS + 1)?.status).toBe("stale");
  });

  it("a stale value is still DISPLAYABLE — stale means unvouched-for, not gone", () => {
    const view = at(["r"], 9 * 60 * MIN);
    expect(view?.status).toBe("stale");
    expect(cachedValue(view)).toEqual(["r"]);
    expect(isFreshCache(view)).toBe(false);
  });

  it("reports the age it measured, clamped at zero for a clock that stepped backwards", () => {
    expect(at(["r"], 5 * MIN)?.ageMs).toBe(5 * MIN);
    expect(readGithubCache({ hydrated: true, value: 1, fetchedAt: NOW + 10_000, now: NOW })?.ageMs).toBe(0);
  });
});

describe("a read that could not run is null, and is not a verdict about the account", () => {
  it("an unhydrated store answers null rather than never-fetched", () => {
    // Before hydration every field holds its DEFAULT, so `githubRepos` is `[]` for a reason that has
    // nothing to do with GitHub. Reporting that as never-fetched would be a claim; null is the
    // admission, and it is why the caller keeps whatever it was already showing.
    expect(readGithubCache({ hydrated: false, value: [], fetchedAt: NOW, now: NOW })).toBeNull();
  });

  it("stays null even when a perfectly good value and fetch time are present", () => {
    expect(readGithubCache({ hydrated: false, value: ["r"], fetchedAt: NOW - 1000, now: NOW })).toBeNull();
  });

  it("cachedValue and isFreshCache both fold a null read to nothing", () => {
    expect(cachedValue(null)).toBeNull();
    expect(isFreshCache(null)).toBe(false);
  });
});

describe("nothing latches", () => {
  it("the SAME cached value decays fresh → stale on its own, with no write anywhere", () => {
    // This is the property that makes a failed refetch safe. The refetch does not move `fetchedAt`,
    // so the answer changes by itself as time passes; nothing has to remember to invalidate, and
    // there is no cached verdict that could get stuck reading `fresh`.
    const fetchedAt = NOW;
    const fresh = readGithubCache({ hydrated: true, value: ["r"], fetchedAt, now: NOW + 1 * MIN });
    const stale = readGithubCache({ hydrated: true, value: ["r"], fetchedAt, now: NOW + 60 * MIN });
    expect(fresh?.status).toBe("fresh");
    expect(stale?.status).toBe("stale");
    // …and the value itself was never blanked on the way.
    expect(cachedValue(stale)).toEqual(["r"]);
  });

  it("holds no state between calls — the same inputs always give the same answer", () => {
    const a = at(["r"], 2 * MIN);
    const b = at(["r"], 2 * MIN);
    expect(a).toEqual(b);
  });
});

describe("how each answer RENDERS", () => {
  it("fresh renders no note at all — a current value needs no qualifier", () => {
    expect(githubCacheNote(at(["r"], 1 * MIN))).toBeNull();
  });

  it("never-fetched says so in words", () => {
    expect(githubCacheNote(readGithubCache({ hydrated: true, value: [], fetchedAt: null }))).toBe("never fetched");
  });

  it("stale is labelled with WHEN, so it is never mistaken for current", () => {
    expect(githubCacheNote(at(["r"], 90 * MIN))).toBe("last fetched 1h ago");
  });

  it("a read that could not run says it is still loading, not that there is nothing", () => {
    expect(githubCacheNote(null)).toBe("loading…");
  });

  it("EVERY non-fresh answer produces a note — nothing unvouched-for can render bare", () => {
    // The generalisation, so a fourth status added later cannot silently render with no qualifier.
    for (const view of [
      readGithubCache({ hydrated: true, value: [], fetchedAt: null }),
      at(["r"], 99 * MIN),
      null,
    ]) {
      expect(githubCacheNote(view)).toBeTruthy();
    }
  });
});

describe("describeCacheAge", () => {
  it.each([
    [0, "just now"],
    [30_000, "just now"],
    [1 * MIN, "1m ago"],
    [59 * MIN, "59m ago"],
    [60 * MIN, "1h ago"],
    [23 * 60 * MIN, "23h ago"],
    [24 * 60 * MIN, "1d ago"],
    [10 * 24 * 60 * MIN, "10d ago"],
  ])("%dms reads %s", (ms, expected) => {
    expect(describeCacheAge(ms)).toBe(expected);
  });
});
