// Issues — per-view empty/loading (#2248). The list keeps its layout: shape-matched skeleton rows
// while loading, a compact EmptyState when there are no issues (or no filter matches), else the live
// rows — instead of the old plain "Loading issues…" / bare-text empty lines.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GithubQuery } from "@/shared/lib/github/useGithubQuery";
import type { ActiveProjectInfo } from "../list/ProjectsHeader";

vi.mock("../list/ProjectsHeader", () => ({ ProjectsHeader: () => null }));
vi.mock("./useActiveProjectGithub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useActiveProjectGithub")>();
  return { ...actual, useActiveProjectGithub: vi.fn() };
});

import { Issues } from "./Issues";
import { useActiveProjectGithub } from "./useActiveProjectGithub";

const mockHook = vi.mocked(useActiveProjectGithub);
const PROJECT: ActiveProjectInfo = { id: "P1", number: 1, name: "App", repo: "o/r", repos: ["o/r"], description: "" };

function setHook(state: Partial<GithubQuery<{ node: Record<string, unknown> }>>) {
  mockHook.mockReturnValue({
    project: PROJECT, data: null, loading: false, error: null, ...state,
  } as ReturnType<typeof useActiveProjectGithub>);
}

const NODE = {
  items: {
    nodes: [
      {
        id: "it1",
        fieldValues: { nodes: [] },
        content: {
          __typename: "Issue", number: 1, title: "First issue", body: "", state: "OPEN",
          updatedAt: "2026-01-01T00:00:00Z",
          labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0 }, milestone: null,
        },
      },
    ],
  },
};

describe("Issues per-view empty/loading (#2248)", () => {
  it("loading → skeleton rows, no plain 'Loading issues…' text and no empty state", () => {
    setHook({ loading: true, data: null });
    const { container } = render(<Issues />);
    expect(screen.queryByText("Loading issues…")).toBeNull();
    expect(screen.queryByText("No issues")).toBeNull();
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0); // skeleton rows
  });

  it("empty (loaded, no issues) → a compact empty state", () => {
    setHook({ loading: false, data: { node: { items: { nodes: [] } } } });
    render(<Issues />);
    expect(screen.getByText("No issues")).toBeTruthy();
    expect(screen.getByText("No issues found in this project.")).toBeTruthy();
  });

  it("content → the real rows render, no empty state", () => {
    setHook({ loading: false, data: { node: NODE } });
    render(<Issues />);
    expect(screen.getByText("First issue")).toBeTruthy();
    expect(screen.queryByText("No issues")).toBeNull();
  });
});
