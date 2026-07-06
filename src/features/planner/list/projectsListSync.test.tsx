import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectsList } from "./ProjectsList";
import { useAppStore } from "@/store";
import { DEFAULT_MAX_AGE_SECS } from "@/shared/lib/github/github";

// #2447 — the projects-list board read used to `invoke("github_graphql")` with NO `maxAgeSecs`,
// so every tab re-open re-POSTed the full projectsV2 scan. It now goes through `githubGraphql`
// (backend TTL cache); the manual "↻ sync" button is the explicit-refresh affordance and must
// bypass the window with `force: true`.

/** All github_graphql payloads the component sent, in order. */
function graphqlCalls(): Record<string, unknown>[] {
  return vi.mocked(invoke).mock.calls
    .filter(([cmd]) => cmd === "github_graphql")
    .map(([, args]) => args as Record<string, unknown>);
}

describe("ProjectsList — board reads hit the TTL cache (#2447)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(((cmd: string) => {
      if (cmd === "list_local_projects") return Promise.resolve([]);
      if (cmd === "github_graphql") return Promise.resolve({ viewer: { projectsV2: { nodes: [] } } });
      return Promise.resolve(null);
    }) as unknown as typeof invoke);
    useAppStore.setState({ activeWorkspace: "projects", githubToken: "gho_test" });
  });

  it("the tab-open fetch carries the default TTL (cached within the window)", async () => {
    render(<ProjectsList />);
    await waitFor(() => expect(graphqlCalls().length).toBeGreaterThan(0));
    expect(graphqlCalls()[0]).toMatchObject({
      token: "gho_test",
      maxAgeSecs: DEFAULT_MAX_AGE_SECS,
    });
    expect(graphqlCalls()[0].force).toBeUndefined();
  });

  it("the manual ↻ sync bypasses the TTL with force: true", async () => {
    render(<ProjectsList />);
    // Wait for the initial fetch to settle so the sync button is enabled again.
    await waitFor(() => expect(screen.getByRole("button", { name: /sync/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /sync/i }));
    await waitFor(() => expect(graphqlCalls().length).toBeGreaterThan(1));
    const calls = graphqlCalls();
    expect(calls[calls.length - 1]).toMatchObject({ force: true });
  });
});
