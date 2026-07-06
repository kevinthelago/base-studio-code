// #2445 — logged out of GitHub, published projects must still appear in the Projects page: the
// published column renders the LOCAL inventory (hubs carrying `.published` + `.title`) with a quiet
// "not synced" hint, and a fetched GitHub board overlays its hub once the query returns.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";
import type { GhProject } from "./PublishedProjects";
import type { MinimalGhProject } from "@/shared/lib/github/githubState";

const LOCAL_PUBLISHED = { key: "acme-crm", title: "Acme CRM", hasPlan: true, updatedAt: 5, published: true };

const GH_ACME: GhProject = {
  id: "PVT_1", number: 1, title: "Acme CRM", shortDescription: null, url: "", closed: false,
  updatedAt: new Date().toISOString(), items: { totalCount: 0, nodes: [] }, repositories: { nodes: [] },
};

function routeInvoke(ghNodes: GhProject[]) {
  vi.mocked(invoke).mockImplementation(((cmd: string) => {
    if (cmd === "list_local_projects") return Promise.resolve([LOCAL_PUBLISHED]);
    if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: ghNodes } } });
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
}

describe("ProjectsList — local published inventory (#2445)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({ activeWorkspace: "projects", localDraftProjects: {}, hiddenProjectIds: [], githubState: null });
  });

  it("LOGGED OUT: a local published hub renders in the published column with the not-synced hint", async () => {
    useAppStore.setState({ githubToken: "" });
    routeInvoke([]);
    render(<ProjectsList />);

    // The hub renders from the local inventory — title from `.title`, key as the identity.
    await screen.findByText("Acme CRM");
    expect(screen.getByText("acme-crm")).toBeTruthy();
    // …and the column carries the quiet local-only hint.
    expect(screen.getByText(/not synced/i)).toBeTruthy();
    // A published hub is NOT a draft — no draft chip / delete affordance for it.
    expect(screen.queryByTitle("delete draft")).toBeNull();
  });

  it("LOGGED IN: the fetched board OVERLAYS the hub — one row, no not-synced hint", async () => {
    useAppStore.setState({ githubToken: "gho_test" });
    routeInvoke([GH_ACME]);
    render(<ProjectsList />);

    await screen.findByText("Acme CRM");
    // The GitHub sync landed and its record matched the hub key, so the local row dropped out:
    // exactly ONE "Acme CRM" (the full board ProjectRow) and no local-only hint.
    await waitFor(() => expect(screen.getAllByText("Acme CRM")).toHaveLength(1));
    expect(screen.queryByText(/not synced/i)).toBeNull();
    expect(screen.queryByText("acme-crm")).toBeNull(); // the local row's key line is gone too
    expect(screen.queryByText(/last synced/i)).toBeNull(); // live data — no staleness hint (#2446)
  });
});

// #2446 — the persisted last-known board state renders as a stale-marked overlay: logged out (or
// pre-refresh), a persisted record overlays its local hub as a full board row with a "last synced
// <age>" hint — but a record whose hub was deleted is NOT resurrected.
describe("ProjectsList — persisted GitHub-state overlay (#2446)", () => {
  const record = (title: string): MinimalGhProject => ({
    id: `PVT_${title}`, number: 3, title, shortDescription: null, url: "", closed: false,
    updatedAt: new Date().toISOString(), itemsTotalCount: 4, openCount: 3, closedCount: 1, repos: ["o/r"],
  });

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({
      activeWorkspace: "projects", localDraftProjects: {}, hiddenProjectIds: [],
      githubToken: "", githubState: null,
    });
  });

  it("LOGGED OUT: a persisted record overlays its hub as a board row with the last-synced hint", async () => {
    routeInvoke([]); // no live GitHub — only list_local_projects answers
    useAppStore.setState({
      githubState: {
        records: [record("Acme CRM"), record("Ghost App")], // Ghost App's hub was deleted
        fetchedAt: Date.now() - 2 * 3_600_000,
      },
    });
    render(<ProjectsList />);

    // The record overlays the hub: the richer board row renders (title only — the plain local
    // row's key line is gone) …
    await screen.findByText("Acme CRM");
    await waitFor(() => expect(screen.queryByText("acme-crm")).toBeNull());
    // … under the stale-marked hint instead of the #2445 "not synced" wording.
    expect(screen.getByText(/last synced 2h ago/i)).toBeTruthy();
    expect(screen.queryByText(/not synced/i)).toBeNull();
    // The don't-resurrect rule: a persisted record with no local hub does NOT render.
    expect(screen.queryByText("Ghost App")).toBeNull();
  });

  it("LOGGED IN: the live fetch takes precedence over the persisted overlay (no staleness hint)", async () => {
    useAppStore.setState({
      githubToken: "gho_test",
      githubState: { records: [record("Acme CRM")], fetchedAt: Date.now() - 3_600_000 },
    });
    routeInvoke([GH_ACME]);
    render(<ProjectsList />);

    await screen.findByText("Acme CRM");
    // Once the live sync lands, the stale hint drops and exactly one (live) row renders.
    await waitFor(() => expect(screen.queryByText(/last synced/i)).toBeNull());
    expect(screen.getAllByText("Acme CRM")).toHaveLength(1);
    // The fresh fetch overwrote the persisted records + fetchedAt.
    expect(useAppStore.getState().githubState!.records[0].id).toBe("PVT_1");
  });
});
