import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DesignStudio } from "./DesignStudio";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { useAppStore } from "@/store";

/** Reset the library slice to the seed before each test (the store is a singleton). */
beforeEach(() => {
  useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS });
});

describe("DesignStudio (#2308)", () => {
  it("renders the toolbar, kit switcher, and the first component selected", () => {
    render(<DesignStudio />);
    expect(screen.getByText("Design Studio")).toBeTruthy();          // toolbar title
    for (const k of SEED_KITS) expect(screen.getAllByText(k.name).length).toBeGreaterThan(0); // chip + rail head
    const firstReactUi = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
    expect(screen.getByText(`${firstReactUi.name}.tsx`)).toBeTruthy(); // Library tab bar names the selection
  });

  it("selecting a component from the rail updates the Library view + inspector", () => {
    render(<DesignStudio />);
    fireEvent.click(screen.getByText("Chip").closest("button")!);
    expect(screen.getByText("Chip.tsx")).toBeTruthy();               // the selection followed
  });

  it("switching kits re-scopes the rail and selects the kit's first component", () => {
    render(<DesignStudio />);
    // The kit chip in the toolbar (first match; the rail head is the second) switches the active kit.
    fireEvent.click(screen.getAllByText("examples")[0].closest("button")!);
    const examplesFirst = SEED_COMPONENTS.find((c) => c.kitId === "examples")!;
    expect(screen.getByText(`${examplesFirst.name}.tsx`)).toBeTruthy();
  });

  it("toggles from the Library view to the composition Graph view", () => {
    render(<DesignStudio />);
    expect(screen.getByText("Live preview")).toBeTruthy();
    fireEvent.click(screen.getByText("⬡ Graph"));
    expect(screen.getByText(/Composition graph · react-ui/)).toBeTruthy();
    // Back to Library restores the preview.
    fireEvent.click(screen.getByText("▦ Library"));
    expect(screen.getByText("Live preview")).toBeTruthy();
  });

  it("shows the when-to-use / when-not guidance on the Usage tab", () => {
    render(<DesignStudio />);
    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    expect(screen.getByText("✓ When to use")).toBeTruthy();
    expect(screen.getByText("✗ When NOT to use")).toBeTruthy();
  });

  it("the generate bar is disabled until a prompt is entered", () => {
    render(<DesignStudio />);
    const gen = screen.getByRole("button", { name: /Generate variants/ }) as HTMLButtonElement;
    expect(gen.disabled).toBe(true);
    const input = screen.getByLabelText("Describe a variant");
    fireEvent.change(input, { target: { value: "a loading state" } });
    expect(gen.disabled).toBe(false);
  });

  it("applies the motion classes (#2344) — preview/rail enter in Library, edges flow in Graph", () => {
    const { container } = render(<DesignStudio />);
    // Library view: the keyed preview re-enters, the center drills in, rail rows stagger in.
    expect(container.querySelector(".ds-preview-enter")).toBeTruthy();
    expect(container.querySelector(".ds-center.ds-view-enter")).toBeTruthy();
    expect(container.querySelector(".ds-comprow-enter")).toBeTruthy();
    // Graph view: composition edges carry the flowing class.
    fireEvent.click(screen.getByText("⬡ Graph"));
    expect(container.querySelector("path.ds-edge")).toBeTruthy();
  });

  it("the inspector shows the composes graph for a component that has dependencies", () => {
    render(<DesignStudio />);
    // EmptyState composes Button + Card — its inspector renders the "depends on" composes graph.
    fireEvent.click(screen.getAllByText("EmptyState")[0].closest("button")!);
    expect(screen.getByText("EmptyState.tsx")).toBeTruthy(); // selection followed
    expect(screen.getByText("depends on ↓")).toBeTruthy();   // inspector-only composes section
  });
});
