import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useGlanceProjects, mergeGlanceProjects, applyLiveness, applyFaultHealth } from "./useGlanceProjects";
import type { GhProject } from "@/features/planner/list/published/publishedModel";
import type { MinimalGhProject } from "@/shared/lib/github/githubState";
import type { ProjectLite } from "./glanceData";
import type { GlanceFault } from "./useGlanceFaults";
import { useAppStore } from "@/store";

/** A GhProject with the fields the merge reads; the rest filled so the cast is honest. */
const gh = (id: string, title: string, closed = false): GhProject => ({
  id, number: 1, title, shortDescription: null, url: "", closed, updatedAt: "",
  items: { totalCount: 0, nodes: [] }, repositories: { nodes: [] },
});

/** A persisted minimal record (#2446) with the fields the fallback reads. */
const rec = (title: string, closed = false): MinimalGhProject => ({
  id: `PVT_${title}`, number: 1, title, shortDescription: null, url: "", closed, updatedAt: "",
  itemsTotalCount: 0, openCount: 0, closedCount: 0, repos: [],
});

describe("useGlanceProjects — declared role/health/activity (#2284/#2541)", () => {
  beforeEach(() => useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null }));

  it("passes through a draft's DECLARED role + health + activity (curated colouring wins)", () => {
    useAppStore.setState({
      localDraftProjects: { "billing-svc": { title: "billing-svc", pitch: "", createdAt: 1, role: "service", health: "warning", activity: "waiting" } },
    });
    const { result } = renderHook(() => useGlanceProjects());
    expect(result.current.find((p) => p.id === "billing-svc")).toMatchObject({ role: "service", health: "warning", activity: "waiting" });
  });

  it("derives activity when NOT declared (planning with no fleet, building once a fleet exists); health rests at idle", () => {
    useAppStore.setState({
      localDraftProjects: {
        plain: { title: "Plain", pitch: "", createdAt: 1 },
        fleeted: { title: "Fleeted", pitch: "", createdAt: 2 },
      },
      planFleet: {
        fleeted: {
          recommended: 1, reasoning: "",
          streams: [{ id: "s", name: "S", repo: "o/r", owns: [], issues: [], dependsOn: [] }],
          director: { enabled: false },
        } as never,
      },
    });
    const { result } = renderHook(() => useGlanceProjects());
    const plain = result.current.find((p) => p.id === "plain");
    const fleeted = result.current.find((p) => p.id === "fleeted");
    expect(plain).toMatchObject({ health: "idle", activity: "planning" });
    expect(plain?.role).toBeUndefined(); // derived downstream in buildGlanceData (hash), not here
    expect(fleeted).toMatchObject({ health: "idle", activity: "building" });
  });
});

describe("mergeGlanceProjects — draft/published dedup (#2339/#2409); GitHub no longer sets status (#2541)", () => {
  it("dedupes a legacy-keyed draft + a published project with the SAME title to ONE node", () => {
    // Grandfathering: a draft still keyed by a legacy minted id must collapse with its published
    // board via the slug(title)→draftKey lookup — the node-id alias table is gone (#2409).
    const drafts = { "p-abc123": { title: "Billing Service", pitch: "", createdAt: 1, role: "service" as const } };
    const published = [gh("PVT_node1", "Billing Service", false)];

    const merged = mergeGlanceProjects(drafts, {}, published);

    const billing = merged.filter((p) => p.name === "Billing Service");
    expect(billing).toHaveLength(1);
    expect(billing[0].id).toBe("p-abc123");   // collapsed onto the draft's key
    expect(billing[0].role).toBe("service");  // draft-declared role survives the collapse
    // GitHub board status is NOT read (#2541) — the node keeps its derived activity, never "done".
    expect(billing[0].activity).toBe("planning"); // draft has no fleet → planning default
  });

  it("keys a draft-less published project by its name-derived slug, with derived axes (#2409/#2541)", () => {
    const published = [gh("PVT_node1", "Billing Service", true)]; // closed board — but status is NOT read

    const merged = mergeGlanceProjects({}, {}, published);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("billing-service"); // projectSlug(title) — never the node id
    expect(merged[0].health).toBe("idle");
    expect(merged[0].activity).toBe("building");  // a published hub is a working project
  });

  it("collapses a slug-keyed draft with its published board on the SAME key (#2409)", () => {
    const drafts = { "billing-service": { title: "Billing Service", pitch: "", createdAt: 1 } };
    const published = [gh("PVT_node1", "Billing Service", true)];

    const merged = mergeGlanceProjects(drafts, {}, published);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("billing-service");
  });
});

