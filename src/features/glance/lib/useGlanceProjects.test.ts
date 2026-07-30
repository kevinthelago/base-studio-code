import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useGlanceProjects, mergeGlanceProjects, mergeDbIntoDrafts, applyLiveness, applyDormantHealth, applyFaultHealth, applyOffHealth, applyRunningActivity, deriveBuildingKeys, filterTriaged, resolveProjectCategory } from "./useGlanceProjects";
import type { DbProject } from "@/features/planner";
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
      triagedProjects: { "billing-svc": 1 },
    });
    const { result } = renderHook(() => useGlanceProjects());
    expect(result.current.find((p) => p.id === "billing-svc")).toMatchObject({ role: "service", health: "warning", activity: "waiting" });
  });

  // #2551 established that `building` comes from RUNNING AGENTS, never from merely having a planned
  // fleet. #3429 then split the undeclared resting state in two: nothing running at all reads `off`,
  // a session that exists but is quiet reads `idle`. Neither project here has a session, so both read
  // `off · idle` — the assertion below was left at the pre-#3429 `idle · idle` and went red on develop.
  it("rests at off · idle when NOT declared — building comes from running agents, not a fallback (#2551/#3429)", () => {
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
      triagedProjects: { plain: 1, fleeted: 1 },
    });
    const { result } = renderHook(() => useGlanceProjects());
    const plain = result.current.find((p) => p.id === "plain");
    const fleeted = result.current.find((p) => p.id === "fleeted");
    expect(plain).toMatchObject({ health: "off", activity: "idle" });
    expect(plain?.role).toBeUndefined(); // derived downstream in buildGlanceData (hash), not here
    // A PLANNED (not launched) fleet is still idle — planning one does not make a project active.
    expect(fleeted).toMatchObject({ health: "off", activity: "idle" });
  });
});

describe("filterTriaged — only triaged/working projects render (#2541)", () => {
  const projects: ProjectLite[] = [
    { id: "worked", name: "Worked", health: "off", activity: "building" },
    { id: "just-a-draft", name: "Draft", health: "off", activity: "planning" },
  ];

  it("keeps a project whose key is marked triaged and drops one that is not", () => {
    const out = filterTriaged(projects, { worked: 1720000000000 });
    expect(out.map((p) => p.id)).toEqual(["worked"]);
  });

  it("empty triaged set ⇒ empty graph (a plan/draft never shows until worked)", () => {
    expect(filterTriaged(projects, {})).toEqual([]);
  });
});

describe("useGlanceProjects — hides a non-triaged draft (#2541)", () => {
  beforeEach(() => useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null, triagedProjects: {} }));

  it("a drafted-but-never-triaged project does NOT appear on the network", () => {
    useAppStore.setState({ localDraftProjects: { "fresh-draft": { title: "Fresh Draft", pitch: "", createdAt: 1 } } });
    const { result } = renderHook(() => useGlanceProjects());
    expect(result.current.some((p) => p.id === "fresh-draft")).toBe(false);
  });

  it("the SAME project appears once it is marked triaged", () => {
    useAppStore.setState({
      localDraftProjects: { "fresh-draft": { title: "Fresh Draft", pitch: "", createdAt: 1 } },
      triagedProjects: { "fresh-draft": 1 },
    });
    const { result } = renderHook(() => useGlanceProjects());
    expect(result.current.some((p) => p.id === "fresh-draft")).toBe(true);
  });
});

