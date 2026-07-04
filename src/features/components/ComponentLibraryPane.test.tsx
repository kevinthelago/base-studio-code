import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { act } from "react";
import { ComponentLibraryPane } from "./ComponentLibraryPane";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { useAppStore } from "@/store";

/** Reset the library slice to the seed before each test (the store is a singleton). */
beforeEach(() => {
  useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS });
});

const heading = () => screen.getByRole("heading", { level: 2 }).textContent;

describe("ComponentLibraryPane (#2269)", () => {
  it("renders with the first kit's first component selected", () => {
    render(<ComponentLibraryPane />);
    expect(heading()).toBe("Button"); // first react-ui component
    // Every kit is a pill.
    for (const k of SEED_KITS) expect(screen.getByRole("button", { name: k.name })).toBeTruthy();
  });

  it("switching kits re-scopes the picker and selects the kit's first component", () => {
    render(<ComponentLibraryPane />);
    fireEvent.click(screen.getByRole("button", { name: "spring-kotlin" }));
    expect(heading()).toBe("PersonaService");
    // A react-ui-only component is no longer in the picker.
    expect(screen.queryByText("StatusDot")).toBeNull();
  });

  it("selecting a component from the picker updates the detail", () => {
    render(<ComponentLibraryPane />);
    fireEvent.click(screen.getByText("Chip").closest("button")!);
    expect(heading()).toBe("Chip");
  });

  it("the Usage tab shows the when-to-use / when-not guidance", () => {
    render(<ComponentLibraryPane />);
    fireEvent.click(screen.getByRole("tab", { name: /usage/ }));
    expect(screen.getByText("When to use")).toBeTruthy();
    expect(screen.getByText("When not to")).toBeTruthy();
  });

  it("the Rules tab shows the component's derived lint rule (#2279)", () => {
    render(<ComponentLibraryPane />); // Button is selected first; it wraps "button"
    fireEvent.click(screen.getByRole("tab", { name: /rules/ }));
    // The derived anti-duplication rule: use <Button> not a raw <button>, with the escape hatch.
    expect(screen.getByText(/Use the kit's <Button> instead of a raw <button>/)).toBeTruthy();
    expect(screen.getByText("derived")).toBeTruthy();
  });

  it("search filters the picker to matches", () => {
    render(<ComponentLibraryPane />);
    fireEvent.change(screen.getByLabelText("Search components"), { target: { value: "field" } });
    // "Field" now appears both in the filtered picker AND in the auto-selected detail heading.
    expect(screen.getAllByText("Field").length).toBeGreaterThan(0);
    expect(screen.queryByText("StatusDot")).toBeNull();
    expect(screen.getByText("1 / 10")).toBeTruthy(); // 1 match of 10 react-ui components
  });

  it("no match shows the empty state", () => {
    render(<ComponentLibraryPane />);
    fireEvent.change(screen.getByLabelText("Search components"), { target: { value: "zzznope" } });
    expect(screen.getByText(/No match in react-ui/)).toBeTruthy();
  });

  it("generating a variant enters the generating state, then appends + selects the new variant", () => {
    vi.useFakeTimers();
    try {
      render(<ComponentLibraryPane />);
      fireEvent.change(screen.getByLabelText("New variant prompt"), { target: { value: "loading state" } });
      fireEvent.click(screen.getByRole("button", { name: /Generate/ }));
      // Immediately in the generating state.
      expect(screen.getByRole("button", { name: /generating/i })).toBeTruthy();
      // After the optimistic delay the new variant is added + selected.
      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.getByRole("button", { name: "loading-state" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => { vi.useRealTimers(); });
