// Insights — per-card empty/loading states (#2243). The board's Insights dashboard keeps its full
// card layout at all times; each card body is one of three — a loading skeleton, a compact empty
// state, or the real chart — instead of the old page-wide "Loading insights…" screen.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GithubQuery } from "@/shared/lib/github/useGithubQuery";
import type { ActiveProjectInfo } from "../list/ProjectsHeader";

// Stub the header (it auto-clones repos via invoke on mount) so the test isolates the card bodies.
vi.mock("../list/ProjectsHeader", () => ({
  ProjectsHeader: () => null,
}));

// Drive the data hook directly; keep the real QueryBanner.
vi.mock("./useActiveProjectGithub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useActiveProjectGithub")>();
  return { ...actual, useActiveProjectGithub: vi.fn() };
});

import { Insights } from "./Insights";
import { useActiveProjectGithub } from "./useActiveProjectGithub";

const mockHook = vi.mocked(useActiveProjectGithub);

const PROJECT: ActiveProjectInfo = { id: "P1", number: 1, name: "App", repo: "o/r", repos: ["o/r"], description: "" };

/** Shape the hook return the way each state needs. */
function setHook(state: Partial<GithubQuery<{ node: Record<string, unknown> }>>) {
  mockHook.mockReturnValue({
    project: PROJECT,
    data: null, loading: false, error: null,
    ...state,
  } as ReturnType<typeof useActiveProjectGithub>);
}

// A minimal ProjectV2 node: one open + one closed issue, a Status field, and a shared label.
const NOW = new Date().toISOString();
const NODE = {
  fields: { nodes: [{ name: "Status", options: [{ id: "o1", name: "Todo", color: "GRAY" }, { id: "o2", name: "Done", color: "GREEN" }] }] },
  items: {
    nodes: [
      {
        id: "it1",
        fieldValues: { nodes: [{ name: "Todo", optionId: "o1", field: { name: "Status" } }] },
        content: {
          __typename: "Issue", number: 1, state: "OPEN", createdAt: NOW, updatedAt: NOW,
          labels: { nodes: [{ name: "bug", color: "ff0000" }] },
          assignees: { nodes: [{ login: "alice" }] },
          comments: { totalCount: 0 }, milestone: null,
        },
      },
      {
        id: "it2",
        fieldValues: { nodes: [{ name: "Done", optionId: "o2", field: { name: "Status" } }] },
        content: {
          __typename: "Issue", number: 2, state: "CLOSED", createdAt: NOW, updatedAt: NOW,
          labels: { nodes: [{ name: "bug", color: "ff0000" }] },
          assignees: { nodes: [] },
          comments: { totalCount: 0 }, milestone: null,
        },
      },
    ],
  },
};

describe("Insights per-card empty/loading (#2243)", () => {
  it("loading → cards render with skeletons, no page-wide 'Loading insights…' and no empty titles", () => {
    setHook({ loading: true, data: null });
    render(<Insights />);
    // The card headers are always present…
    expect(screen.getByText("Status distribution")).toBeTruthy();
    expect(screen.getByText("Assignee workload")).toBeTruthy();
    expect(screen.getByText("Weekly activity")).toBeTruthy();
    expect(screen.getByText("Label frequency")).toBeTruthy();
    // …the old page-wide loading screen is gone…
    expect(screen.queryByText("Loading insights…")).toBeNull();
    // …and no card shows its empty state yet (skeletons occupy the bodies).
    expect(screen.queryByText("No status field")).toBeNull();
    expect(screen.queryByText("No open issues")).toBeNull();
    expect(screen.queryByText("No activity yet")).toBeNull();
    expect(screen.queryByText("No labels yet")).toBeNull();
  });

  it("empty (loaded, no issues) → each card body shows its compact empty state", () => {
    setHook({ loading: false, data: { node: { fields: { nodes: [] }, items: { nodes: [] } } } });
    render(<Insights />);
    expect(screen.getByText("No status field")).toBeTruthy();
    expect(screen.getByText("No open issues")).toBeTruthy();
    expect(screen.getByText("No activity yet")).toBeTruthy();
    expect(screen.getByText("No labels yet")).toBeTruthy();
  });

  it("content → cards render the real charts, no empty states", () => {
    setHook({ loading: false, data: { node: NODE } });
    render(<Insights />);
    // Status distribution (HBars) labels, assignee login, and the label name all render.
    expect(screen.getByText("Todo")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("bug")).toBeTruthy();
    // No empty states while there's data.
    expect(screen.queryByText("No status field")).toBeNull();
    expect(screen.queryByText("No open issues")).toBeNull();
    expect(screen.queryByText("No activity yet")).toBeNull();
    expect(screen.queryByText("No labels yet")).toBeNull();
  });
});