describe("applyLiveness — heartbeat → 'live' activity + healthy (#2263/#2541)", () => {
  const projects: ProjectLite[] = [
    { id: "a", name: "A", health: "idle", activity: "planning" },
    { id: "b", name: "B", health: "idle", activity: "building" },
    { id: "c", name: "C", health: "idle", activity: "building" },
  ];

  it("maps a live-keyed project to activity 'live' + health 'healthy' and leaves the rest untouched", () => {
    const out = applyLiveness(projects, new Set(["a", "b"]));
    expect(out.find((p) => p.id === "a")).toMatchObject({ activity: "live", health: "healthy" });
    expect(out.find((p) => p.id === "b")).toMatchObject({ activity: "live", health: "healthy" });
    expect(out.find((p) => p.id === "c")).toMatchObject({ activity: "building", health: "idle" }); // not live → untouched
  });

  it("returns the input untouched when nothing is live (liveness lapsed ⇒ prior axes intact)", () => {
    const out = applyLiveness(projects, new Set());
    expect(out).toEqual(projects);
  });
});

describe("applyFaultHealth — worst fault → warning/error + reason (#2541)", () => {
  const projects: ProjectLite[] = [
    { id: "a", name: "A", health: "healthy", activity: "live" },
    { id: "b", name: "B", health: "idle", activity: "building" },
  ];
  const fault = (level: GlanceFault["level"], title: string, count = 1): GlanceFault => ({ level, title, count });

  it("escalates a warn to 'warning' and an error/fatal to 'error', carrying the title as the reason", () => {
    const out = applyFaultHealth(projects, { a: fault("error", "boom", 3), b: fault("warn", "no instructions", 1) });
    expect(out.find((p) => p.id === "a")).toMatchObject({ health: "error", reason: "boom", faults: 3 });
    expect(out.find((p) => p.id === "b")).toMatchObject({ health: "warning", reason: "no instructions", faults: 1 });
  });

  it("a fatal fault reads as error, and a project with no fault is untouched", () => {
    const out = applyFaultHealth(projects, { a: fault("fatal", "panic") });
    expect(out.find((p) => p.id === "a")?.health).toBe("error");
    expect(out.find((p) => p.id === "b")).toEqual(projects[1]); // no fault → left as-is (stays healthy/live path)
  });
});

describe("useGlanceProjects — wires 'live' from project_liveness (#2263)", () => {
  beforeEach(() => {
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null });
    vi.mocked(invoke).mockReset();
  });

  it("resolves a heartbeating draft to activity 'live'", async () => {
    useAppStore.setState({
      localDraftProjects: { "billing-svc": { title: "billing-svc", pitch: "", createdAt: 1 } },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "project_liveness" ? [{ projectKey: "billing-svc", live: true }] : null,
    );

    const { result } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(result.current.find((p) => p.id === "billing-svc")?.activity).toBe("live"));
  });

  it("leaves the derived activity when the command reports the project NOT live", async () => {
    useAppStore.setState({
      localDraftProjects: { "billing-svc": { title: "billing-svc", pitch: "", createdAt: 1 } },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "project_liveness" ? [{ projectKey: "billing-svc", live: false }] : null,
    );

    const { result } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].activity).toBe("planning"); // no fleet → planning, never flips to live
  });
});

describe("useGlanceProjects — published read hits the TTL cache (#2447)", () => {
  beforeEach(() => {
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "gho_test", githubState: null });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "github_graphql" ? { viewer: { projectsV2: { nodes: [] } } } : null,
    );
  });

  it("sends the projects query with the default maxAgeSecs", async () => {
    renderHook(() => useGlanceProjects());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "github_graphql",
      expect.objectContaining({ token: "gho_test", maxAgeSecs: 300 }),
    ));
  });
});

describe("useGlanceProjects — persisted github-state (#2446, supersedes the #2339 module cache)", () => {
  beforeEach(() => {
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null });
    vi.mocked(invoke).mockReset();
  });

  it("a landed fetch OVERWRITES the persisted records (+fetchedAt) in the store", async () => {
    vi.mocked(invoke).mockResolvedValue({ viewer: { projectsV2: { nodes: [gh("PVT_cached", "Cached Project")] } } });
    useAppStore.setState({ githubToken: "tok" });
    const { unmount } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(useAppStore.getState().githubState?.records.map((r) => r.title)).toEqual(["Cached Project"]));
    expect(useAppStore.getState().githubState!.fetchedAt).toBeGreaterThan(0);
    unmount();
  });

  it("a revisit (fetch not yet landed) still includes the last-known published set for a LOCAL project", async () => {
    vi.mocked(invoke).mockResolvedValue({ viewer: { projectsV2: { nodes: [gh("PVT_cached", "Cached Project", true)] } } });
    useAppStore.setState({
      githubToken: "tok",
      localDraftProjects: { "cached-project": { title: "Cached Project", pitch: "", createdAt: 1 } },
    });
    const first = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(first.result.current.some((p) => p.id === "cached-project")).toBe(true));
    first.unmount();

    // Revisit: no token, so useGithubQuery stays { data: null } (no fetch) — but the persisted state
    // seeds the merge, so the project still renders IMMEDIATELY (no drafts-only flash).
    useAppStore.setState({ githubToken: "" });
    const second = renderHook(() => useGlanceProjects());
    expect(second.result.current.some((p) => p.id === "cached-project")).toBe(true);
    second.unmount();
  });

  it("falls back to persisted records BEFORE local-only: the record overlays a published hub's node", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "list_local_projects"
        ? [{ key: "acme-crm", title: "Acme CRM", hasPlan: true, updatedAt: 1, published: true }]
        : null,
    );
    useAppStore.setState({ githubState: { records: [rec("Acme CRM", true)], fetchedAt: 1 } });
    const { result } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(result.current.some((p) => p.id === "acme-crm")).toBe(true));
  });

  it("does NOT resurrect a record whose project no longer exists locally (deleted hub)", async () => {
    useAppStore.setState({ githubState: { records: [rec("Ghost App")], fetchedAt: 1 } });
    const { result } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    expect(result.current.some((p) => p.name === "Ghost App")).toBe(false);
  });
});

