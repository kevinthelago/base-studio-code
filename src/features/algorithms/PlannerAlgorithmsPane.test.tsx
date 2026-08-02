import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlannerAlgorithmsPane } from "./PlannerAlgorithmsPane";
import { KNOWLEDGE, kitTechs, kitImpls } from "./lib/knowledge";
import { useAppStore } from "@/store";

// No `bsc` in jsdom, so `loadGraph` yields nothing and the pane keeps the packaged seed — which is
// exactly the degraded path a fresh install takes, and it must still render a usable library.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("PlannerAlgorithmsPane (#4265)", () => {
  it("renders the library from the graph, not an empty shell", () => {
    render(<PlannerAlgorithmsPane />);
    const first = kitImpls(KNOWLEDGE, kitTechs(KNOWLEDGE)[0])[0];
    expect(first, "the packaged seed must carry at least one implementation").toBeTruthy();
    expect(screen.getByText(first.name)).toBeInTheDocument();
  });

  it("states the reuse-before-commission framing the features directive orders", () => {
    render(<PlannerAlgorithmsPane />);
    expect(screen.getByText(/reuse before commissioning/i)).toBeInTheDocument();
  });

  it("inspects an implementation inline", () => {
    render(<PlannerAlgorithmsPane />);
    const impls = kitImpls(KNOWLEDGE, kitTechs(KNOWLEDGE)[0]);
    const withSummary = impls.find((im) => im.summary);
    expect(withSummary, "the seed must carry a summarized impl to inspect").toBeTruthy();
    // Collapsed to start — the list is the overview, detail is on demand.
    expect(screen.queryByText(withSummary!.summary!)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(withSummary!.name));
    expect(screen.getByText(withSummary!.summary!)).toBeInTheDocument();
  });

  it("filters by the search query", () => {
    render(<PlannerAlgorithmsPane />);
    const impls = kitImpls(KNOWLEDGE, kitTechs(KNOWLEDGE)[0]);
    const target = impls[0];
    fireEvent.change(screen.getByPlaceholderText(/Search algorithms/i), {
      target: { value: target.name },
    });
    expect(screen.getByText(target.name)).toBeInTheDocument();
    // A query that matches nothing says so rather than rendering a blank list.
    fireEvent.change(screen.getByPlaceholderText(/Search algorithms/i), {
      target: { value: "zzz-no-such-algorithm" },
    });
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("hands off to the algorithms studio", () => {
    const navigate = vi.fn();
    useAppStore.setState({ navigate });
    render(<PlannerAlgorithmsPane />);
    fireEvent.click(screen.getByRole("button", { name: /Open in studio/ }));
    expect(navigate).toHaveBeenCalledWith({ workspace: "projects", page: "algorithms" });
  });
});
