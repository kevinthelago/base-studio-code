// #2998 — orphaned-scaffold cleanup: bare on-disk hubs with no plan/title/publish are invisible in
// the lists (buildDrafts filters them out) yet clutter `projects/`. The Projects page surfaces a
// de-emphasized "N orphaned scaffolds" line with a "Clean up" button; confirming the modal deletes
// each orphan folder (one `delete_project_dir` per orphan) and leaves real/titled hubs untouched.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";

const ORPHANS = [
  { key: "admin-console", title: "admin-console", hasPlan: false, updatedAt: 1, published: false, titled: false },
  { key: "test_with_kit", title: "test_with_kit", hasPlan: false, updatedAt: 1, published: false, titled: false },
];
// A real hub (has a plan) is NOT an orphan — it must never be cleaned up.
const REAL = { key: "real-app", title: "Real App", hasPlan: true, updatedAt: 5, published: false, titled: true };

describe("ProjectsList — orphaned-scaffold cleanup (#2998)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({
      activeWorkspace: "projects",
      githubToken: "", // logged out → no GitHub fetch / reconcile noise; orphans don't need it
      hiddenProjectIds: [],
      githubState: null,
      localDraftProjects: {},
    });
  });

  it("deletes one folder per orphan on confirm, leaving real hubs untouched", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    let localList: typeof ORPHANS | Array<(typeof ORPHANS)[number] | typeof REAL> = [...ORPHANS, REAL];
    vi.mocked(invoke).mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "list_local_projects") return Promise.resolve(localList);
      if (cmd === "delete_project_dir") {
        const key = (args as { projectKey?: string })?.projectKey;
        localList = (localList as Array<{ key: string }>).filter(lp => lp.key !== key) as typeof localList;
        return Promise.resolve(null);
      }
      if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
      if (cmd === "bsc") return Promise.resolve(""); // db list → fallback (no rows); remove → ok
      return Promise.resolve(null);
    }) as unknown as typeof invoke);

    render(<ProjectsList />);

    // The real hub renders as a draft chip; the orphan cleanup line surfaces the 2 bare scaffolds.
    await screen.findByText("Real App");
    fireEvent.click(await screen.findByRole("button", { name: /clean up/i }));

    // The confirm modal lists exactly what will be deleted…
    expect(screen.getByText("· admin-console")).toBeTruthy();
    expect(screen.getByText("· test_with_kit")).toBeTruthy();
    // …then confirming fires one delete_project_dir per orphan (and never for the real hub).
    fireEvent.click(screen.getByRole("button", { name: /delete 2 scaffold/i }));

    await waitFor(() => {
      const dels = calls.filter(c => c.cmd === "delete_project_dir");
      expect(dels).toHaveLength(2);
      expect(dels.map(c => (c.args as { projectKey: string }).projectKey).sort()).toEqual(["admin-console", "test_with_kit"]);
    });
  });

  it("shows no cleanup affordance when there are no orphans", async () => {
    vi.mocked(invoke).mockImplementation(((cmd: string) => {
      if (cmd === "list_local_projects") return Promise.resolve([REAL]);
      if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
      if (cmd === "bsc") return Promise.resolve("");
      return Promise.resolve(null);
    }) as unknown as typeof invoke);

    render(<ProjectsList />);
    await screen.findByText("Real App");
    expect(screen.queryByRole("button", { name: /clean up/i })).toBeNull();
    expect(screen.queryByText(/orphaned scaffold/i)).toBeNull();
  });
});
