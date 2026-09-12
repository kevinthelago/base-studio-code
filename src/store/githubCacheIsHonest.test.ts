// The GitHub cluster in app-state is a CACHE that says so — and `activeRepoName` is not part of it
// (`frontend-state-7-the-github-cluster-is-an-honest-cache`).
//
// The decision this pins is deliberate and is not being relitigated: GitHub OWNS this data, every row
// is reconstructible by refetching, and a local Rust store would be a second copy of someone else's
// truth that goes stale in silence. So nothing MOVED. What changed is that each cached value now
// carries when it was fetched, and that the one key which is a USER CHOICE is treated as one.
//
// MEASURED before the change, at symbol level: `setGithubRepos` and `setGithubUser` have exactly one
// caller each — `finishConnect` — so both are written at connect and never refetched. `setActiveRepo`
// also has exactly one caller, the same `finishConnect`, which auto-picks `repos[0].full_name`; there
// is no picker anywhere. It is nonetheless a selection, not a cache: GitHub has no notion of "your
// active repo", so it is a copy of nothing and cannot be reconstructed by refetching.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { persistedState, migrateGithubCacheProvenance } from "@/store/persist";
import { readGithubCache, cachedValue } from "@/shared/lib/github/githubState";

const REPO = { full_name: "kevinthelago/base-studio-code", private: false, language: "Rust", open_issues_count: 1, default_branch: "main", description: null, pushed_at: "", stargazers_count: 0 };
const USER = { login: "kevin", name: "Kevin", avatar_url: "x" };

beforeEach(() => {
  useAppStore.setState({
    githubConnected: false, githubToken: "", githubUser: null, githubRepos: [], activeRepoName: "",
    githubReposFetchedAt: null, githubUserFetchedAt: null, githubCheckedAt: null,
  });
});

