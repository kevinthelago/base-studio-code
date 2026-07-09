import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { DesignStudio } from "./DesignStudio";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import { SEED_THEMES } from "./lib/themes";
import type { Kit } from "./lib/model";
import { useAppStore } from "@/store";

/** Reset the library slice to the seed before each test (the store is a singleton). */
beforeEach(() => {
  useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, kitThemes: SEED_THEMES, aiFocusedId: null });
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
    // The toolbar title was removed (#2608) — the kit switcher leads the toolbar now.
    expect(screen.queryByText("Design Studio")).toBeNull();
    for (const k of SEED_KITS) expect(screen.getAllByText(k.name).length).toBeGreaterThan(0); // toolbar kit chip
    expect(screen.getByText(/Composition graph · react-ui/)).toBeTruthy(); // graph mounts with the workspace
    // The Library/Graph toggle is gone — there is no alternate center mode.
    expect(screen.queryByText("▦ Library")).toBeNull();
    expect(screen.queryByText("⬡ Graph")).toBeNull();
    const firstReactUi = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
    expect(screen.getByText(`${firstReactUi.name}.tsx`)).toBeTruthy(); // inspector names the selection
  });

  it("the inspector carries the library detail: live preview + Overview/Source/Usage tabs", () => {
    render(<DesignStudio />);
    expect(screen.getByText("Live preview")).toBeTruthy();           // preview + its switchers
    expect(screen.getByLabelText("Theme")).toBeTruthy();             // the single Theme dropdown (#2545)
    expect(screen.getByText("⤢ fluid")).toBeTruthy();
    expect(screen.getByText("Props / API")).toBeTruthy();            // Overview is the default tab
    // The per-component generate-variants chat was removed (#2597) — the designer session drives edits.
    expect(screen.queryByLabelText("Describe a variant")).toBeNull();
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

  it("selecting a node highlights its edges + softly rings its related nodes (#2523)", () => {
    const { container } = render(<DesignStudio />);
    fireEvent.click(graphNode("Chip"));                              // Chip composes StatusDot
    expect(graphNode("Chip").className).toContain("on");             // the selection: full ring
    expect(graphNode("StatusDot").className).toContain("related");   // its dependency: soft ring
    expect(graphNode("StatusDot").className).not.toContain("on");    // .related, not the full .on
    expect(container.querySelector("g.ds-edge.on")).toBeTruthy();    // an incident edge draws accent
    // A node with no edge to Chip carries neither state.
    expect(graphNode("Grid").className).not.toMatch(/\b(on|related)\b/);
  });

  it("pulses the AI-touched node as .working, distinct from the user's selection (#2525)", () => {
    const kitComps = SEED_COMPONENTS.filter((c) => c.kitId === SEED_KITS[0].id);
    const selDefault = kitComps[0];                                  // the default selection
    const working = kitComps.find((c) => c.id !== selDefault.id)!;   // a DIFFERENT node the AI touched
    useAppStore.setState({ aiFocusedId: working.id });
    render(<DesignStudio />);
    const node = graphNode(working.name);
    expect(node.className).toMatch(/\bworking\b/);                   // the AI-focus pulse ring
    expect(node.className).not.toMatch(/\bon\b/);                    // NOT the user's selection state
  });

  it("the user's .on selection WINS over .working when the AI touches the same node (#2525 precedence)", () => {
    const selDefault = SEED_COMPONENTS.filter((c) => c.kitId === SEED_KITS[0].id)[0];
    useAppStore.setState({ aiFocusedId: selDefault.id });            // AI touches the selected node
    render(<DesignStudio />);
    const node = graphNode(selDefault.name);
    expect(node.className).toMatch(/\bon\b/);                        // selection wins visually
    expect(node.className).not.toMatch(/\bworking\b/);               // no competing pulse on it
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

  it("the ONE preview Theme switcher applies the selected theme's vars to the specimen frame (#2488)", () => {
    const { container } = render(<DesignStudio />);
    const sel = screen.getByLabelText("Theme") as HTMLSelectElement;
    // Fed by the hydrated theme collection, defaulting to the base look.
    expect(sel.value).toBe("default");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(SEED_THEMES.map((t) => t.id));
    // Dark + Light lead the list as the packaged defaults (#2545).
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["◈ Dark", "◈ Light"]),
    );
    // No overrides on the frame under `default`.
    const defaultFrame = container.querySelector('[data-kit-theme="default"]') as HTMLElement;
    expect(defaultFrame).toBeTruthy();
    expect(defaultFrame.style.getPropertyValue("--card-radius")).toBe("");
    // Switching applies the theme's semantic-token overrides to the specimen frame via ThemeScope.
    fireEvent.change(sel, { target: { value: "soft" } });
    const frame = container.querySelector('[data-kit-theme="soft"]') as HTMLElement;
    expect(frame).toBeTruthy();
    expect(frame.style.getPropertyValue("--card-radius")).toBe("14px");
  });

  it("the Theme dropdown is the ONLY theme control — the old dark/light surface toggle is gone (#2545)", () => {
    const { container } = render(<DesignStudio />);
    // The hardcoded SegmentedControl surface toggle no longer renders.
    expect(screen.queryByText("◐ dark")).toBeNull();
    expect(screen.queryByText("◑ light")).toBeNull();
    // Selecting a light-`base` theme propagates through the single control to the specimen frame —
    // the one dropdown now drives the surface (no separate toggle to keep in sync).
    const sel = screen.getByLabelText("Theme") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "light" } });
    expect(sel.value).toBe("light");
    expect(container.querySelector('[data-kit-theme="light"]')).toBeTruthy();
  });

  it("docks the designer session ALWAYS-ON in the center column, with no toggle and no generate chat (#2597)", () => {
    render(<DesignStudio />);
    // The panel is present from the first render — no ✦ Designer toggle button gates it.
    const panel = screen.getByTestId("designer-terminal");
    expect(panel).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Designer/ })).toBeNull();
    // It's docked inside the center column (below the graph), not a full-width overlay.
    expect(panel.closest(".ds-center")).toBeTruthy();
    // The per-component generate-variants chat is gone.
    expect(screen.queryByRole("button", { name: /Generate variants/ })).toBeNull();
  });

  it("the designer chat box is resizable and doesn't pin the panes (#2624)", () => {
    const { container } = render(<DesignStudio />);
    // A row-resize handle sits between the graph and the terminal.
    expect(container.querySelector(".ds-handle-h")).toBeTruthy();
    // The terminal carries an inline (drag-driven) height so the graph keeps priority.
    const panel = screen.getByTestId("designer-terminal") as HTMLElement;
    expect(panel.style.height).not.toBe("");
  });

  it("carries NO decorative motion classes — the #2344 animation pass was removed (un-animated until the design system lands)", () => {
    const { container } = render(<DesignStudio />);
    // Inspector preview + rail: no keyed enter/drill/stagger classes.
    expect(container.querySelector(".ds-preview-enter")).toBeNull();
    expect(container.querySelector(".ds-view-enter")).toBeNull();
    expect(container.querySelector(".ds-comprow-enter")).toBeNull();
    // Graph (always mounted now): composition edges carry no flowing/animation class (the #2523
    // `.ds-edge`/`.on` state hooks are static styling, not motion).
    expect(container.querySelector(".ds-edge-flow")).toBeNull();
  });

  it("the inspector shows the composes graph for a component that has dependencies", () => {
    render(<DesignStudio />);
    // EmptyState composes Button + Card — its inspector renders the "depends on" composes graph.
    fireEvent.click(railRow("EmptyState"));
    expect(screen.getByText("EmptyState.tsx")).toBeTruthy(); // selection followed
    expect(screen.getByText("depends on ↓")).toBeTruthy();   // Overview composes section
  });
});

