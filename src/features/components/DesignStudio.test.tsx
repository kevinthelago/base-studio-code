import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DesignStudio } from "./DesignStudio";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { SEED_THEMES } from "./lib/themes";
import type { Kit } from "./lib/model";
import { useAppStore } from "@/store";

/** Reset the library slice to the seed before each test (the store is a singleton). */
beforeEach(() => {
  useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, kitThemes: SEED_THEMES });
});

/** The rail entry for a component (its name also renders on the graph node + inspector header). */
const railRow = (name: string) =>
  screen.getAllByText(name).map((el) => el.closest("button.ds-comprow")).find(Boolean) as HTMLElement;

/** The graph node card for a component (exact-name text match, so Chip ≠ LabelChip). */
const graphNode = (name: string) =>
  screen.getAllByText(name).map((el) => el.closest(".ds-node")).find(Boolean) as HTMLElement;

describe("DesignStudio (#2308)", () => {
  it("renders the toolbar, kit switcher, and the composition graph as the one-and-only center view (#2453)", () => {
    render(<DesignStudio />);
    expect(screen.getByText("Design Studio")).toBeTruthy();          // toolbar title
    for (const k of SEED_KITS) expect(screen.getAllByText(k.name).length).toBeGreaterThan(0); // chip + rail head
    expect(screen.getByText(/Composition graph · react-ui/)).toBeTruthy(); // graph mounts with the workspace
    // The Library/Graph toggle is gone — there is no alternate center mode.
    expect(screen.queryByText("▦ Library")).toBeNull();
    expect(screen.queryByText("⬡ Graph")).toBeNull();
    const firstReactUi = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
    expect(screen.getByText(`${firstReactUi.name}.tsx`)).toBeTruthy(); // inspector names the selection
  });

  it("the inspector carries the library detail: live preview + Overview/Source/Usage tabs + design bar", () => {
    render(<DesignStudio />);
    expect(screen.getByText("Live preview")).toBeTruthy();           // preview + its switchers
    expect(screen.getByText("◐ dark")).toBeTruthy();
    expect(screen.getByText("⤢ fluid")).toBeTruthy();
    expect(screen.getByText("Props / API")).toBeTruthy();            // Overview is the default tab
    expect(screen.getByLabelText("Describe a variant")).toBeTruthy(); // generate-variants design bar
  });

  it("selecting a component from the rail drives the inspector", () => {
    render(<DesignStudio />);
    fireEvent.click(railRow("Chip"));
    expect(screen.getByText("Chip.tsx")).toBeTruthy();               // the selection followed
  });

  it("clicking a graph node drives the inspector", () => {
    render(<DesignStudio />);
    fireEvent.click(graphNode("Chip"));
    expect(screen.getByText("Chip.tsx")).toBeTruthy();
    expect(graphNode("Chip").className).toContain("on");             // the node highlights
  });

  it("switching kits re-scopes the graph and selects the kit's first component", () => {
    render(<DesignStudio />);
    // The kit chip in the toolbar (first match; the rail head is the second) switches the active kit.
    fireEvent.click(screen.getAllByText("examples")[0].closest("button")!);
    expect(screen.getByText(/Composition graph · examples/)).toBeTruthy();
    const examplesFirst = SEED_COMPONENTS.find((c) => c.kitId === "examples")!;
    expect(screen.getByText(`${examplesFirst.name}.tsx`)).toBeTruthy();
  });

  it("the Source tab shows the component's path + source text", () => {
    render(<DesignStudio />);
    const firstReactUi = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByText(firstReactUi.src)).toBeTruthy();
  });

  it("shows the when-to-use / when-not guidance on the Usage tab", () => {
    render(<DesignStudio />);
    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    expect(screen.getByText("✓ When to use")).toBeTruthy();
    expect(screen.getByText("✗ When NOT to use")).toBeTruthy();
  });

  it("the preview kit-THEME switcher applies the selected theme's vars to the specimen frame (#2488)", () => {
    const { container } = render(<DesignStudio />);
    const sel = screen.getByLabelText("Kit theme") as HTMLSelectElement;
    // Fed by the hydrated theme collection, defaulting to the base look.
    expect(sel.value).toBe("default");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(SEED_THEMES.map((t) => t.id));
    // No overrides on the frame under `default`.
    const defaultFrame = container.querySelector('[data-kit-theme="default"]') as HTMLElement;
    expect(defaultFrame).toBeTruthy();
    expect(defaultFrame.style.getPropertyValue("--card-radius")).toBe("");
    // Switching applies the theme's semantic-token overrides to the specimen frame via ThemeScope.
    fireEvent.change(sel, { target: { value: "soft" } });
    const frame = container.querySelector('[data-kit-theme="soft"]') as HTMLElement;
    expect(frame).toBeTruthy();
    expect(frame.style.getPropertyValue("--card-radius")).toBe("14px");
    // The dark/light SURFACE toggle is a separate, composing axis — it stays.
    expect(screen.getByText("◐ dark")).toBeTruthy();
  });

  it("the generate bar is disabled until a prompt is entered", () => {
    render(<DesignStudio />);
    const gen = screen.getByRole("button", { name: /Generate variants/ }) as HTMLButtonElement;
    expect(gen.disabled).toBe(true);
    const input = screen.getByLabelText("Describe a variant");
    fireEvent.change(input, { target: { value: "a loading state" } });
    expect(gen.disabled).toBe(false);
  });

  it("carries NO decorative motion classes — the #2344 animation pass was removed (un-animated until the design system lands)", () => {
    const { container } = render(<DesignStudio />);
    // Inspector preview + rail: no keyed enter/drill/stagger classes.
    expect(container.querySelector(".ds-preview-enter")).toBeNull();
    expect(container.querySelector(".ds-view-enter")).toBeNull();
    expect(container.querySelector(".ds-comprow-enter")).toBeNull();
    // Graph (always mounted now): composition edges are plain (no flowing class).
    expect(container.querySelector("path.ds-edge")).toBeNull();
  });

  it("the inspector shows the composes graph for a component that has dependencies", () => {
    render(<DesignStudio />);
    // EmptyState composes Button + Card — its inspector renders the "depends on" composes graph.
    fireEvent.click(railRow("EmptyState"));
    expect(screen.getByText("EmptyState.tsx")).toBeTruthy(); // selection followed
    expect(screen.getByText("depends on ↓")).toBeTruthy();   // Overview composes section
  });
});

