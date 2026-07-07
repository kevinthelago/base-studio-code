import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { DEFAULT_MAX_AGE_SECS } from "./github";
import {
  probeMatchesRecords, fetchProjectsWithProbe, boardFetchOpts, fetchBoardWithProbe,
  resetBoardProbeBaselines, BOARD_PROBE_QUERY, BOARD_UNCHANGED_MAX_AGE_SECS, type ProbeNode,
} from "./githubProbe";
import type { GhProjectShape, MinimalGhProject } from "./githubState";

/** A persisted minimal record with a version cursor. */
const rec = (id: string, updatedAt: string): MinimalGhProject => ({
  id, number: 1, title: id, shortDescription: null, url: "", closed: false, updatedAt,
  itemsTotalCount: 3, openCount: 2, closedCount: 1, repos: ["o/r"],
});

const node = (id: string, updatedAt: string): ProbeNode => ({ id, updatedAt });

describe("probeMatchesRecords", () => {
  it("matches when ids + updatedAt line up exactly (order-independent)", () => {
    expect(probeMatchesRecords(
      [node("a", "T1"), node("b", "T2")],
      [rec("b", "T2"), rec("a", "T1")],
    )).toBe(true);
  });

  it("a moved board (updatedAt changed) is a mismatch", () => {
    expect(probeMatchesRecords([node("a", "T9")], [rec("a", "T1")])).toBe(false);
  });

  it("an added or removed board is a mismatch", () => {
    expect(probeMatchesRecords([node("a", "T1"), node("b", "T2")], [rec("a", "T1")])).toBe(false);
    expect(probeMatchesRecords([node("a", "T1")], [rec("a", "T1"), rec("b", "T2")])).toBe(false);
  });

  it("both empty is a match (nothing to fetch)", () => {
    expect(probeMatchesRecords([], [])).toBe(true);
  });
});

describe("fetchProjectsWithProbe", () => {
  it("probe unchanged ⇒ the heavy fetch is SKIPPED and the records are re-served expanded", async () => {
    const fetchHeavy = vi.fn(async () => []);
    const out = await fetchProjectsWithProbe({
      fetchHeavy,
      records: [rec("a", "T1")],
      fetchProbe: async () => [node("a", "T1")],
    });
    expect(fetchHeavy).not.toHaveBeenCalled();
    // Expanded via minimalToGhProject: the progress-bearing shape the consumers render.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", updatedAt: "T1", items: { totalCount: 3 } });
    expect(out[0].items.nodes).toHaveLength(3); // 2 open + 1 closed stubs
  });

  it("probe moved ⇒ the heavy fetch fires and its result is returned", async () => {
    const heavy: GhProjectShape[] = [{
      id: "a", number: 1, title: "a", shortDescription: null, url: "", closed: false,
      updatedAt: "T2", items: { totalCount: 0, nodes: [] }, repositories: { nodes: [] },
    }];
    const fetchHeavy = vi.fn(async () => heavy);
    const out = await fetchProjectsWithProbe({
      fetchHeavy,
      records: [rec("a", "T1")],
      fetchProbe: async () => [node("a", "T2")],
    });
    expect(fetchHeavy).toHaveBeenCalledOnce();
    expect(out).toBe(heavy);
  });

  it("no baseline records ⇒ heavy fetch, probe never runs", async () => {
    const fetchHeavy = vi.fn(async () => []);
    const fetchProbe = vi.fn(async () => []);
    await fetchProjectsWithProbe({ fetchHeavy, records: null, fetchProbe });
    await fetchProjectsWithProbe({ fetchHeavy, records: [], fetchProbe });
    expect(fetchProbe).not.toHaveBeenCalled();
    expect(fetchHeavy).toHaveBeenCalledTimes(2);
  });

  it("force (manual ↻ sync) skips the probe and goes heavy", async () => {
    const fetchHeavy = vi.fn(async () => []);
    const fetchProbe = vi.fn(async () => [node("a", "T1")]);
    await fetchProjectsWithProbe({ fetchHeavy, records: [rec("a", "T1")], force: true, fetchProbe });
    expect(fetchProbe).not.toHaveBeenCalled();
    expect(fetchHeavy).toHaveBeenCalledOnce();
  });

  it("a probe failure falls through to the heavy fetch (pre-probe behavior)", async () => {
    const fetchHeavy = vi.fn(async () => []);
    await fetchProjectsWithProbe({
      fetchHeavy,
      records: [rec("a", "T1")],
      fetchProbe: async () => { throw new Error("offline"); },
    });
    expect(fetchHeavy).toHaveBeenCalledOnce();
  });
});

