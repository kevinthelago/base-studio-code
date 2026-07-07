import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useGlanceProjects, mergeGlanceProjects, applyLiveness } from "./useGlanceProjects";
import type { GhProject } from "@/features/planner/list/published/publishedModel";
import type { MinimalGhProject } from "@/shared/lib/github/githubState";
import type { ProjectLite } from "./glanceData";
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

describe("useGlanceProjects — declared role/status (#2284)", () => {
  beforeEach(() => useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null }));

  it("passes through a draft's DECLARED role + status (curated coloring wins)", () => {
    useAppStore.setState({
      localDraftProjects: { "billing-svc": { title: "billing-svc", pitch: "", createdAt: 1, role: "service", status: "building" } },
    });
    const { result } = renderHook(() => useGlanceProjects());
    expect(result.current.find((p) => p.id === "billing-svc")).toMatchObject({ role: "service", status: "building" });
  });

  it("derives status when NOT declared (idle, or planning when the project has a fleet) and leaves role undeclared", () => {
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
    expect(plain).toMatchObject({ status: "idle" });
    expect(plain?.role).toBeUndefined(); // derived downstream in buildGlanceData (hash), not here
    expect(fleeted).toMatchObject({ status: "planning" });
  });
});

describe("mergeGlanceProjects — draft/published dedup (#2339/#2409)", () => {
  it("dedupes a legacy-keyed draft + a published project with the SAME title to ONE node", () => {
    // Grandfathering: a draft still keyed by a legacy minted id must collapse with its published
    // board via the slug(title)→draftKey lookup — the node-id alias table is gone (#2409).
    const drafts = { "p-abc123": { title: "Billing Service", pitch: "", createdAt: 1, role: "service" as const } };
    const published = [gh("PVT_node1", "Billing Service", false)];

    const merged = mergeGlanceProjects(drafts, {}, published);

    const billing = merged.filter((p) => p.name === "Billing Service");
    expect(billing).toHaveLength(1);
    expect(billing[0].id).toBe("p-abc123");        // collapsed onto the draft's key
    expect(billing[0].status).toBe("planning");     // published (open) status wins
    expect(billing[0].role).toBe("service");        // draft-declared role survives the collapse
  });

  it("keys a draft-less published project by its name-derived slug (#2409)", () => {
    const published = [gh("PVT_node1", "Billing Service", true)]; // closed ⇒ shipped ⇒ done

    const merged = mergeGlanceProjects({}, {}, published);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("billing-service"); // projectSlug(title) — never the node id
    expect(merged[0].status).toBe("done");
  });

  it("collapses a slug-keyed draft with its published board on the SAME key (#2409)", () => {
    const drafts = { "billing-service": { title: "Billing Service", pitch: "", createdAt: 1 } };
    const published = [gh("PVT_node1", "Billing Service", true)];

    const merged = mergeGlanceProjects(drafts, {}, published);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("billing-service");
    expect(merged[0].status).toBe("done"); // published status wins over the draft's derived idle
  });
});

describe("applyLiveness — heartbeat → 'live' status (#2263)", () => {
  const projects: ProjectLite[] = [
    { id: "a", name: "A", status: "planning" },
    { id: "b", name: "B", status: "done" },
    { id: "c", name: "C", status: "idle" },
  ];

  it("maps a live-keyed project to the 'live' status and leaves the rest untouched", () => {
    const out = applyLiveness(projects, new Set(["a", "b"]));
    expect(out.find((p) => p.id === "a")?.status).toBe("live"); // was planning → live
    expect(out.find((p) => p.id === "b")?.status).toBe("live"); // even a shipped app can be running
    expect(out.find((p) => p.id === "c")?.status).toBe("idle"); // not live → keeps merged status
  });

  it("returns the input untouched when nothing is live (liveness lapsed ⇒ prior status intact)", () => {
    const out = applyLiveness(projects, new Set());
    expect(out).toEqual(projects);
    expect(out.find((p) => p.id === "a")?.status).toBe("planning");
  });
});

