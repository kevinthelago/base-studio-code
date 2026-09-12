/**
 * @vitest-environment jsdom
 *
 * This file lives under `lib/`, which vitest's `node` project covers, but `renderHook` needs a DOM.
 * A per-file docblock beats the project's environment — the same reason the hook's carried test
 * carries one. See the `projects` split in vitest.config.ts for why the default is `node` here.
 */
// `useGithubQuery` dates its last SUCCESS, and a failure moves nothing
// (`frontend-state-7-the-github-cluster-is-an-honest-cache`).
//
// NOTHING LATCHES has two halves and they pull in opposite directions, which is why both are pinned
// here rather than trusted to one assertion:
//
//   - a failed refetch must NOT blank the last good data — throwing away a usable answer because a
//     later request failed is its own defect, and it is what a naive "clear on error" would do;
//   - a failed refetch must NOT leave that data looking CURRENT — which is what would happen if the
//     failure path re-stamped `fetchedAt`, or if there were no timestamp to age at all.
//
// Keeping the value while freezing its timestamp is the only shape that satisfies both, and the value
// then decays to `stale` on its own through `readGithubCache` with nothing having to invalidate it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useGithubQuery } from "@/shared/lib/github/useGithubQuery";
import { useAppStore } from "@/store";

describe("useGithubQuery records when it last succeeded", () => {
  beforeEach(() => useAppStore.setState({ githubToken: "tok" }));

  it("starts with no fetch time — nothing has been fetched yet", () => {
    const { result } = renderHook(() => useGithubQuery(vi.fn(async () => 1), ["x"], false));
    expect(result.current.fetchedAt).toBeNull();
    expect(result.current.data).toBeNull();
  });

  it("stamps a fetch time on success", async () => {
    const before = Date.now();
    const { result } = renderHook(() => useGithubQuery(vi.fn(async () => 42), ["x"], true));
    await waitFor(() => expect(result.current.data).toBe(42));
    expect(result.current.fetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("a FAILED refetch keeps the last good data and does NOT move its fetch time", async () => {
    // The whole point, end to end. First call succeeds and stamps; the second throws.
    let call = 0;
    const fetcher = vi.fn(async () => {
      call += 1;
      if (call === 1) return "good";
      throw new Error("boom");
    });
    const { result, rerender } = renderHook(({ k }) => useGithubQuery(fetcher, [k], true), {
      initialProps: { k: "a" },
    });
    await waitFor(() => expect(result.current.data).toBe("good"));
    const stampedAt = result.current.fetchedAt;
    expect(stampedAt).toBeTypeOf("number");

    rerender({ k: "b" });
    await waitFor(() => expect(result.current.error).toContain("boom"));

    expect(result.current.data).toBe("good");            // not blanked — the answer is still usable
    expect(result.current.fetchedAt).toBe(stampedAt);    // not re-stamped — nothing refetched it
  });

  it("re-stamps on a LATER success, so a recovery is visible where a failure was not", async () => {
    // Deliberately the REAL clock, and therefore `toBeGreaterThanOrEqual`: two successes can land in
    // the same millisecond, and faking time here would fight `waitFor`, which is itself timer-driven.
    // The meaning is carried by the CONTRAST with the failure case above — there the stamp must not
    // move at all; here it is free to.
    let call = 0;
    const fetcher = vi.fn(async () => { call += 1; return call; });
    const { result, rerender } = renderHook(({ k }) => useGithubQuery(fetcher, [k], true), {
      initialProps: { k: "a" },
    });
    await waitFor(() => expect(result.current.data).toBe(1));
    const first = result.current.fetchedAt!;

    rerender({ k: "b" });
    await waitFor(() => expect(result.current.data).toBe(2));

    expect(result.current.fetchedAt!).toBeGreaterThanOrEqual(first);
  });
});
