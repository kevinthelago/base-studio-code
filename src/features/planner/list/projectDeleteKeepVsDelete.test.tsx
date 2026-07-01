import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";

// #1216 — the published-project delete is a Keep-vs-Delete modal:
//   • "Keep the app" (default/safe): local cleanup only, NO GitHub DELETE_MUTATION.
//   • "Delete everything": local cleanup PLUS the GitHub project DELETE_MUTATION, behind an
//     explicit second confirm.
// And the draft ✕ now opens a confirmation modal before destroying the folder.

const PUBLISHED = {
  id: "PVT_node_1",
  number: 9,
  title: "Shipped App",
  shortDescription: "a published project",
  url: "https://github.com/o/shipped",
  closed: false,
  updatedAt: new Date().toISOString(),
  items: { totalCount: 0, nodes: [] },
  repositories: { nodes: [{ nameWithOwner: "o/shipped" }] },
};

/** Route the mocked Tauri `invoke`, recording which GraphQL queries were sent so a test can assert
 *  whether the DELETE_MUTATION ran. */
function routeInvoke() {
  const graphqlCalls: Array<{ query: string; variables: unknown }> = [];
  const repoDeleteCalls: string[] = [];
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "list_local_projects") return Promise.resolve([]);
    if (cmd === "github_delete") { repoDeleteCalls.push(String(args?.path ?? "")); return Promise.resolve(null); }
    if (cmd === "github_graphql") {
      const query = String(args?.query ?? "");
      // The initial PROJECTS_QUERY returns the published project; record + answer DELETE separately.
      if (query.includes("deleteProjectV2")) {
        graphqlCalls.push({ query, variables: args?.variables });
        return Promise.resolve({ deleteProjectV2: { projectV2: { id: PUBLISHED.id } } });
      }
      graphqlCalls.push({ query, variables: args?.variables });
      return Promise.resolve({ viewer: { projectsV2: { nodes: [PUBLISHED] } } });
    }
    if (cmd === "delete_project_dir") return Promise.resolve(null);
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
  return {
    deleteMutationRan: () => graphqlCalls.some(c => c.query.includes("deleteProjectV2")),
    deleteDirCalled: () => vi.mocked(invoke).mock.calls.some(c => c[0] === "delete_project_dir"),
    repoDeletes: () => repoDeleteCalls,
  };
}

/** Open the ⋯ menu on the published row and click "delete project" to open the Keep-vs-Delete modal.
 *  Several elements carry the "More options" title (each row + each blueprint card); the project
 *  row's is the first. */
function openDeleteModal() {
  fireEvent.click(screen.getAllByTitle("More options")[0]);
  fireEvent.click(screen.getByText("delete project"));
}