describe("mergeGlanceProjects — draft/published dedup (#2339/#2409); GitHub no longer sets status (#2541)", () => {
  it("dedupes a legacy-keyed draft + a published project with the SAME title to ONE node", () => {
    // Grandfathering: a draft still keyed by a legacy minted id must collapse with its published
    // board via the slug(title)→draftKey lookup — the node-id alias table is gone (#2409).
    const drafts = { "p-abc123": { title: "Billing Service", pitch: "", createdAt: 1, role: "service" as const } };
    const published = [gh("PVT_node1", "Billing Service", false)];

    const merged = mergeGlanceProjects(drafts, published);

    const billing = merged.filter((p) => p.name === "Billing Service");
    expect(billing).toHaveLength(1);
    expect(billing[0].id).toBe("p-abc123");   // collapsed onto the draft's key
    expect(billing[0].role).toBe("service");  // draft-declared role survives the collapse
    // GitHub board status is NOT read (#2541) — the node keeps its derived activity, never "done".
    expect(billing[0].activity).toBe("idle"); // rests at idle (#2551) — building is derived, not defaulted
  });

  it("keys a draft-less published project by its name-derived slug, with derived axes (#2409/#2541)", () => {
    const published = [gh("PVT_node1", "Billing Service", true)]; // closed board — but status is NOT read

    const merged = mergeGlanceProjects({}, published);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("billing-service"); // projectSlug(title) — never the node id
    expect(merged[0].health).toBe("off");
    expect(merged[0].activity).toBe("idle");  // rests at idle (#2551) until a runtime signal lights it up
  });

  it("collapses a slug-keyed draft with its published board on the SAME key (#2409)", () => {
    const drafts = { "billing-service": { title: "Billing Service", pitch: "", createdAt: 1 } };
    const published = [gh("PVT_node1", "Billing Service", true)];

    const merged = mergeGlanceProjects(drafts, published);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("billing-service");
  });

  it("collapses a legacy + name-slug local hub folder of the SAME project to ONE node, keyed canonically", () => {
    // #2409 grandfathering leaves BOTH hub folders on disk with the same title; the local-inventory seed
    // must not render the project twice. The canonical name-slug folder wins the node id.
    const localPublished = [
      { key: "Beautiful_Emails", title: "Beautiful Emails" },
      { key: "beautiful-emails", title: "Beautiful Emails" },
    ];
    const merged = mergeGlanceProjects({}, [], localPublished);
    const emails = merged.filter((p) => p.name === "Beautiful Emails");
    expect(emails).toHaveLength(1);
    expect(emails[0].id).toBe("beautiful-emails"); // the canonical projectSlug folder, not the legacy one
  });

  it("keeps a legacy-only local hub (no name-slug folder) under its own key", () => {
    const merged = mergeGlanceProjects({}, [], [{ key: "Beautiful_Emails", title: "Beautiful Emails" }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("Beautiful_Emails"); // no canonical folder exists → keep the legacy key
  });

  it("carries a draft's declared lifecycle category onto the node (#2583)", () => {
    const merged = mergeGlanceProjects({ x: { title: "X", pitch: "", createdAt: 1, category: "harden" } }, []);
    expect(merged[0].category).toBe("harden");
  });
});

describe("resolveProjectCategory — lifecycle category, replacing the hash tier (#2583)", () => {
  it("prefers a declared category, then the blueprint category, then the status heuristic", () => {
    expect(resolveProjectCategory("harden", "greenfield", false)).toBe("harden");   // declared wins
    expect(resolveProjectCategory(undefined, "transform", true)).toBe("transform");  // blueprint next
    expect(resolveProjectCategory(undefined, undefined, true)).toBe("greenfield");   // a draft is being created
    expect(resolveProjectCategory(undefined, undefined, false)).toBe("maintain");    // a published/worked project is in upkeep
  });
});

describe("applyLiveness — heartbeat → 'live' activity + healthy (#2263/#2541)", () => {
  const projects: ProjectLite[] = [
    { id: "a", name: "A", health: "off", activity: "planning" },
    { id: "b", name: "B", health: "off", activity: "building" },
    { id: "c", name: "C", health: "off", activity: "building" },
  ];

  it("maps a live-keyed project to activity 'live' + health 'healthy' and leaves the rest untouched", () => {
    const out = applyLiveness(projects, new Set(["a", "b"]));
    expect(out.find((p) => p.id === "a")).toMatchObject({ activity: "live", health: "healthy" });
    expect(out.find((p) => p.id === "b")).toMatchObject({ activity: "live", health: "healthy" });
    expect(out.find((p) => p.id === "c")).toMatchObject({ activity: "building", health: "off" }); // not live → untouched
  });

  it("returns the input untouched when nothing is live (liveness lapsed ⇒ prior axes intact)", () => {
    const out = applyLiveness(projects, new Set());
    expect(out).toEqual(projects);
  });
});

describe("deriveBuildingKeys / applyRunningActivity — running agents → building (#2551)", () => {
  const projects: ProjectLite[] = [
    { id: "alpha", name: "Alpha", health: "off", activity: "idle" },
    { id: "beta", name: "Beta", health: "off", activity: "idle" },
  ];

  it("deriveBuildingKeys reads the LIVE panes + run/on pane statuses, keyed by the project prefix", () => {
    const keys = deriveBuildingKeys(
      new Set(["alpha:auth"]),                               // a live worker cell → alpha
      { "beta:director": "run", "gamma:web": "idle" },       // director running → beta; idle → ignored
    );
    expect([...keys].sort()).toEqual(["alpha", "beta"]);
  });

  // #3429 — the roster map (`fleetPaneStreams`) this used to read is only cleared by `closeTab`, so an
  // ended fleet kept its project reading `building`/`healthy` until the tab itself was closed. Reading the
  // pruned live set instead means "End sessions" is enough.
  it("deriveBuildingKeys drops a pane that is no longer a live cell (#3429)", () => {
    expect([...deriveBuildingKeys(new Set(), { "alpha:auth": "idle" })]).toEqual([]);
  });

  it("applyRunningActivity marks a project with a live agent as building + healthy, leaves the rest idle", () => {
    const out = applyRunningActivity(projects, new Set(["alpha"]));
    expect(out.find((p) => p.id === "alpha")).toMatchObject({ activity: "building", health: "healthy" });
    expect(out.find((p) => p.id === "beta")).toEqual(projects[1]); // nothing running → stays idle
  });

  it("no running agents → the input is returned untouched", () => {
    expect(applyRunningActivity(projects, new Set())).toBe(projects);
  });
});

// #3429 — the L0 half of the #3415 existence rule. Until this overlay existed the L0 stack could only
// ESCALATE off the merge default, so "nothing is running" and "a session exists but is quiet" both
// rendered `idle` — the exact ambiguity #3415 removed one layer down.
describe("applyDormantHealth — no session and no live app reads `off`, not `idle` (#3429)", () => {
  const projects: ProjectLite[] = [
    { id: "alpha", name: "Alpha", health: "healthy", activity: "building" },
    { id: "beta", name: "Beta", health: "off", activity: "idle" },
  ];

  it("marks a project with nothing running as off · idle", () => {
    const out = applyDormantHealth(projects, new Set(["alpha"]));
    expect(out.find((p) => p.id === "beta")).toMatchObject({ health: "off", activity: "idle" });
  });

  it("leaves a project with a live session or a live app untouched", () => {
    const out = applyDormantHealth(projects, new Set(["alpha"]));
    expect(out.find((p) => p.id === "alpha")).toEqual(projects[0]);
  });

  it("reads every project off when nothing at all is running — the no-launched-tabs case", () => {
    for (const p of applyDormantHealth(projects, new Set())) {
      expect(p).toMatchObject({ health: "off", activity: "idle" });
    }
  });

  // Order matters: dormancy is applied BEFORE the fault overlay, so an unfixed error still surfaces on a
  // project nobody is working on rather than being hidden behind `off`.
  it("does not mask an unresolved fault — the fault overlay still wins over dormancy", () => {
    const dormant = applyDormantHealth(projects, new Set());
    const out = applyFaultHealth(dormant, { beta: { level: "error", title: "boom", count: 1 } as GlanceFault });
    expect(out.find((p) => p.id === "beta")).toMatchObject({ health: "error", reason: "boom" });
  });
});

describe("applyFaultHealth — worst fault → warning/error + reason (#2541)", () => {
  const projects: ProjectLite[] = [
    { id: "a", name: "A", health: "healthy", activity: "live" },
    { id: "b", name: "B", health: "off", activity: "building" },
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

describe("applyOffHealth — the manual OFF toggle wins over every derived status (#3239)", () => {
  const projects: ProjectLite[] = [
    { id: "a", name: "A", health: "error", activity: "building", reason: "boom", faults: 2 },
    { id: "b", name: "B", health: "healthy", activity: "live" },
  ];

  it("forces health 'off' and drops the fault reason for a deactivated node (mute beats an error)", () => {
    const out = applyOffHealth(projects, { a: true });
    expect(out.find((p) => p.id === "a")).toMatchObject({ health: "off", reason: undefined });
    // The activity axis is untouched (the canvas renders "off" over it) — off is a HEALTH value.
    expect(out.find((p) => p.id === "a")?.activity).toBe("building");
  });

  it("leaves an ON (absent) node untouched", () => {
    const out = applyOffHealth(projects, { a: true });
    expect(out.find((p) => p.id === "b")).toEqual(projects[1]);
  });

  it("treats a falsy entry as ON (sparse map: absent/false ⇒ on)", () => {
    const out = applyOffHealth(projects, { a: false });
    expect(out.find((p) => p.id === "a")?.health).toBe("error"); // not deactivated
  });

  it("an empty off-map returns the nodes unchanged", () => {
    expect(applyOffHealth(projects, {})).toEqual(projects);
  });
});

describe("useGlanceProjects — wires 'live' from project_liveness (#2263)", () => {
  beforeEach(() => {
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null, triagedProjects: { "billing-svc": 1 } });
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
    expect(result.current[0].activity).toBe("idle"); // no running agents → idle, never flips to live
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
    // Triaged so the machinery-under-test projects render (the drafted→triaged gate, #2541).
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null, triagedProjects: { "cached-project": 1, "acme-crm": 1 } });
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
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "tok", githubState: null, triagedProjects: { "cached-project": 1 } });
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
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null, triagedProjects: { "restored-app": 1 } });
    vi.mocked(invoke).mockReset();
  });

  it("merge seeds a node for a local published hub — keyed by the HUB folder key — when GitHub is absent", () => {
    const merged = mergeGlanceProjects({}, [], [{ key: "acme-crm", title: "Acme CRM" }]);
    expect(merged).toHaveLength(1);
    // The hub key IS the drill / fleetPaneStreams key — never a fabricated one. Rests at idle (#2551).
    expect(merged[0]).toMatchObject({ id: "acme-crm", name: "Acme CRM", activity: "idle", health: "off" });
  });

  it("a GitHub record OVERLAYS the local node — collapsing onto a LEGACY hub key via slug(title)", () => {
    const merged = mergeGlanceProjects({}, [gh("PVT_1", "Acme CRM", true)], [{ key: "p-legacy1", title: "Acme CRM" }]);
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

describe("mergeDbIntoDrafts — the durable projects DB is a source, the store map is a cache (#3966)", () => {
  const db = (key: string, state: string, over: Partial<DbProject> = {}): DbProject => ({
    key, title: key, pitch: "", blueprint: null, category: null, state,
    createdAt: 10, updatedAt: 20, ...over,
  });

  // THE regression. `studio-code` was in projects.db, open in the planner and triaged, yet had no
  // Glance node — because `localDraftProjects` (a persisted cache written only by `addDraftProject`,
  // and reset wholesale by `resetProjectData`) never got the entry, and Glance read only that map.
  it("adds a project the store cache never got", () => {
    const out = mergeDbIntoDrafts({}, [db("studio-code", "drafted", { title: "studio code" })]);
    expect(Object.keys(out)).toEqual(["studio-code"]);
    expect(out["studio-code"].title).toBe("studio code");
  });

  // The FOLLOW-UP defect. The first cut admitted only drafted/planning — copied from `mergeDbDrafts`,
  // which feeds a DRAFTS-ONLY list where created/published render in other sections. Glance has no
  // other section, so a `created` project belonged to no source at all and vanished from the graph.
  // A triaged project whose state had advanced drafted → created hit exactly this.
  it("admits a `created` project — it belongs to no other Glance source", () => {
    const out = mergeDbIntoDrafts({}, [db("studio-code", "created", { title: "studio code" })]);
    expect(out["studio-code"]).toMatchObject({ title: "studio code" });
  });

  // `published` stays out: mergeGlanceProjects already overrides a draft with the published entry on a
  // key collision, and the drafts map doubles as the `isDraft` signal for resolveProjectCategory — a
  // published project in here would default to `greenfield` rather than `maintain`.
  it("admits every non-published state and excludes published", () => {
    const out = mergeDbIntoDrafts({}, [
      db("a", "drafted"), db("b", "planning"), db("c", "created"), db("d", "published"),
    ]);
    expect(Object.keys(out).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps a published project OUT of the isDraft signal, so its category stays maintain", () => {
    const out = mergeDbIntoDrafts({}, [db("shipped", "published")]);
    expect(out.shipped).toBeUndefined();
    expect(resolveProjectCategory(undefined, undefined, out.shipped !== undefined)).toBe("maintain");
  });

  // A DB row has no column for the curated axes, so merging it must not flatten a demo project's
  // authored colouring — a naive `{...cached, ...dbRow}` would strip role/health/activity.
  it("keeps the cache's curated axes and preferred fields when both sides have the key", () => {
    const cached = {
      demo: { title: "Demo", pitch: "cached pitch", createdAt: 5, role: "service" as const, health: "warning" as const, activity: "review" as const },
    };
    const out = mergeDbIntoDrafts(cached, [db("demo", "drafted", { title: "DB Title", pitch: "db pitch" })]);
    expect(out.demo).toMatchObject({
      title: "Demo", pitch: "cached pitch", createdAt: 5,
      role: "service", health: "warning", activity: "review",
    });
  });

  // The DB fills only what the cache is actually missing.
  it("fills blank cache fields from the DB row", () => {
    const out = mergeDbIntoDrafts({ demo: { title: "", pitch: "", createdAt: 0 } }, [
      db("demo", "drafted", { title: "From DB", pitch: "db pitch", createdAt: 77 }),
    ]);
    expect(out.demo).toMatchObject({ title: "From DB", pitch: "db pitch", createdAt: 77 });
  });

  // The bridge returns null when it's unreachable (web shell, tests, an old bundled `bsc` with no
  // `project db` verb). The hook keeps its previous rows; the pure fn must not choke on an empty set.
  it("is a no-op on an empty or non-array db set, preserving the cache", () => {
    const cached = { demo: { title: "Demo", pitch: "p", createdAt: 1 } };
    expect(mergeDbIntoDrafts(cached, [])).toEqual(cached);
    expect(mergeDbIntoDrafts(cached, null as unknown as DbProject[])).toEqual(cached);
  });

  it("does not mutate the store map it was handed", () => {
    const cached = { demo: { title: "Demo", pitch: "p", createdAt: 1 } };
    mergeDbIntoDrafts(cached, [db("other", "drafted")]);
    expect(Object.keys(cached)).toEqual(["demo"]);
  });

  // The pure-fn tests above CANNOT see whether the hook actually calls the merge — bypassing the
  // `effectiveDrafts` memo leaves all of them green. (That is precisely how the #1102 regression test
  // stayed green while its bug shipped: it asserted its own helper call, not the production path.)
  // These drive the real hook through the real `bsc project db list` bridge.
  describe("hook wiring — the graph itself, not just the helper", () => {
    /** Answer the two invokes the hook makes: the local hub inventory and the `bsc` bridge. */
    const mockBridge = (rows: unknown) =>
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "list_local_projects") return [];
        const argv = (args as { args?: string[] } | undefined)?.args;
        if (cmd === "bsc" && argv?.join(" ") === "project db list --json") {
          return JSON.stringify(rows);
        }
        return null;
      });

    it("renders a node for a triaged project that exists ONLY in projects.db (#3966)", async () => {
      useAppStore.setState({
        localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null,
        triagedProjects: { "studio-code": 1 },
      });
      mockBridge([{ key: "studio-code", title: "studio code", pitch: "", state: "drafted", createdAt: 1, updatedAt: 2 }]);
      const { result } = renderHook(() => useGlanceProjects());
      await waitFor(() => expect(result.current.some((p) => p.id === "studio-code")).toBe(true));
    });

    // The end-to-end shape of the follow-up defect, at the level the user actually sees: triaging
    // advances the row to `created`, and the graph must still show it. The pure-fn test above covers
    // the filter; this covers the filter AS WIRED, which is where the first fix looked fine and wasn't.
    //
    // NOTE the distinct key. `dbProjectsCache` is module-level (deliberately — it survives the Rail's
    // unmount/remount), so it also survives BETWEEN TESTS: reusing `studio-code` here let the previous
    // test's cached `drafted` row satisfy this one, and the assertion passed even with the narrow
    // filter restored. A unique key per hook test is what makes the assertion mean anything.
    it("renders a node once triage has advanced the row to `created` (#3966)", async () => {
      useAppStore.setState({
        localDraftProjects: {}, planFleet: {}, githubToken: "", githubState: null,
        triagedProjects: { "triaged-created": 1785349752066 },
      });
      mockBridge([{ key: "triaged-created", title: "Triaged Created", pitch: "", state: "created", createdAt: 1784918799301, updatedAt: 1785349712038 }]);
      const { result } = renderHook(() => useGlanceProjects());
      await waitFor(() => expect(result.current.some((p) => p.id === "triaged-created")).toBe(true));
    });

    it("keeps rendering the store cache when the bridge is unreachable", async () => {
      useAppStore.setState({
        localDraftProjects: { cached: { title: "Cached", pitch: "", createdAt: 1 } },
        planFleet: {}, githubToken: "", githubState: null, triagedProjects: { cached: 1 },
      });
      // `bsc` throwing is the old-binary / web-shell case — listDbProjects returns null.
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "list_local_projects") return [];
        if (cmd === "bsc") throw new Error("no bsc bridge");
        return null;
      });
      const { result } = renderHook(() => useGlanceProjects());
      await waitFor(() => expect(result.current.some((p) => p.id === "cached")).toBe(true));
    });
  });
});
