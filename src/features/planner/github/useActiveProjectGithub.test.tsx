import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
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
  it("returns the active project alongside an idle query (no token ⇒ no fetch)", () => {
    useAppStore.setState({
      activeProjectId: "P9", activeProjectName: "", activeProjectRepo: "",
      activeProjectRepos: [], activeProjectNumber: undefined, githubToken: "",
    });
    render(<QueryProbe />);
    expect(screen.getByTestId("q").textContent).toBe("P9|null|false|null");
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
});