describe("half-screen overlay drawers (#2682)", () => {
  // The setup polyfill is a no-op; install a controllable ResizeObserver so we can drive the body
  // width and exercise the narrow → overlay-drawer switch.
  const RealRO = globalThis.ResizeObserver;
  let triggers: Array<(w: number) => void>;
  beforeEach(() => {
    triggers = [];
    globalThis.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {
        triggers.push((w) => this.cb([{ contentRect: { width: w } } as ResizeObserverEntry], this));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => { globalThis.ResizeObserver = RealRO; });

  const setWidth = (w: number) => act(() => triggers.forEach((t) => t(w)));

  it("wide by default: inline columns with drag handles, no drawer toggles", () => {
    const { container } = render(<DesignStudio />);
    expect(container.querySelector(".ds-body--narrow")).toBeNull();
    expect(container.querySelectorAll(".ds-drawertoggle").length).toBe(0);
    expect(container.querySelectorAll(".ds-handle").length).toBe(2); // the two col-resize splitters
  });

  it("below the threshold: floats the panels, drops the drag handles, and adds the toolbar toggles", () => {
    const { container } = render(<DesignStudio />);
    setWidth(700);
    expect(container.querySelector(".ds-body--narrow")).toBeTruthy();
    expect(container.querySelectorAll(".ds-drawertoggle").length).toBe(2); // rail + inspector toggles
    expect(container.querySelectorAll(".ds-handle").length).toBe(0);       // col splitters removed
    // The panels start closed (no `.open`) so the graph keeps full width.
    expect(container.querySelector(".ds-rail")!.className).not.toContain("open");
    expect(container.querySelector(".ds-insp")!.className).not.toContain("open");
  });

  it("a toggle opens its drawer + a dismiss scrim; the scrim closes it", () => {
    const { container } = render(<DesignStudio />);
    setWidth(700);
    const railToggle = container.querySelector(".ds-drawertoggle") as HTMLElement;
    fireEvent.click(railToggle);
    expect(container.querySelector(".ds-rail")!.className).toContain("open");
    const scrim = container.querySelector(".ds-scrim") as HTMLElement;
    expect(scrim).toBeTruthy();
    fireEvent.click(scrim);
    expect(container.querySelector(".ds-rail")!.className).not.toContain("open");
    expect(container.querySelector(".ds-scrim")).toBeNull();
  });

  it("only one drawer is open at a time — opening the inspector closes the rail", () => {
    const { container } = render(<DesignStudio />);
    setWidth(700);
    const [railToggle, inspToggle] = [...container.querySelectorAll(".ds-drawertoggle")] as HTMLElement[];
    fireEvent.click(railToggle);
    expect(container.querySelector(".ds-rail")!.className).toContain("open");
    fireEvent.click(inspToggle);
    expect(container.querySelector(".ds-insp")!.className).toContain("open");
    expect(container.querySelector(".ds-rail")!.className).not.toContain("open");
  });

  it("returning to a wide width restores the inline layout and clears any open drawer", () => {
    const { container } = render(<DesignStudio />);
    setWidth(700);
    fireEvent.click(container.querySelector(".ds-drawertoggle") as HTMLElement); // open the rail drawer
    expect(container.querySelector(".ds-rail")!.className).toContain("open");
    setWidth(1200);
    expect(container.querySelector(".ds-body--narrow")).toBeNull();
    expect(container.querySelectorAll(".ds-drawertoggle").length).toBe(0);
    expect(container.querySelector(".ds-rail")!.className).not.toContain("open");
    expect(container.querySelectorAll(".ds-handle").length).toBe(2);
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