describe("useGlanceProjects — updatedAt probe gates the heavy fetch (#2448)", () => {
  const HEAVY_MARKER = "items(first: 100)"; // only PROJECTS_QUERY carries the heavy items scan

  beforeEach(() => {
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "tok", githubState: null });
    vi.mocked(invoke).mockReset();
  });

  it("probe unchanged ⇒ no heavy POST; the records render and fetchedAt refreshes", async () => {
    useAppStore.setState({
      localDraftProjects: { "cached-project": { title: "Cached Project", pitch: "", createdAt: 1 } },
      githubState: { records: [{ ...rec("Cached Project", true), updatedAt: "T1" }], fetchedAt: 5 },
    });
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd !== "github_graphql") return null;
      const q = String((args as { query: string }).query);
      if (q.includes(HEAVY_MARKER)) throw new Error("heavy query must not fire when nothing moved");
      return { viewer: { projectsV2: { nodes: [{ id: "PVT_Cached Project", updatedAt: "T1" }] } } };
    });

    const { result } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(result.current.some((p) => p.id === "cached-project")).toBe(true));
    await waitFor(() => expect(useAppStore.getState().githubState!.fetchedAt).toBeGreaterThan(5));
  });

  it("probe moved ⇒ the heavy fetch fires and overwrites the records", async () => {
    useAppStore.setState({
      localDraftProjects: { "cached-project": { title: "Cached Project", pitch: "", createdAt: 1 } },
      githubState: { records: [{ ...rec("Cached Project"), updatedAt: "T1" }], fetchedAt: 5 },
    });
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd !== "github_graphql") return null;
      const q = String((args as { query: string }).query);
      if (q.includes(HEAVY_MARKER)) {
        return { viewer: { projectsV2: { nodes: [{ ...gh("PVT_Cached Project", "Cached Project", true), updatedAt: "T2" }] } } };
      }
      return { viewer: { projectsV2: { nodes: [{ id: "PVT_Cached Project", updatedAt: "T2" }] } } };
    });

    const { result } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(result.current.some((p) => p.id === "cached-project")).toBe(true));
    await waitFor(() => expect(useAppStore.getState().githubState!.records[0].updatedAt).toBe("T2"));
  });
});

describe("local published inventory seeds Glance (#2445)", () => {
  beforeEach(() => {
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null });
    vi.mocked(invoke).mockReset();
  });

  it("merge seeds a node for a local published hub — keyed by the HUB folder key — when GitHub is absent", () => {
    const merged = mergeGlanceProjects({}, {}, [], [{ key: "acme-crm", title: "Acme CRM" }]);
    expect(merged).toHaveLength(1);
    // The hub key IS the drill / fleetPaneStreams key — never a fabricated one. Working project → building.
    expect(merged[0]).toMatchObject({ id: "acme-crm", name: "Acme CRM", activity: "building", health: "idle" });
  });

  it("a GitHub record OVERLAYS the local node — collapsing onto a LEGACY hub key via slug(title)", () => {
    const merged = mergeGlanceProjects({}, {}, [gh("PVT_1", "Acme CRM", true)], [{ key: "p-legacy1", title: "Acme CRM" }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("p-legacy1"); // stayed on the hub key (what the drill resolves)
  });

  it("hook: LOGGED OUT, a local published hub still produces its Glance node", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "list_local_projects"
        ? [{ key: "restored-app", title: "Restored App", hasPlan: true, updatedAt: 1, published: true },
           { key: "just-a-draft", title: "Just A Draft", hasPlan: true, updatedAt: 1, published: false }]
        : null,
    );
    const { result } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(result.current.some((p) => p.id === "restored-app")).toBe(true));
    expect(result.current.some((p) => p.id === "just-a-draft")).toBe(false);
  });
});
