// #2445 — logged out of GitHub, published projects must still appear in the Projects page: the
// published column renders the LOCAL inventory (hubs carrying `.published` + `.title`) with a quiet
// "not synced" hint, and a fetched GitHub board overlays its hub once the query returns.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";
import type { GhProject } from "./PublishedProjects";

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
    useAppStore.setState({ activeWorkspace: "projects", localDraftProjects: {}, hiddenProjectIds: [] });
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
  });
});
