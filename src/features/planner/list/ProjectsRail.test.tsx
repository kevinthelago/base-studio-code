import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectsRail } from "./ProjectsRail";
import { typeCounts, type ProjectStatus, type AppType } from "./projectsFilter";

const counts: Record<ProjectStatus, number> = { active: 2, shipped: 1, "in-progress": 0, draft: 3 };
const typeCountsByCat = typeCounts([]); // all-zero baseline (every AppType key present)

function rail(over: Partial<Parameters<typeof ProjectsRail>[0]> = {}) {
  return (
    <ProjectsRail
      query=""
      statusSel={new Set()} toggleStatus={() => {}}
      typeSel={new Set()} toggleType={() => {}}
      counts={counts} typeCountsByCat={typeCountsByCat} total={6}
      onClearStatus={() => {}} onClearType={() => {}} onClearFilters={() => {}}
      {...over}
    />
  );
}

describe("ProjectsRail", () => {
  it("renders both facet groups (search moved to the list header, #3854)", () => {
    render(rail());
    expect(screen.queryByLabelText("Search projects")).toBeNull(); // the header owns it now
    // Status facet labels
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
    // Type (application-architecture) facet labels
    expect(screen.getByText("application")).toBeInTheDocument();
    expect(screen.getByText("serverless")).toBeInTheDocument();
    expect(screen.getByText("desktop app")).toBeInTheDocument();
  });

  it("toggles a status facet and a type facet", () => {
    const toggleStatus = vi.fn(); const toggleType = vi.fn();
    render(rail({ toggleStatus, toggleType }));
    fireEvent.click(screen.getByText("shipped"));
    expect(toggleStatus).toHaveBeenCalledWith("shipped");
    fireEvent.click(screen.getByText("serverless"));
    expect(toggleType).toHaveBeenCalledWith("serverless" satisfies AppType);
  });

  it("the two 'All' rows clear their own facet", () => {
    const onClearStatus = vi.fn(); const onClearType = vi.fn();
    render(rail({ onClearStatus, onClearType }));
    const alls = screen.getAllByText("All");
    fireEvent.click(alls[0]); // Status All
    expect(onClearStatus).toHaveBeenCalledTimes(1);
    fireEvent.click(alls[1]); // Type All
    expect(onClearType).toHaveBeenCalledTimes(1);
  });

  it("draws each facet as a pill switch whose pressed state tracks the selection (#3826)", () => {
    // The switch is presentational (RailRow owns the click, and an interactive control can't nest
    // inside its <button>), so the ROW carries the on/off semantics — that's what a screen reader
    // reads, and what makes the switch visual honest rather than decorative.
    const { rerender } = render(rail());
    const shipped = screen.getByText("shipped").closest("button")!;
    expect(shipped).toHaveAttribute("aria-pressed", "false");

    rerender(rail({ statusSel: new Set<ProjectStatus>(["shipped"]) }));
    expect(screen.getByText("shipped").closest("button")!).toHaveAttribute("aria-pressed", "true");

    // The same for the Type facet.
    rerender(rail({ typeSel: new Set<AppType>(["serverless"]) }));
    expect(screen.getByText("serverless").closest("button")!).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("application").closest("button")!).toHaveAttribute("aria-pressed", "false");
  });

  it("the 'All' rows are not switches — they clear rather than toggle", () => {
    // Guards against sprinkling aria-pressed onto every row: "All" is an action, not an on/off facet.
    render(rail());
    expect(screen.getAllByText("All")[0].closest("button")!).not.toHaveAttribute("aria-pressed");
  });

  it("shows the clear-all footer only when a filter is active", () => {
    const onClearFilters = vi.fn();
    const { rerender } = render(rail());
    expect(screen.queryByText("clear all filters")).not.toBeInTheDocument();
    rerender(rail({ query: "x", onClearFilters }));
    fireEvent.click(screen.getByText("clear all filters"));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
