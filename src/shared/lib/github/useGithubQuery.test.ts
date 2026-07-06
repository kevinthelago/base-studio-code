import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useGithubQuery } from "./useGithubQuery";
import { useAppStore } from "@/store";

describe("useGithubQuery", () => {
  beforeEach(() => useAppStore.setState({ githubToken: "tok" }));

  it("fetches and exposes data when enabled + token present", async () => {
    const fetcher = vi.fn(async (token: string) => ({ token, n: 1 }));
    const { result } = renderHook(() => useGithubQuery(fetcher, ["x"], true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledWith("tok");
    expect(result.current.data).toEqual({ token: "tok", n: 1 });
    expect(result.current.error).toBeNull();
  });

  it("skips while disabled, and runs once enabled", async () => {
    const fetcher = vi.fn(async () => 42);
    const { rerender, result } = renderHook(
      ({ on }) => useGithubQuery(fetcher, ["x"], on),
      { initialProps: { on: false } },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    rerender({ on: true });
    await waitFor(() => expect(result.current.data).toBe(42));
  });

  it("skips when there is no token", async () => {
    useAppStore.setState({ githubToken: "" });
    const fetcher = vi.fn(async () => 1);
    renderHook(() => useGithubQuery(fetcher, ["x"], true));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces a fetch error as a string", async () => {
    const fetcher = vi.fn(async () => { throw new Error("boom"); });
    const { result } = renderHook(() => useGithubQuery(fetcher, ["x"], true));
    await waitFor(() => expect(result.current.error).toContain("boom"));
    expect(result.current.loading).toBe(false);
  });
});
