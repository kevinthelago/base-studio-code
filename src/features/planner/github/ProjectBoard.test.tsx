// ProjectBoard — per-card empty/loading (#2248). The board keeps its column layout: skeleton columns
// while loading, a real empty state when there are no items, else the live columns — instead of the
// old page-wide "Loading board…" overlay.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GithubQuery } from "@/shared/lib/github/useGithubQuery";
import type { ActiveProjectInfo } from "../list/ProjectsHeader";

vi.mock("../list/ProjectsHeader", () => ({ ProjectsHeader: () => null }));
vi.mock("./useActiveProjectGithub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useActiveProjectGithub")>();
  return { ...actual, useActiveProjectGithub: vi.fn() };
});

import { ProjectBoard } from "./ProjectBoard";
import { useActiveProjectGithub } from "./useActiveProjectGithub";

const mockHook = vi.mocked(useActiveProjectGithub);
const PROJECT: ActiveProjectInfo = { id: "P1", number: 1, name: "App", repo: "o/r", repos: ["o/r"], description: "" };

function setHook(state: Partial<GithubQuery<{ node: Record<string, unknown> }>>) {
  mockHook.mockReturnValue({
    project: PROJECT, data: null, loading: false, error: null, ...state,
  } as ReturnType<typeof useActiveProjectGithub>);
}

const NODE = {
  fields: { nodes: [{ name: "Status", options: [{ id: "o1", name: "Todo", color: "GRAY" }, { id: "o2", name: "Done", color: "GREEN" }] }] },
  items: {
    nodes: [
      {
        id: "it1",
        fieldValues: { nodes: [{ name: "Todo", optionId: "o1", field: { name: "Status" } }] },
        content: {
          __typename: "Issue", number: 1, title: "First issue", body: "", state: "OPEN",
          labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0 }, milestone: null,
        },
      },
    ],
  },
};

describe("ProjectBoard per-card empty/loading (#2248)", () => {
  it("loading → skeleton columns, no page-wide 'Loading board…' and no empty state", () => {
    setHook({ loading: true, data: null });
    const { container } = render(<ProjectBoard />);
    expect(screen.queryByText("Loading board…")).toBeNull();
    expect(screen.queryByText("No board items yet")).toBeNull();
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0); // skeleton columns
  });

  it("empty (loaded, no items) → a real empty state, not empty columns", () => {
    setHook({ loading: false, data: { node: { fields: { nodes: [] }, items: { nodes: [] } } } });
    render(<ProjectBoard />);
    expect(screen.getByText("No board items yet")).toBeTruthy();
  });

  it("content → the real columns render, no empty state", () => {
    setHook({ loading: false, data: { node: NODE } });
    render(<ProjectBoard />);
    expect(screen.getByText("Todo")).toBeTruthy(); // a column header
    expect(screen.queryByText("No board items yet")).toBeNull();
  });
});
