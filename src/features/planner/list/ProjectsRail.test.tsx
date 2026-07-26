import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectsRail } from "./ProjectsRail";
import { typeCounts, type ProjectStatus, type AppType } from "./projectsFilter";

const counts: Record<ProjectStatus, number> = { active: 2, shipped: 1, "in-progress": 0, draft: 3 };
const typeCountsByCat = typeCounts([]); // all-zero baseline (every AppType key present)

function rail(over: Partial<Parameters<typeof ProjectsRail>[0]> = {}) {
  return (
    <ProjectsRail
      query="" setQuery={() => {}}
      statusSel={new Set()} toggleStatus={() => {}}
      typeSel={new Set()} toggleType={() => {}}
      counts={counts} typeCountsByCat={typeCountsByCat} total={6}
      onClearStatus={() => {}} onClearType={() => {}} onClearFilters={() => {}}
      {...over}
    />
  );
}

describe("ProjectsRail", () => {
  it("renders the search box and both facet groups", () => {
    render(rail());
    expect(screen.getByLabelText("Search projects")).toBeInTheDocument();
    // Status facet labels
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
    // Type (application-architecture) facet labels
    expect(screen.getByText("application")).toBeInTheDocument();
    expect(screen.getByText("serverless")).toBeInTheDocument();
    expect(screen.getByText("desktop app")).toBeInTheDocument();
  });

  it("emits search input upward", () => {
    const setQuery = vi.fn();
    render(rail({ setQuery }));
    fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "crm" } });
    expect(setQuery).toHaveBeenCalledWith("crm");
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

  it("shows the clear-all footer only when a filter is active", () => {
    const onClearFilters = vi.fn();
    const { rerender } = render(rail());
    expect(screen.queryByText("clear all filters")).not.toBeInTheDocument();
    rerender(rail({ query: "x", onClearFilters }));
    fireEvent.click(screen.getByText("clear all filters"));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