describe("ProjectsList — published delete (Keep vs Delete, #1216)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({
      activeWorkspace: "projects",
      githubToken: "gho_test",
      localDraftProjects: {},
      hiddenProjectIds: [],
    });
  });

  it("offers both Keep and Delete-everything actions plus cancel", async () => {
    routeInvoke();
    render(<ProjectsList />);
    await screen.findByText("Shipped App");
    openDeleteModal();
    expect(screen.getByText(/Keep the app/i)).toBeTruthy();
    expect(screen.getAllByText(/Delete everything/i).length).toBeGreaterThan(0);
    // The destructive copy clarifies repos/code are NOT deleted by the GitHub project delete.
    expect(screen.getByText(/board, milestones, issues, and repos stay intact/i)).toBeTruthy();
    expect(screen.getByText(/repos and their code are not deleted/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  });

  it("Delete everything + repositories deletes each repo, the board, and the local copy", async () => {
    const r = routeInvoke();
    render(<ProjectsList />);
    await screen.findByText("Shipped App");
    openDeleteModal();
    // The 3rd, most-destructive option arms its own confirm…
    fireEvent.click(screen.getByText(/permanently deletes the linked GitHub repositories/i));
    // …then confirm.
    fireEvent.click(screen.getByRole("button", { name: /delete everything \+ repos/i }));
    // Each linked repo is DELETEd, then the board, then the local copy.
    await waitFor(() => expect(r.repoDeletes()).toContain("repos/o/shipped"));
    expect(r.deleteMutationRan()).toBe(true);
    expect(r.deleteDirCalled()).toBe(true);
  });

  it("Keep does local cleanup and does NOT run the GitHub DELETE_MUTATION", async () => {
    const r = routeInvoke();
    render(<ProjectsList />);
    await screen.findByText("Shipped App");
    openDeleteModal();
    fireEvent.click(screen.getByText(/Keep the app/i));
    await waitFor(() => expect(screen.queryByText("Shipped App")).toBeNull());
    expect(r.deleteDirCalled()).toBe(true);
    expect(r.deleteMutationRan()).toBe(false);
    // Persisted dismissal so the next GitHub sync doesn't re-list it.
    expect(useAppStore.getState().hiddenProjectIds).toContain(PUBLISHED.id);
  });

  it("Delete everything runs BOTH local cleanup and the GitHub DELETE_MUTATION (behind a 2nd confirm)", async () => {
    const r = routeInvoke();
    render(<ProjectsList />);
    await screen.findByText("Shipped App");
    openDeleteModal();
    // Arm the destructive path (the choice-view button, identified by its description) — this alone
    // must NOT delete yet.
    fireEvent.click(screen.getByText(/Removes the local copy AND deletes the GitHub project board/i));
    expect(r.deleteMutationRan()).toBe(false);
    // The explicit second confirm (the danger button in the confirm view).
    fireEvent.click(screen.getByRole("button", { name: /delete everything/i }));
    await waitFor(() => expect(screen.queryByText("Shipped App")).toBeNull());
    expect(r.deleteDirCalled()).toBe(true);
    expect(r.deleteMutationRan()).toBe(true);
    expect(useAppStore.getState().hiddenProjectIds).toContain(PUBLISHED.id);
  });

  it("arming Delete-everything then choosing Back returns to the choice without deleting", async () => {
    const r = routeInvoke();
    render(<ProjectsList />);
    await screen.findByText("Shipped App");
    openDeleteModal();
    fireEvent.click(screen.getByText(/Removes the local copy AND deletes the GitHub project board/i));
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    // Back at the choice screen: Keep is offered again, nothing deleted.
    expect(screen.getByText(/Keep the app/i)).toBeTruthy();
    expect(r.deleteMutationRan()).toBe(false);
    expect(r.deleteDirCalled()).toBe(false);
  });
});

describe("ProjectsList — draft delete now requires confirmation (#1216)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({
      activeWorkspace: "projects",
      githubToken: "gho_test",
      localDraftProjects: { my_draft: { title: "My Draft", pitch: "a pitch", createdAt: 1 } },
      hiddenProjectIds: [],
    });
  });

  it("clicking the chip ✕ opens a confirmation and does not delete until confirmed", async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(((cmd: string) => {
      calls.push(cmd);
      if (cmd === "list_local_projects") return Promise.resolve([]);
      if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
      return Promise.resolve(null);
    }) as unknown as typeof invoke);

    render(<ProjectsList />);
    await screen.findByText("My Draft");
    // The ✕ on the chip — opens the confirm modal, must NOT delete the folder yet.
    fireEvent.click(screen.getByTitle("delete draft"));
    expect(screen.getByText("Delete draft?")).toBeTruthy();
    expect(calls.includes("delete_project_dir")).toBe(false);
    // "My Draft" now appears both on the chip and in the modal's <b>; still present (not deleted).
    expect(screen.getAllByText("My Draft").length).toBeGreaterThan(0);

    // Confirm — now it deletes.
    fireEvent.click(screen.getByRole("button", { name: /delete draft/i }));
    await waitFor(() => expect(screen.queryByText("My Draft")).toBeNull());
    expect(calls.includes("delete_project_dir")).toBe(true);
    expect(useAppStore.getState().localDraftProjects.my_draft).toBeUndefined();
  });

  it("cancelling the draft confirmation keeps the draft and deletes nothing", async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(((cmd: string) => {
      calls.push(cmd);
      if (cmd === "list_local_projects") return Promise.resolve([]);
      if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
      return Promise.resolve(null);
    }) as unknown as typeof invoke);

    render(<ProjectsList />);
    await screen.findByText("My Draft");
    fireEvent.click(screen.getByTitle("delete draft"));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText("Delete draft?")).toBeNull());
    expect(calls.includes("delete_project_dir")).toBe(false);
    expect(screen.getByText("My Draft")).toBeTruthy();
    expect(useAppStore.getState().localDraftProjects.my_draft).toBeTruthy();
  });
});
