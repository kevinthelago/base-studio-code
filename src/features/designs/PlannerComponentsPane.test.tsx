import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { act } from "react";
import { PlannerComponentsPane } from "./PlannerComponentsPane";
import { REACT_UI_KIT, REACT_UI_COMPONENTS } from "./lib/reactUiKit";
import { useAppStore } from "@/store";

// #3543: the packaged seed is now a single EMPTY kit; this pane test drives the react-ui LIBRARY (the
// manifest-generated assembler — the exact populated kit the seed used to carry) so there are components to list.
beforeEach(() => {
  useAppStore.setState({ components: REACT_UI_COMPONENTS, kits: [REACT_UI_KIT], activeWorkspace: "projects" });
});
afterEach(() => { vi.useRealTimers(); });

describe("PlannerComponentsPane (#2314)", () => {
  it("renders the Components list for the active kit with the mode toggle", () => {
    render(<PlannerComponentsPane />);
    expect(screen.getByText("▤ Components")).toBeTruthy();
    expect(screen.getByText("▦ Full UI")).toBeTruthy();
    // First react-ui component is listed.
    expect(screen.getByText("Button")).toBeTruthy();
  });

  it("expands a component inline to show props + guidance + actions", () => {
    render(<PlannerComponentsPane />);
    fireEvent.click(screen.getByText("Chip").closest("button")!);
    expect(screen.getByText("✓ Use when")).toBeTruthy();
    expect(screen.getByText("✗ Avoid")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pull into plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open in studio/ })).toBeTruthy();
  });

  it("Pull into plan flashes a toast that clears after the delay", () => {
    vi.useFakeTimers();
    try {
      render(<PlannerComponentsPane />);
      fireEvent.click(screen.getByText("Button").closest("button")!);
      fireEvent.click(screen.getByRole("button", { name: "Pull into plan" }));
      expect(screen.getByText(/added to the plan/)).toBeTruthy();
      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.queryByText(/added to the plan/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Open in studio hands off to the Planner's Design Studio tab (#move-to-planner)", () => {
    render(<PlannerComponentsPane />);
    fireEvent.click(screen.getByText("Button").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: /Open in studio/ }));
    expect(useAppStore.getState().activeWorkspace).toBe("projects");
    expect(useAppStore.getState().projectsPageMode).toBe("designs");
  });

  it("search filters the component list", () => {
    render(<PlannerComponentsPane />);
    fireEvent.change(screen.getByLabelText("Search components"), { target: { value: "chip" } });
    expect(screen.getByText("Chip")).toBeTruthy();
    expect(screen.queryByText("StatusDot")).toBeNull();
  });

  it("the Full UI mode assembles kit components with a legend", () => {
    render(<PlannerComponentsPane />);
    fireEvent.click(screen.getByText("▦ Full UI"));
    expect(screen.getByText(/Assembled from/)).toBeTruthy();
    expect(screen.getByText("Legend")).toBeTruthy();
    // A legend row selecting a component jumps back to the Components view + expands it.
    const legend = screen.getByText("Legend").closest("div")!;
    const firstRow = within(legend.parentElement!).getAllByRole("button")[0];
    fireEvent.click(firstRow);
    expect(screen.getByText("▤ Components")).toBeTruthy();
  });
});
