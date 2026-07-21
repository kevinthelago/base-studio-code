import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { DEFAULT_MAX_AGE_SECS } from "@/shared/lib/github/github";
import { useActiveProject, useActiveProjectGithub, QueryBanner } from "./useActiveProjectGithub";

function Probe() {
  const p = useActiveProject();
  return <div data-testid="p">{JSON.stringify(p)}</div>;
}

function QueryProbe() {
  const { project, data, loading, error } = useActiveProjectGithub("query{}");
  return <div data-testid="q">{`${project.id}|${String(data)}|${String(loading)}|${String(error)}`}</div>;
}

describe("useActiveProject", () => {
  it("assembles ActiveProjectInfo from the store", () => {
    useAppStore.setState({
      activeProjectId: "P1", activeProjectName: "App",
      activeProjectRepo: "o/r", activeProjectRepos: ["o/r", "o/s"], activeProjectNumber: 7,
    });
    render(<Probe />);
    expect(JSON.parse(screen.getByTestId("p").textContent!)).toEqual({
      id: "P1", number: 7, name: "App", repo: "o/r", repos: ["o/r", "o/s"], description: "",
    });
  });

  it("defaults id to '' when there is no active project", () => {
    useAppStore.setState({ activeProjectId: null });
    render(<Probe />);
    expect(JSON.parse(screen.getByTestId("p").textContent!).id).toBe("");
  });
});

describe("useActiveProjectGithub", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("returns the active project alongside an idle query (no token ⇒ no fetch)", () => {
    useAppStore.setState({
      activeProjectId: "P9", activeProjectName: "", activeProjectRepo: "",
      activeProjectRepos: [], activeProjectNumber: undefined, githubToken: "",
    });
    render(<QueryProbe />);
    expect(screen.getByTestId("q").textContent).toBe("P9|null|false|null");
  });

  // #2447 — the board screens (Board / Issues / Insights) all fetch through this hook, and it
  // used to `invoke("github_graphql")` with NO `maxAgeSecs`, so every navigation re-POSTed the
  // heavy `items(first:100)` scan. Routed through `githubGraphql`, the payload must carry the
  // default TTL so the backend cache serves repeat views within the window.
  it("sends the board query through the TTL cache (maxAgeSecs in the payload)", async () => {
    vi.mocked(invoke).mockResolvedValue({ node: {} });
    useAppStore.setState({
      activeProjectId: "PVT_1", activeProjectName: "", activeProjectRepo: "",
      activeProjectRepos: [], activeProjectNumber: undefined, githubToken: "gho_test",
    });
    render(<QueryProbe />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("github_graphql", {
      token: "gho_test",
      query: "query{}",
      variables: { id: "PVT_1" },
      maxAgeSecs: DEFAULT_MAX_AGE_SECS,
      force: undefined,
    }));
  });
});

describe("QueryBanner", () => {
  it("renders the error text when present", () => {
    render(<QueryBanner error="boom" />);
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("renders nothing when there is no error", () => {
    const { container } = render(<QueryBanner error={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("merges a style override (e.g. a screen's margin)", () => {
    render(<QueryBanner error="x" style={{ margin: 8 }} />);
    expect((screen.getByText("x") as HTMLElement).style.margin).toBe("8px");
  });

  // #2448 — a rate-limited query is expected, quiet degradation (the screens keep their cached
  // data), not a failure: the typed backend error renders as a dim note, never the red callout.
  it("renders a rate-limited error as a quiet note instead of the danger banner", () => {
    render(<QueryBanner error="github rate-limited until 4102444800" />);
    const note = screen.getByText(/GitHub rate limit reached/);
    expect(note).toBeTruthy();
    expect((note as HTMLElement).style.color).not.toBe("var(--danger)");
    // The raw typed error string is not shown to the user.
    expect(screen.queryByText(/rate-limited until 4102444800/)).toBeNull();
  });
});
