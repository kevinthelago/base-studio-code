import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useGlanceProjects, mergeGlanceProjects } from "./useGlanceProjects";
import type { GhProject } from "@/features/planner/list/published/publishedModel";
import { useAppStore } from "@/store";

/** A GhProject with the fields the merge reads; the rest filled so the cast is honest. */
const gh = (id: string, title: string, closed = false): GhProject => ({
  id, number: 1, title, shortDescription: null, url: "", closed, updatedAt: "",
  items: { totalCount: 0, nodes: [] }, repositories: { nodes: [] },
});

describe("useGlanceProjects — declared role/status (#2284)", () => {
  beforeEach(() => useAppStore.setState({ localDraftProjects: {}, planFleet: {}, projectKeyAlias: {}, githubToken: "" }));

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

describe("mergeGlanceProjects — draft/published dedup (#2339)", () => {
  it("dedupes a draft + an UN-ALIASED published project with the SAME title to ONE node", () => {
    // The regression: no alias, so the published key would title-derive to a DIFFERENT key than the
    // draft's stable id → two nodes. The sanitize(title)→stableId lookup must collapse them to one.
    const drafts = { "p-abc123": { title: "Billing Service", pitch: "", createdAt: 1, role: "service" as const } };
    const published = [gh("PVT_node1", "Billing Service", false)];

    const merged = mergeGlanceProjects(drafts, {}, {}, published);

    const billing = merged.filter((p) => p.name === "Billing Service");
    expect(billing).toHaveLength(1);
    expect(billing[0].id).toBe("p-abc123");        // collapsed onto the draft's stable id
    expect(billing[0].status).toBe("planning");     // published (open) status wins
    expect(billing[0].role).toBe("service");        // draft-declared role survives the collapse
  });

  it("lets an ALIASED published project override its draft (single node on the aliased key)", () => {
    const drafts = { "p-abc123": { title: "Billing Service", pitch: "", createdAt: 1 } };
    const aliases = { PVT_node1: "p-abc123" };
    const published = [gh("PVT_node1", "Billing Service", true)]; // closed ⇒ shipped ⇒ done

    const merged = mergeGlanceProjects(drafts, {}, aliases, published);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("p-abc123");
    expect(merged[0].status).toBe("done");
  });
});

describe("useGlanceProjects — published cache survives remount (#2339)", () => {
  beforeEach(() => {
    useAppStore.setState({ localDraftProjects: {}, planFleet: {}, projectKeyAlias: {}, githubToken: "" });
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