describe("boardFetchOpts", () => {
  it("no probe signal or no baseline ⇒ default TTL behavior ({})", () => {
    expect(boardFetchOpts(null, "T1")).toEqual({});
    expect(boardFetchOpts("T1", undefined)).toEqual({});
  });

  it("unchanged ⇒ a long maxAgeSecs so the backend serves its cached copy past the window", () => {
    expect(boardFetchOpts("T1", "T1")).toEqual({ maxAgeSecs: BOARD_UNCHANGED_MAX_AGE_SECS });
  });

  it("moved ⇒ force a fresh POST", () => {
    expect(boardFetchOpts("T2", "T1")).toEqual({ force: true });
  });
});

describe("fetchBoardWithProbe", () => {
  const heavyQuery = "query($id:ID!){ node(id:$id){ big } }";

  /** All github_graphql calls for `heavyQuery`, so assertions ignore the probe calls. */
  const heavyCalls = () =>
    vi.mocked(invoke).mock.calls.filter(([cmd, args]) =>
      cmd === "github_graphql" && (args as { query: string }).query === heavyQuery);

  beforeEach(() => {
    resetBoardProbeBaselines();
    vi.mocked(invoke).mockReset();
    useAppStore.setState({ githubToken: "tok" });
  });

  it("first fetch (no baseline) uses the default TTL, then an unchanged probe serves the cached copy, then a moved probe forces fresh", async () => {
    let updatedAt = "T1";
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const a = args as { query: string };
      if (cmd !== "github_graphql") return null;
      if (a.query === BOARD_PROBE_QUERY) return { node: { updatedAt } };
      return { node: { big: true } };
    });

    // 1 — no baseline: default TTL (today's behavior); the baseline records T1.
    await fetchBoardWithProbe(heavyQuery, "PVT_1");
    expect(heavyCalls()[0][1]).toMatchObject({ maxAgeSecs: DEFAULT_MAX_AGE_SECS, force: undefined });

    // 2 — unchanged: the heavy query rides the LONG window (backend serves its cached copy).
    await fetchBoardWithProbe(heavyQuery, "PVT_1");
    expect(heavyCalls()[1][1]).toMatchObject({ maxAgeSecs: BOARD_UNCHANGED_MAX_AGE_SECS });

    // 3 — the board moved: force a fresh POST.
    updatedAt = "T2";
    await fetchBoardWithProbe(heavyQuery, "PVT_1");
    expect(heavyCalls()[2][1]).toMatchObject({ force: true });

    // 4 — and the new cursor is the baseline: unchanged again ⇒ cached copy again.
    await fetchBoardWithProbe(heavyQuery, "PVT_1");
    expect(heavyCalls()[3][1]).toMatchObject({ maxAgeSecs: BOARD_UNCHANGED_MAX_AGE_SECS });
  });

  it("a failed probe degrades to the default TTL fetch and records no baseline", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const a = args as { query: string };
      if (cmd !== "github_graphql") return null;
      if (a.query === BOARD_PROBE_QUERY) throw new Error("offline");
      return { node: { big: true } };
    });
    const out = await fetchBoardWithProbe<{ node: { big: boolean } }>(heavyQuery, "PVT_1");
    expect(out).toEqual({ node: { big: true } });
    expect(heavyCalls()[0][1]).toMatchObject({ maxAgeSecs: DEFAULT_MAX_AGE_SECS, force: undefined });
  });

  it("baselines are PER BOARD — board B's first fetch is unaffected by board A's baseline", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const a = args as { query: string };
      if (cmd !== "github_graphql") return null;
      if (a.query === BOARD_PROBE_QUERY) return { node: { updatedAt: "T1" } };
      return { node: {} };
    });
    await fetchBoardWithProbe(heavyQuery, "PVT_A");
    await fetchBoardWithProbe(heavyQuery, "PVT_B");
    expect(heavyCalls()[1][1]).toMatchObject({ maxAgeSecs: DEFAULT_MAX_AGE_SECS }); // B has no baseline yet
  });
});