describe("every cached GitHub value records WHEN it was fetched", () => {
  it("setGithubRepos stamps a fetch time", () => {
    const before = Date.now();
    useAppStore.getState().setGithubRepos([REPO] as never);
    const { githubRepos, githubReposFetchedAt } = useAppStore.getState();
    expect(githubRepos).toHaveLength(1);
    expect(githubReposFetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("an EMPTY fetch is still a fetch — it stamps, and so reads as a true empty", () => {
    // The distinction the whole slice exists for. An account with no repositories has been asked;
    // a cache nobody filled has not. Without the stamp on this path the two are one state again.
    useAppStore.getState().setGithubRepos([] as never);
    const s = useAppStore.getState();
    expect(s.githubReposFetchedAt).toBeTypeOf("number");
    const view = readGithubCache({ hydrated: true, value: s.githubRepos, fetchedAt: s.githubReposFetchedAt });
    expect(view?.status).toBe("fresh");
    expect(cachedValue(view)).toEqual([]);
  });

  it("setGithubUser stamps, and clearing the user clears the stamp with it", () => {
    useAppStore.getState().setGithubUser(USER);
    expect(useAppStore.getState().githubUserFetchedAt).toBeTypeOf("number");
    useAppStore.getState().setGithubUser(null);
    // A stamp without a value would claim a fetch that produced a profile. There is none.
    expect(useAppStore.getState().githubUserFetchedAt).toBeNull();
  });

  it("setGithubConnected records WHEN the credential was checked", () => {
    useAppStore.getState().setGithubConnected(true);
    expect(useAppStore.getState().githubCheckedAt).toBeTypeOf("number");
  });

  it("a never-fetched cache reads as never-fetched, not as an empty account", () => {
    const s = useAppStore.getState();
    const repos = readGithubCache({ hydrated: true, value: s.githubRepos, fetchedAt: s.githubReposFetchedAt });
    const user = readGithubCache({ hydrated: true, value: s.githubUser, fetchedAt: s.githubUserFetchedAt });
    expect(repos?.status).toBe("never-fetched");
    expect(user?.status).toBe("never-fetched");
    expect(cachedValue(repos)).toBeNull();
  });
});

describe("nothing latches on a failed check", () => {
  it("a 401 records the failed check and does NOT blank the cached repos or profile", () => {
    // Both halves. Blanking would throw away usable context because one request failed; leaving the
    // check time untouched would let "synced" keep rendering off a check that has since failed.
    useAppStore.getState().setGithubRepos([REPO] as never);
    useAppStore.getState().setGithubUser(USER);
    useAppStore.getState().setGithubConnected(true);
    const stampedAt = useAppStore.getState().githubReposFetchedAt;

    useAppStore.getState().markGithubTokenInvalid();

    const s = useAppStore.getState();
    expect(s.githubConnected).toBe(false);
    expect(s.githubRepos).toHaveLength(1);        // kept — a failed check is not evidence about the repos
    expect(s.githubUser).not.toBeNull();
    expect(s.githubReposFetchedAt).toBe(stampedAt); // NOT re-stamped — nothing refetched them
    expect(s.githubCheckedAt).toBeTypeOf("number"); // the 401 IS a check, and it happened now
  });

  it("is a no-op when already disconnected, so it cannot re-stamp a check nobody made", () => {
    useAppStore.setState({ githubConnected: false, githubCheckedAt: null });
    useAppStore.getState().markGithubTokenInvalid();
    expect(useAppStore.getState().githubCheckedAt).toBeNull();
  });
});

describe("a user's selection survives a cache eviction", () => {
  it("disconnectGithub clears the CACHE but keeps activeRepoName", () => {
    // `activeRepoName` is the one key in this cluster that is not a copy of anything GitHub owns.
    // Dropping it on disconnect discarded a choice that reconnecting cannot restore — the auto-pick
    // in `finishConnect` would silently substitute `repos[0]` for whatever the user had chosen.
    useAppStore.getState().setGithubRepos([REPO] as never);
    useAppStore.getState().setGithubUser(USER);
    useAppStore.getState().setActiveRepo("kevinthelago/mobile-studio-code");
    useAppStore.getState().setGithubConnected(true);

    useAppStore.getState().disconnectGithub();

    const s = useAppStore.getState();
    expect(s.activeRepoName).toBe("kevinthelago/mobile-studio-code");
    expect(s.githubRepos).toEqual([]);
    expect(s.githubUser).toBeNull();
    expect(s.githubConnected).toBe(false);
  });

  it("clears the fetch times alongside the values, so an evicted cache is never-fetched", () => {
    // A cleared value that KEPT its stamp would read as "fetched recently, and the account is empty".
    useAppStore.getState().setGithubRepos([REPO] as never);
    useAppStore.getState().setGithubUser(USER);
    useAppStore.getState().setGithubConnected(true);

    useAppStore.getState().disconnectGithub();

    const s = useAppStore.getState();
    expect(s.githubReposFetchedAt).toBeNull();
    expect(s.githubUserFetchedAt).toBeNull();
    expect(s.githubCheckedAt).toBeNull();
    expect(readGithubCache({ hydrated: true, value: s.githubRepos, fetchedAt: s.githubReposFetchedAt })?.status)
      .toBe("never-fetched");
  });
});

describe("the cache stays PERSISTED, and the fetch time is what makes that honest", () => {
  it("persists each fetch time beside the value it dates", () => {
    // A warm-start cache is legitimate — it is what stops the first paint flashing "not connected".
    // What is not legitimate is it being indistinguishable from authority, and a value persisted
    // WITHOUT its stamp would come back from a restart looking exactly like a fresh fetch.
    const snap = persistedState(useAppStore.getState()) as Record<string, unknown>;
    for (const [value, stamp] of [
      ["githubRepos", "githubReposFetchedAt"],
      ["githubUser", "githubUserFetchedAt"],
      ["githubConnected", "githubCheckedAt"],
    ]) {
      expect(value in snap, `${value} is persisted`).toBe(true);
      expect(stamp in snap, `${value} is persisted, so the time it was fetched must be too`).toBe(true);
    }
  });

  it("keeps activeRepoName persisted — a selection must outlive a restart", () => {
    expect("activeRepoName" in persistedState(useAppStore.getState())).toBe(true);
  });

  it("carries a value and its stamp across a persist round-trip together", () => {
    useAppStore.getState().setGithubRepos([REPO] as never);
    const rehydrated = JSON.parse(JSON.stringify(persistedState(useAppStore.getState())));
    expect(rehydrated.githubRepos).toHaveLength(1);
    expect(rehydrated.githubReposFetchedAt).toBeTypeOf("number");
  });
});

describe("migrateGithubCacheProvenance (persist v2 → v3)", () => {
  it("drops a cached value that has no recorded fetch time", () => {
    // Every existing install is in exactly this state: real values, no provenance. Keeping them would
    // mean presenting 84 repos and a profile as facts about a fetch nobody can date — the same defect
    // in the other direction. They are a cache, so one reconnect restores them.
    const s = migrateGithubCacheProvenance({ githubRepos: [REPO], githubUser: USER } as never, 2) as Record<string, unknown>;
    expect(s.githubRepos).toEqual([]);
    expect(s.githubUser).toBeNull();
    expect(s.githubReposFetchedAt).toBeNull();
    expect(s.githubUserFetchedAt).toBeNull();
  });

  it("does NOT log the user out — the credential verdict is not GitHub data", () => {
    // `githubConnected` is the outcome of the last credential check, not a copy of anything GitHub
    // owns, and the token is still on the machine. Dropping it would sign the user out on upgrade.
    const s = migrateGithubCacheProvenance({ githubConnected: true } as never, 2) as Record<string, unknown>;
    expect(s.githubConnected).toBe(true);
    // …but nothing can claim WHEN it was verified, so it reads as never-checked until something does.
    expect(s.githubCheckedAt).toBeNull();
  });

  it("does NOT touch activeRepoName — it is a user choice, not a cache", () => {
    const s = migrateGithubCacheProvenance({ activeRepoName: "o/r" } as never, 2) as Record<string, unknown>;
    expect(s.activeRepoName).toBe("o/r");
  });

  it("is one-time, keyed on the upgrade — a later fetch is never re-dropped", () => {
    const later = { githubRepos: [REPO], githubReposFetchedAt: 123 };
    expect(migrateGithubCacheProvenance({ ...later } as never, 3)).toEqual(later);
    expect(migrateGithubCacheProvenance({ ...later } as never, 4)).toEqual(later);
  });

  it("tolerates a snapshot that never had the fields", () => {
    expect(migrateGithubCacheProvenance({} as never, 2)).toEqual({
      githubRepos: [], githubUser: null, githubReposFetchedAt: null, githubUserFetchedAt: null, githubCheckedAt: null,
    });
  });
});
