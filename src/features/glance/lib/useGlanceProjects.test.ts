import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useGlanceProjects, mergeGlanceProjects, applyLiveness } from "./useGlanceProjects";
import type { GhProject } from "@/features/planner/list/published/publishedModel";
import type { ProjectLite } from "./glanceData";
import { useAppStore } from "@/store";

/** A GhProject with the fields the merge reads; the rest filled so the cast is honest. */
const gh = (id: string, title: string, closed = false): GhProject => ({
  id, number: 1, title, shortDescription: null, url: "", closed, updatedAt: "",
  items: { totalCount: 0, nodes: [] }, repositories: { nodes: [] },
});

describe("useGlanceProjects — declared role/status (#2284)", () => {
  beforeEach(() => useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "" }));

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
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "" });
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
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "gho_test" });
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

describe("useGlanceProjects — published cache survives remount (#2339)", () => {
  beforeEach(() => {
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, githubToken: "" });
    vi.mocked(invoke).mockReset();
  });

  it("a revisit (published fetch not yet landed) still includes the last-known published set", async () => {
    // First visit: a token + a resolving fetch → the published node lands and is cached module-side.
    vi.mocked(invoke).mockResolvedValue({ viewer: { projectsV2: { nodes: [gh("PVT_cached", "Cached Project", false)] } } });
    useAppStore.setState({ githubToken: "tok" });
    const first = renderHook(() => useGlanceProjects());
    await waitFor(() => expect(first.result.current.some((p) => p.name === "Cached Project")).toBe(true));
    first.unmount();

    // Revisit: no token, so useGithubQuery stays { data: null } (no fetch) — but the module cache must
    // seed the merge, so the cached project is present IMMEDIATELY (no drafts-only flash).
    useAppStore.setState({ githubToken: "" });
    const second = renderHook(() => useGlanceProjects());
    expect(second.result.current.some((p) => p.name === "Cached Project")).toBe(true);
    second.unmount();
  });
});