describe("rail hierarchy (#2487) — tech → visual language → kit, with auto-flatten", () => {
  /** A structurally different kit on another technology — makes the tech level non-trivial. */
  const vueKit: Kit = {
    id: "vue-kit", name: "vue-kit", tech: "vue", style: "material", stack: "Vue · TypeScript", dot: "var(--accent)",
  };

  it("with the packaged single-tech library the rail stays EXACTLY as flat as before — zero group headers", () => {
    const { container } = render(<DesignStudio />);
    expect(container.querySelector(".ds-grouphead")).toBeNull();
    expect(container.querySelectorAll(".ds-kithead").length).toBe(SEED_KITS.length);
  });

  it("a genuinely multi-tech library nests collapsible tech groups above the kit heads", () => {
    useAppStore.setState({ kits: [...SEED_KITS, vueKit] });
    const { container } = render(<DesignStudio />);
    const heads = [...container.querySelectorAll(".ds-grouphead")];
    expect(heads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react"), expect.stringContaining("vue"),
    ]);
    // Groups default OPEN — every kit head is visible beneath its tech header.
    expect(container.querySelectorAll(".ds-kithead").length).toBe(SEED_KITS.length + 1);
    expect(heads[0].getAttribute("aria-expanded")).toBe("true");
  });

  it("collapsing a tech group hides its kits (and their components); re-expanding restores them", () => {
    useAppStore.setState({ kits: [...SEED_KITS, vueKit] });
    const { container } = render(<DesignStudio />);
    const reactHead = container.querySelector(".ds-grouphead") as HTMLElement;
    fireEvent.click(reactHead); // collapse the react group — only the vue kit head remains
    expect(reactHead.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".ds-kithead").length).toBe(1);
    fireEvent.click(reactHead); // …and back
    expect(container.querySelectorAll(".ds-kithead").length).toBe(SEED_KITS.length + 1);
  });

  it("a kit under a group is still fully driveable — selecting its component follows in the inspector", () => {
    useAppStore.setState({ kits: [...SEED_KITS, vueKit] });
    render(<DesignStudio />);
    fireEvent.click(railRow("Chip"));
    expect(screen.getByText("Chip.tsx")).toBeTruthy();
  });

  it("kits missing tech/style group gracefully (an 'other' bucket) — the rail never crashes", () => {
    const bare: Kit = { id: "bare", name: "bare-kit", stack: "?", dot: "var(--accent)" };
    useAppStore.setState({ kits: [...SEED_KITS, bare] });
    const { container } = render(<DesignStudio />);
    // react (the two packaged kits) + the trailing missing-field bucket.
    const heads = [...container.querySelectorAll(".ds-grouphead")];
    expect(heads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react"), expect.stringContaining("other"),
    ]);
    expect(container.querySelectorAll(".ds-kithead").length).toBe(SEED_KITS.length + 1);
  });
});
