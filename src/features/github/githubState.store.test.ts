// #2446 — the persisted `githubState` slice: a fresh fetch overwrites records + fetchedAt, the field
// travels in the persist snapshot (so it survives restart), and each write mirrors the durable copy
// into the bsc-project store over the `bsc` bridge (`bsc project github-state set`, JSON on stdin).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import type { AppStore } from "@/store/types";
import type { MinimalGhProject } from "@/shared/lib/github/githubState";

const rec = (title: string): MinimalGhProject => ({
  id: `PVT_${title}`, number: 1, title, shortDescription: null, url: "", closed: false,
  updatedAt: "", itemsTotalCount: 0, openCount: 0, closedCount: 0, repos: [],
});

describe("githubState slice (#2446)", () => {
  beforeEach(() => {
    useAppStore.setState({ githubState: null });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue("");
  });

  it("defaults to null (no fetch has ever landed)", () => {
    expect(useAppStore.getState().githubState).toBeNull();
  });

  it("setGithubState overwrites the records wholesale and stamps fetchedAt", () => {
    const before = Date.now();
    useAppStore.getState().setGithubState([rec("Acme CRM")]);
    const first = useAppStore.getState().githubState!;
    expect(first.records.map((r) => r.title)).toEqual(["Acme CRM"]);
    expect(first.fetchedAt).toBeGreaterThanOrEqual(before);

    // A later fetch REPLACES (never merges) — a board deleted on GitHub drops out.
    useAppStore.getState().setGithubState([rec("Other")]);
    expect(useAppStore.getState().githubState!.records.map((r) => r.title)).toEqual(["Other"]);
  });

  it("mirrors each write into the bsc-project store (bsc project github-state set, JSON on stdin)", () => {
    useAppStore.getState().setGithubState([rec("Acme CRM")]);
    expect(invoke).toHaveBeenCalledWith("bsc", {
      projectKey: null,
      args: ["project", "github-state", "set"],
      stdin: JSON.stringify(useAppStore.getState().githubState),
    });
  });

  it("persists: the partialize snapshot carries githubState, and applying it back rehydrates", () => {
    useAppStore.getState().setGithubState([rec("Acme CRM")]);
    const partialize = useAppStore.persist.getOptions().partialize!;
    const snap = partialize(useAppStore.getState()) as Partial<AppStore>;
    expect(snap.githubState).toEqual(useAppStore.getState().githubState);

    // Simulate the restart: a fresh store + the persisted snapshot applied → the state is back.
    useAppStore.setState({ githubState: null });
    useAppStore.setState(snap);
    expect(useAppStore.getState().githubState!.records[0].title).toBe("Acme CRM");
  });

  it("disconnectGithub does NOT clear it — surviving the logged-out state is its point", () => {
    useAppStore.getState().setGithubState([rec("Acme CRM")]);
    useAppStore.getState().disconnectGithub();
    expect(useAppStore.getState().githubState?.records).toHaveLength(1);
  });
});