describe("useGlanceProjects — status producer wires 'live' from project_liveness (#2263)", () => {
  beforeEach(() => {
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null });
    vi.mocked(invoke).mockReset();
  });

  it("resolves a heartbeating draft to the 'live' status", async () => {
    useAppStore.setState({
      localDraftProjects: { "billing-svc": { title: "billing-svc", pitch: "", createdAt: 1 } },
    });
    // The liveness command reports the draft live; every other command is inert.
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "project_liveness" ? [{ projectKey: "billing-svc", live: true }] : null,
    );

    const { result } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(result.current.find((p) => p.id === "billing-svc")?.status).toBe("live"));
  });

  it("leaves the derived status when the command reports the project NOT live", async () => {
    useAppStore.setState({
      localDraftProjects: { "billing-svc": { title: "billing-svc", pitch: "", createdAt: 1 } },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "project_liveness" ? [{ projectKey: "billing-svc", live: false }] : null,
    );

    const { result } = renderHook(() => useGlanceProjects());
    // Give the poll a tick; the status must stay the derived "idle" (no fleet), never flip to live.
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].status).toBe("idle");
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

  // The read used to `invoke("github_graphql")` with NO `maxAgeSecs`, so every Glance visit
  // re-POSTed the projectsV2 scan. Routed through `githubGraphql`, the payload must carry the
  // default TTL so a revisit within the window is served from the backend cache.
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
    // First visit: a token + a resolving fetch → the published node lands and persists to the store.
    // The project also exists locally as a draft (the persisted fallback only overlays local projects).
    vi.mocked(invoke).mockResolvedValue({ viewer: { projectsV2: { nodes: [gh("PVT_cached", "Cached Project", true)] } } });
    useAppStore.setState({
      githubToken: "tok",
      localDraftProjects: { "cached-project": { title: "Cached Project", pitch: "", createdAt: 1 } },
    });
    const first = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(first.result.current.find((p) => p.id === "cached-project")?.status).toBe("done"));
    first.unmount();

    // Revisit: no token, so useGithubQuery stays { data: null } (no fetch) — but the persisted state
    // seeds the merge, so the project keeps its published status IMMEDIATELY (no drafts-only flash).
    useAppStore.setState({ githubToken: "" });
    const second = renderHook(() => useGlanceProjects());
    expect(second.result.current.find((p) => p.id === "cached-project")?.status).toBe("done");
    second.unmount();
  });

  it("falls back to persisted records BEFORE local-only: the record's status overlays a published hub's node", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "list_local_projects"
        ? [{ key: "acme-crm", title: "Acme CRM", hasPlan: true, updatedAt: 1, published: true }]
        : null,
    );
    // Logged out + a persisted record for the hub: without it the local-only seed would say
    // "planning"; the record (closed ⇒ shipped) must win the overlay.
    useAppStore.setState({ githubState: { records: [rec("Acme CRM", true)], fetchedAt: 1 } });
    const { result } = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(result.current.find((p) => p.id === "acme-crm")?.status).toBe("done"));
  });

  it("does NOT resurrect a record whose project no longer exists locally (deleted hub)", async () => {
    useAppStore.setState({ githubState: { records: [rec("Ghost App")], fetchedAt: 1 } });
    const { result } = renderHook(() => useGlanceProjects());
    // Give the local-inventory fetch a tick — the ghost record must never produce a node.
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
    // The probe-served records render with their real (shipped) status…
    await waitFor(() => expect(result.current.find((p) => p.id === "cached-project")?.status).toBe("done"));
    // …and the skip re-stamps fetchedAt (the "still current as of now" mark).
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
    // The heavy result landed: the fresh (closed ⇒ done) status renders and the records carry T2.
    await waitFor(() => expect(result.current.find((p) => p.id === "cached-project")?.status).toBe("done"));
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
    // The hub key IS the drill / fleetPaneStreams key — never a fabricated one.
    expect(merged[0]).toMatchObject({ id: "acme-crm", name: "Acme CRM", status: "planning" });
  });

  it("a GitHub record OVERLAYS the local node — collapsing onto a LEGACY hub key via slug(title)", () => {
    const merged = mergeGlanceProjects({}, {}, [gh("PVT_1", "Acme CRM", true)], [{ key: "p-legacy1", title: "Acme CRM" }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("p-legacy1"); // stayed on the hub key (what the drill resolves)
    expect(merged[0].status).toBe("done");  // the GitHub shipped status won the overlay
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
    // Only PUBLISHED hubs seed from the inventory — unpublished ones stay draft-map-driven.
    expect(result.current.some((p) => p.id === "just-a-draft")).toBe(false);
  });
});
