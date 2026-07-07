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
    for (const k of SEED_KITS) expect(screen.getAllByText(k.name).length).toBeGreaterThan(0); // toolbar kit chip
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
    // The packaged seed is the one react-ui kit (#2506 retired the examples kit), so switching is
    // exercised against a second, user-authored kit in the store.
    const vueKit: Kit = { id: "vue-kit", name: "vue-kit", tech: "vue", style: "material", stack: "Vue · TypeScript", dot: "var(--accent)" };
    const vueComp = { ...SEED_COMPONENTS[0], id: "vue-button", name: "VueButton", kitId: "vue-kit" };
    useAppStore.setState({ kits: [...SEED_KITS, vueKit], components: [...SEED_COMPONENTS, vueComp] });
    render(<DesignStudio />);
    // The kit chip in the toolbar switches the active kit.
    fireEvent.click(screen.getAllByText("vue-kit")[0].closest("button")!);
    expect(screen.getByText(/Composition graph · vue-kit/)).toBeTruthy();
    expect(screen.getByText("VueButton.tsx")).toBeTruthy();
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

describe("rail hierarchy (#2506) — ALWAYS technology → style; a single-kit style header IS the kit", () => {
  /** A structurally different kit on another technology. */
  const vueKit: Kit = {
    id: "vue-kit", name: "vue-kit", tech: "vue", style: "material", stack: "Vue · TypeScript", dot: "var(--accent)",
  };

  it("the packaged single-kit library renders grouped at BOTH levels: react (tech) → studio (the kit) → components", () => {
    const { container } = render(<DesignStudio />);
    // Level 1 — the technology group header (no #2487 auto-flatten anymore).
    const heads = [...container.querySelectorAll(".ds-grouphead")];
    expect(heads.map((h) => h.textContent)).toEqual([expect.stringContaining("react")]);
    expect(heads[0].getAttribute("aria-expanded")).toBe("true"); // default OPEN
    // Level 2 — the style header IS the one kit under it: labelled with the STYLE, not the kit name,
    // and there is no redundant kit row beneath it.
    const kitHeads = [...container.querySelectorAll(".ds-kithead")];
    expect(kitHeads.length).toBe(1);
    expect(kitHeads[0].textContent).toContain("studio");
    expect(kitHeads[0].textContent).not.toContain("react-ui");
    // The components list directly under the style header (the kit defaults open).
    expect(railRow("Chip")).toBeTruthy();
  });

  it("a multi-tech library nests one collapsible tech group per technology, each style header a kit", () => {
    useAppStore.setState({ kits: [...SEED_KITS, vueKit] });
    const { container } = render(<DesignStudio />);
    const heads = [...container.querySelectorAll(".ds-grouphead")];
    expect(heads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react"), expect.stringContaining("vue"),
    ]);
    // Groups default OPEN — each kit's merged style header is visible beneath its tech header.
    const kitHeads = [...container.querySelectorAll(".ds-kithead")];
    expect(kitHeads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("studio"), expect.stringContaining("material"),
    ]);
  });

  it("collapsing a tech group hides its kits (and their components); re-expanding restores them", () => {
    useAppStore.setState({ kits: [...SEED_KITS, vueKit] });
    const { container } = render(<DesignStudio />);
    const reactHead = container.querySelector(".ds-grouphead") as HTMLElement;
    fireEvent.click(reactHead); // collapse the react group — only the vue style/kit head remains
    expect(reactHead.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".ds-kithead").length).toBe(1);
    fireEvent.click(reactHead); // …and back
    expect(container.querySelectorAll(".ds-kithead").length).toBe(SEED_KITS.length + 1);
  });

  it("a component under the grouped rail is still fully driveable — selecting it follows in the inspector", () => {
    useAppStore.setState({ kits: [...SEED_KITS, vueKit] });
    render(<DesignStudio />);
    fireEvent.click(railRow("Chip"));
    expect(screen.getByText("Chip.tsx")).toBeTruthy();
  });

  it("search still filters the component rows under the grouped rail", () => {
    render(<DesignStudio />);
    fireEvent.change(screen.getByLabelText("Search components"), { target: { value: "chip" } });
    expect(railRow("Chip")).toBeTruthy();
    expect(screen.queryAllByText("Box").map((el) => el.closest("button.ds-comprow")).find(Boolean)).toBeUndefined();
  });

  it("kits missing tech/style group gracefully (a trailing 'other' bucket) — the rail never crashes", () => {
    const bare: Kit = { id: "bare", name: "bare-kit", stack: "?", dot: "var(--accent)" };
    useAppStore.setState({ kits: [...SEED_KITS, bare] });
    const { container } = render(<DesignStudio />);
    // react + the trailing missing-field tech bucket; the bare kit merges into its "other" style head.
    const heads = [...container.querySelectorAll(".ds-grouphead")];
    expect(heads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react"), expect.stringContaining("other"),
    ]);
    expect(container.querySelectorAll(".ds-kithead").length).toBe(SEED_KITS.length + 1);
  });

  it("SEVERAL kits sharing one (tech, style) still nest kit rows beneath the style group", () => {
    const twin: Kit = { id: "react-ui-2", name: "react-ui-2", tech: "react", style: "studio", stack: "React", dot: "var(--accent)" };
    useAppStore.setState({ kits: [...SEED_KITS, twin] });
    const { container } = render(<DesignStudio />);
    // tech header + style header + two real kit heads (named by KIT, the style header stays a group).
    expect([...container.querySelectorAll(".ds-grouphead")].map((h) => h.textContent)).toEqual([
      expect.stringContaining("react"), expect.stringContaining("studio"),
    ]);
    const kitHeads = [...container.querySelectorAll(".ds-kithead")];
    expect(kitHeads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react-ui"), expect.stringContaining("react-ui-2"),
    ]);
  });
});
