import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";

// Repro for the draft-delete crash (#…): deleting a "draft" project
// card must remove the card and never throw — regardless of what `list_local_projects`
// returns (incl. a non-array) or whether the folder delete succeeds.

function routeInvoke(opts: { localProjects?: unknown; deleteRejects?: boolean } = {}) {
  vi.mocked(invoke).mockImplementation(((cmd: string) => {
    if (cmd === "list_local_projects") return Promise.resolve(opts.localProjects ?? []);
    if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
    if (cmd === "delete_project_dir") {
      return opts.deleteRejects ? Promise.reject("folder locked") : Promise.resolve(null);
    }
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
}

// The Projects tab was rebuilt in the Skills-tab style (#3802): a draft is a CARD whose
// destructive action lives behind the ⋯ menu, not an inline ✕ on a chip. So the delete is a
// three-step drive — open the menu, pick "delete draft", then confirm in the modal (#1216).
// The menu item and the modal button never coexist (picking the item closes the menu and opens
// the modal), so the same query resolves unambiguously at each step.
function clickDeleteDraft() {
  fireEvent.click(screen.getByTitle("More options"));
  // EXACT name, not a regex: the card itself is a role=button whose accessible name concatenates
  // its whole subtree, so a loose /delete draft/i also matches the card while the menu is open.
  fireEvent.click(screen.getByRole("button", { name: "delete draft" }));   // menu item
  fireEvent.click(screen.getByRole("button", { name: "delete draft" }));   // modal confirm
}

describe("ProjectsList — draft delete", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({
      activeWorkspace: "projects",
      githubToken: "gho_test",
      localDraftProjects: { my_draft: { title: "My Draft", pitch: "a pitch", createdAt: 1 } },
    });
  });

  it("removes the draft card when delete is confirmed (folder delete ok)", async () => {
    routeInvoke({ localProjects: [] });
    render(<ProjectsList />);
    await screen.findByText("My Draft");
    clickDeleteDraft();
    await waitFor(() => expect(screen.queryByText("My Draft")).toBeNull());
    expect(useAppStore.getState().localDraftProjects.my_draft).toBeUndefined();
  });

  it("surfaces an error (no crash) when the folder delete fails", async () => {
    routeInvoke({ localProjects: [], deleteRejects: true });
    render(<ProjectsList />);
    await screen.findByText("My Draft");
    clickDeleteDraft();
    // The card stays and an inline error appears; the app does not crash.
    await waitFor(() => expect(screen.getByText(/Couldn't delete the folder/)).toBeTruthy());
    expect(screen.getByText("My Draft")).toBeTruthy();
  });

  it("does not crash when list_local_projects returns a non-array", async () => {
    routeInvoke({ localProjects: null });
    render(<ProjectsList />);
    // The draft from the store still renders; the null on-disk list must not throw.
    await screen.findByText("My Draft");
    clickDeleteDraft();
    await waitFor(() => expect(screen.queryByText("My Draft")).toBeNull());
  });
});
