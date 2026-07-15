import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { DesignsWorkbench } from "./DesignsWorkbench";

// The live preview builds with esbuild-wasm (can't run under jsdom); mock the bundler so the workbench
// tests exercise the chrome without loading the wasm runtime (#2824).
vi.mock("@/shared/lib/preview/componentBundle", () => ({
  bundleComponent: vi.fn().mockResolvedValue("/*bundle*/"),
  buildComponentSrcDoc: (js: string) => `<!doctype html><html><body>${js}</body></html>`,
  COMPONENT_IMPORTMAP: { react: "https://esm.sh/react" },
  COMPONENT_EXTERNALS: ["react"],
}));
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

describe("DesignsWorkbench (#2308)", () => {
  it("renders the kits→components rail and the composition graph as the one-and-only center view (#2453)", () => {
    const { container } = render(<DesignsWorkbench />);
    // The page toolbar was removed (#move-to-planner) — the studio is a Planner tab, so the PageTabs
    // strip is its header. No "Design Studio" heading, no kit-switcher chip row.
    expect(screen.queryByText("Design Studio")).toBeNull();
    // The kit is named in the graph header; the rail is now HEADERLESS (#2797) and leads with a search
    // box (the label bar was dropped — the PageTabs strip already titles the studio).
    expect(screen.getByText(/Composition graph · react-ui/)).toBeTruthy(); // graph mounts with the page
    expect(screen.getByLabelText("Search components")).toBeTruthy();       // the rail's search box leads it
    expect(screen.queryByText(/Kits.*Components/)).toBeNull();             // no label header anymore
    // The Library/Graph toggle is gone — there is no alternate center mode.
    expect(screen.queryByText("▦ Library")).toBeNull();
    expect(screen.queryByText("⬡ Graph")).toBeNull();
    // Nothing is focused on mount → the Inspector is HIDDEN, the graph is full-width (#3090).
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeNull();
    expect(screen.queryByText("Live preview")).toBeNull();          // no live preview until one is focused
  });

  it("ALWAYS renders the graph even with NO kits (empty library, #3033) — never a blocking empty-state page", () => {
    useAppStore.setState({ components: [], kits: [] }); // an empty library (e.g. right after the default kit is cleared)
    const { container } = render(<DesignsWorkbench />);
    // The composition-graph shell still mounts (no kit-name suffix) with its rail search — the studio never
    // hides behind a StudioEmpty page (which would hide the designer terminal you need to BUILD the kit). The
    // Inspector is hidden (nothing to focus in an empty library, #3090).
    expect(screen.getByText("Composition graph")).toBeTruthy();
    expect(screen.getByLabelText("Search components")).toBeTruthy();
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeNull();
  });

  it("the inspector carries the library detail: live preview + Overview/Source/Usage tabs", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));                              // focus a node to reveal the details pane
    expect(screen.getByText("Live preview")).toBeTruthy();           // preview + its switchers
    expect(screen.getByLabelText("Theme")).toBeTruthy();             // the single Theme dropdown (#2545)
    expect(screen.getByText("⤢ fluid")).toBeTruthy();
    expect(screen.getByText("Props / API")).toBeTruthy();            // Overview is the default tab
    // The per-component generate-variants chat was removed (#2597) — the designer session drives edits.
    expect(screen.queryByLabelText("Describe a variant")).toBeNull();
  });

  it("selecting a component from the rail drives the inspector", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(railRow("Chip"));
    expect(screen.getByText("Chip.tsx")).toBeTruthy();               // the selection followed
  });

  it("clicking a graph node drives the inspector", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    expect(screen.getByText("Chip.tsx")).toBeTruthy();
    expect(graphNode("Chip").className).toContain("on");             // the node highlights
  });

  it("selecting a node highlights its edges + softly rings its related nodes (#2523)", () => {
    const { container } = render(<DesignsWorkbench />);
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
    render(<DesignsWorkbench />);
    const node = graphNode(working.name);
    expect(node.className).toMatch(/\bworking\b/);                   // the AI-focus pulse ring
    expect(node.className).not.toMatch(/\bon\b/);                    // NOT the user's selection state
  });

  it("the user's .on selection WINS over .working when the AI touches the same node (#2525 precedence)", () => {
    const selDefault = SEED_COMPONENTS.filter((c) => c.kitId === SEED_KITS[0].id)[0];
    useAppStore.setState({ aiFocusedId: selDefault.id });            // AI touches a node…
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode(selDefault.name));                     // …and the user focuses that SAME node
    const node = graphNode(selDefault.name);
    expect(node.className).toMatch(/\bon\b/);                        // selection wins visually
    expect(node.className).not.toMatch(/\bworking\b/);               // no competing pulse on it
  });

  it("switching kits via the rail kit head re-scopes the graph and focuses nothing (details stay hidden)", () => {
    // The packaged seed is the one react-ui kit (#2506 retired the examples kit), so switching is
    // exercised against a second, user-authored kit in the store.
    const vueKit: Kit = { id: "vue-kit", name: "vue-kit", tech: "vue", style: "material", stack: "Vue · TypeScript", dot: "var(--accent)" };
    const vueComp = { ...SEED_COMPONENTS[0], id: "vue-button", name: "VueButton", kitId: "vue-kit" };
    useAppStore.setState({ kits: [...SEED_KITS, vueKit], components: [...SEED_COMPONENTS, vueComp] });
    const { container } = render(<DesignsWorkbench />);
    // The toolbar switcher is gone (#move-to-planner) — clicking a rail kit head activates that kit. The
    // vue kit's head is labelled with its style ("material") under the single-kit style merge (#2506).
    fireEvent.click(screen.getByText("material").closest("button.ds-kithead")!);
    expect(screen.getByText(/Composition graph · vue-kit/)).toBeTruthy();
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeNull();  // switching focuses nothing → hidden (#3090)
    // …then picking a component from the new kit reveals its details.
    fireEvent.click(railRow("VueButton"));
    expect(screen.getByText("VueButton.tsx")).toBeTruthy();
  });

  it("the Source tab shows the component's path + source text", () => {
    render(<DesignsWorkbench />);
    const firstReactUi = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
    fireEvent.click(graphNode(firstReactUi.name));                   // focus it to reveal the details pane
    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByText(firstReactUi.src)).toBeTruthy();
  });

  it("shows the when-to-use / when-not guidance on the Usage tab", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));                              // focus a node to reveal the details pane
    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    expect(screen.getByText("✓ When to use")).toBeTruthy();
    expect(screen.getByText("✗ When NOT to use")).toBeTruthy();
  });

  it("the ONE preview Theme switcher lists the hydrated collection and drives the preview (#2488/#2824)", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));                              // focus a node to reveal the details pane
    const sel = screen.getByLabelText("Theme") as HTMLSelectElement;
    // Fed by the hydrated theme collection, defaulting to the base look.
    expect(sel.value).toBe("default");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(SEED_THEMES.map((t) => t.id));
    // Dark + Light lead the list as the packaged defaults (#2545).
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["◈ Dark", "◈ Light"]),
    );
    // Switching the theme drives the preview: the retint is now the theme's `vars` INJECTED into the
    // build-and-iframe surface (#2824), so there is no ThemeScope frame in the parent DOM to inspect —
    // the observable here is the single control updating.
    fireEvent.change(sel, { target: { value: "nord" } });
    expect(sel.value).toBe("nord");
  });

  it("the Theme dropdown is the ONLY theme control — the old dark/light surface toggle is gone (#2545)", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));                              // focus a node to reveal the details pane
    // The hardcoded SegmentedControl surface toggle no longer renders.
    expect(screen.queryByText("◐ dark")).toBeNull();
    expect(screen.queryByText("◑ light")).toBeNull();
    // Selecting a light-`base` theme drives the surface through the single control (no separate toggle).
    const sel = screen.getByLabelText("Theme") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "light" } });
    expect(sel.value).toBe("light");
  });

  it("docks the designer session ALWAYS-ON in the center column, with no toggle and no generate chat (#2597)", () => {
    render(<DesignsWorkbench />);
    // The panel is present from the first render — no ✦ Designer toggle button gates it.
    const panel = screen.getByTestId("designer-terminal");
    expect(panel).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Designer/ })).toBeNull();
    // It's docked inside the center column (below the graph), not a full-width overlay.
    expect(panel.closest(".ds-graph")).toBeTruthy();
    // The per-component generate-variants chat is gone.
    expect(screen.queryByRole("button", { name: /Generate variants/ })).toBeNull();
  });

  it("the designer chat box is resizable and doesn't pin the panes (#2624)", () => {
    const { container } = render(<DesignsWorkbench />);
    // A row-resize handle sits between the graph and the terminal.
    expect(container.querySelector(".resize-y")).toBeTruthy();
    // The terminal carries an inline (drag-driven) height so the graph keeps priority.
    const panel = screen.getByTestId("designer-terminal") as HTMLElement;
    expect(panel.style.height).not.toBe("");
  });

  it("carries NO decorative motion classes — the #2344 animation pass was removed (un-animated until the design system lands)", () => {
    const { container } = render(<DesignsWorkbench />);
    // Inspector preview + rail: no keyed enter/drill/stagger classes.
    expect(container.querySelector(".ds-preview-enter")).toBeNull();
    expect(container.querySelector(".ds-view-enter")).toBeNull();
    expect(container.querySelector(".ds-comprow-enter")).toBeNull();
    // Graph (always mounted now): composition edges carry no flowing/animation class (the #2523
    // `.ds-edge`/`.on` state hooks are static styling, not motion).
    expect(container.querySelector(".ds-edge-flow")).toBeNull();
  });

  it("the inspector shows the composes graph for a component that has dependencies", () => {
    render(<DesignsWorkbench />);
    // EmptyState composes Button + Card — its inspector renders the "depends on" composes graph.
    fireEvent.click(railRow("EmptyState"));
    expect(screen.getByText("EmptyState.tsx")).toBeTruthy(); // selection followed
    expect(screen.getByText("depends on ↓")).toBeTruthy();   // Overview composes section
  });
});

describe("selection-driven inspector visibility (#3090, restoring #2705) — visible when focused or AI-worked", () => {
  /** The pan/zoom canvas viewport (the element that fires onBackgroundClick). */
  const canvas = (c: HTMLElement) => c.querySelector('div[style*="cursor: grab"]') as HTMLElement;

  it("hidden on mount — no Inspector, the graph is full-width (only the rail splitter, #3090)", () => {
    const { container } = render(<DesignsWorkbench />);
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeNull();
    expect(screen.queryByText("Live preview")).toBeNull();          // no preview until a component is focused
    // No inspector ⇒ only the rail's resize splitter is present (not the inspector's) — the half-screen win.
    expect(container.querySelectorAll(".resize-x").length).toBe(1);
  });

  it("focusing a graph node reveals the Inspector", () => {
    const { container } = render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeTruthy();
    expect(screen.getByText("Chip.tsx")).toBeTruthy();
    expect(graphNode("Chip").className).toContain("on");
    expect(container.querySelectorAll(".resize-x").length).toBe(2); // rail + inspector splitters
  });

  it("focusing a component from the rail also reveals the Inspector", () => {
    const { container } = render(<DesignsWorkbench />);
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeNull(); // hidden first
    fireEvent.click(railRow("Chip"));
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeTruthy();
    expect(screen.getByText("Chip.tsx")).toBeTruthy();
  });

  it("clicking the canvas background unfocuses the node → the Inspector HIDES, graph full-width again", () => {
    const { container } = render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));                              // focus → revealed
    expect(screen.getByText("Chip.tsx")).toBeTruthy();
    fireEvent.click(canvas(container));                              // click the empty canvas → unfocus
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeNull();           // pane GONE (#3090)
    expect(screen.queryByText("Chip.tsx")).toBeNull();
    expect(graphNode("Chip").className).not.toContain("on");         // node no longer selected
    expect(container.querySelectorAll(".resize-x").length).toBe(1); // only the rail splitter remains
  });

  it("a node being worked on by Claude reveals the Inspector even with NO user selection (#3090)", () => {
    const working = SEED_COMPONENTS.filter((c) => c.kitId === SEED_KITS[0].id)[0];
    useAppStore.setState({ aiFocusedId: working.id });               // Claude is working a node…
    const { container } = render(<DesignsWorkbench />);
    // …so the details pane is visible and shows Claude's node, though nothing was clicked.
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeTruthy();
    expect(screen.getByText(`${working.name}.tsx`)).toBeTruthy();
    // The graph marks it with the AI `.working` pulse, NOT the user's `.on` ring (the signals stay separate).
    expect(graphNode(working.name).className).toMatch(/\bworking\b/);
    expect(graphNode(working.name).className).not.toMatch(/\bon\b/);
  });

  it("clicking the canvas background DISMISSES Claude's active node so the pane can be closed (#3109)", () => {
    const working = SEED_COMPONENTS.filter((c) => c.kitId === SEED_KITS[0].id)[0];
    useAppStore.setState({ aiFocusedId: working.id });               // Claude's node auto-opens the pane…
    const { container } = render(<DesignsWorkbench />);
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeTruthy();
    fireEvent.click(canvas(container));                              // …and clicking the canvas unfocuses it
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeNull(); // dismissed → hidden (#3109)
    expect(screen.queryByText(`${working.name}.tsx`)).toBeNull();
  });

  it("after a dismissal, a DIFFERENT node Claude moves to re-opens the inspector (#3109)", () => {
    const kitComps = SEED_COMPONENTS.filter((c) => c.kitId === SEED_KITS[0].id);
    const first = kitComps[0], second = kitComps.find((c) => c.id !== first.id)!;
    useAppStore.setState({ aiFocusedId: first.id });
    const { container } = render(<DesignsWorkbench />);
    fireEvent.click(canvas(container));                             // dismiss `first`
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeNull();
    act(() => { useAppStore.setState({ aiFocusedId: second.id }); }); // Claude moves to a different node
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeTruthy(); // re-opens — dismissal was per-node
    expect(screen.getByText(`${second.name}.tsx`)).toBeTruthy();
  });

  it("a user selection takes the Inspector even while Claude works a different node", () => {
    const kitComps = SEED_COMPONENTS.filter((c) => c.kitId === SEED_KITS[0].id);
    const aiNode = kitComps.find((c) => c.name !== "Chip")!;         // Claude works some OTHER node
    useAppStore.setState({ aiFocusedId: aiNode.id });
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));                             // the user picks Chip
    expect(screen.getByText("Chip.tsx")).toBeTruthy();             // the user's pick wins in the Inspector
    expect(screen.queryByText(`${aiNode.name}.tsx`)).toBeNull();
  });
});

describe("rail hierarchy (#2506) — ALWAYS technology → style; a single-kit style header IS the kit", () => {
  /** A structurally different kit on another technology. */
  const vueKit: Kit = {
    id: "vue-kit", name: "vue-kit", tech: "vue", style: "material", stack: "Vue · TypeScript", dot: "var(--accent)",
  };

  it("the packaged single-kit library renders grouped at BOTH levels: react (tech) → studio (the kit) → components", () => {
    const { container } = render(<DesignsWorkbench />);
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
    const { container } = render(<DesignsWorkbench />);
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
    const { container } = render(<DesignsWorkbench />);
    const reactHead = container.querySelector(".ds-grouphead") as HTMLElement;
    fireEvent.click(reactHead); // collapse the react group — only the vue style/kit head remains
    expect(reactHead.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".ds-kithead").length).toBe(1);
    fireEvent.click(reactHead); // …and back
    expect(container.querySelectorAll(".ds-kithead").length).toBe(SEED_KITS.length + 1);
  });

  it("a component under the grouped rail is still fully driveable — selecting it follows in the inspector", () => {
    useAppStore.setState({ kits: [...SEED_KITS, vueKit] });
    render(<DesignsWorkbench />);
    fireEvent.click(railRow("Chip"));
    expect(screen.getByText("Chip.tsx")).toBeTruthy();
  });

  it("search still filters the component rows under the grouped rail", () => {
    render(<DesignsWorkbench />);
    fireEvent.change(screen.getByLabelText("Search components"), { target: { value: "chip" } });
    expect(railRow("Chip")).toBeTruthy();
    expect(screen.queryAllByText("Box").map((el) => el.closest("button.ds-comprow")).find(Boolean)).toBeUndefined();
  });

  it("kits missing tech/style group gracefully (a trailing 'other' bucket) — the rail never crashes", () => {
    const bare: Kit = { id: "bare", name: "bare-kit", stack: "?", dot: "var(--accent)" };
    useAppStore.setState({ kits: [...SEED_KITS, bare] });
    const { container } = render(<DesignsWorkbench />);
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
    const { container } = render(<DesignsWorkbench />);
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

describe("theme try-on preview (#2834)", () => {
  it("no expand affordance until a component is selected (the inspector is hidden until a selection)", () => {
    render(<DesignsWorkbench />);
    expect(screen.queryByRole("button", { name: /Expand .*preview/ })).toBeNull();
  });

  it("the selected component's preview thumbnail is a clickable expand affordance", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));                              // focus reveals the inspector preview
    // The thumbnail is a button, labelled so it reads as clickable (the hover cue is CSS on top).
    expect(screen.getByRole("button", { name: /Expand Chip preview/ })).toBeTruthy();
  });

  it("clicking the thumbnail opens the in-place theme preview over the graph; Back to graph closes it", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    expect(screen.queryByText("Theme preview")).toBeNull();          // not expanded yet
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    expect(screen.getByText("Theme preview")).toBeTruthy();          // the expanded surface mounted…
    expect(screen.getByRole("button", { name: /Back to graph/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back to graph/ }));
    expect(screen.queryByText("Theme preview")).toBeNull();          // …and collapses back to the graph
  });

  it("preview mode swaps the right pane to the grouped themes menu; the left rail still lists components", () => {
    const { container } = render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    // Right pane = the themes menu: a theme row that exists ONLY there (Nord is a packaged theme, never
    // a component/kit name), grouped by design group (#2749 → the .tm-grouphead header).
    expect(screen.getByRole("button", { name: /Nord/ })).toBeTruthy();
    expect(container.querySelector(".tm-grouphead")).toBeTruthy();
    // The left rail is untouched — components stay navigable while trying themes on.
    expect(railRow("Chip")).toBeTruthy();
  });

  it("selecting a theme in the menu makes it the applied theme (drives the preview retint)", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    const nord = screen.getByRole("button", { name: /Nord/ });
    expect(nord.className).not.toContain("on");                      // default is applied, not Nord
    fireEvent.click(nord);
    expect(nord.className).toContain("on");                          // Nord is now the applied theme
  });

  it("leaving preview mode restores the per-component inspector (the themes menu is gone)", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    expect(screen.getByRole("button", { name: /Nord/ })).toBeTruthy();   // menu present
    fireEvent.click(screen.getByRole("button", { name: /Back to graph/ }));
    expect(screen.queryByRole("button", { name: /Nord/ })).toBeNull();   // menu gone
    expect(screen.getByText("Live preview")).toBeTruthy();               // inspector restored
  });

  it("the expanded center carries the theme's palette strip alongside the preview (#2834)", () => {
    const { container } = render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    expect(container.querySelector(".ds-palette")).toBeNull();           // not before expanding
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    // The palette strip mounts with the expanded preview: the grouped semantic swatches.
    expect(container.querySelector(".ds-palette")).toBeTruthy();
    expect(container.querySelectorAll(".ds-swatch").length).toBe(14);
    expect(screen.getByText("Surfaces")).toBeTruthy();
    expect(screen.getByText("Accent")).toBeTruthy();
  });

  it("preview mode carries the variant + viewport toolbar over the expanded preview (#2834)", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));                                  // Chip has 5 variants
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    // The viewport switcher moved into the center toolbar (the inspector — its other home — is hidden).
    expect(screen.getByText("⤢ fluid")).toBeTruthy();
    expect(screen.getByText("sm")).toBeTruthy();
    // The variant switcher shows for a multi-variant component (Chip: neutral/accent/…).
    expect(screen.getByText("neutral")).toBeTruthy();
  });

  it("the center viewport switcher resizes the preview (#2834)", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    const frame = () => screen.getByTitle("Chip preview").parentElement as HTMLElement;
    expect(frame().style.width).toBe("100%");                            // default fluid
    fireEvent.click(screen.getByText("sm"));
    expect(frame().style.width).toBe("380px");                           // resized to the sm breakpoint
  });

  it("preview mode hides the graph chrome (the composition-graph toolbar); it returns on exit (#2849)", () => {
    render(<DesignsWorkbench />);
    expect(screen.getByText(/Composition graph/)).toBeTruthy();          // graph header shown normally
    fireEvent.click(graphNode("Chip"));
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    expect(screen.queryByText(/Composition graph/)).toBeNull();          // hidden while previewing
    fireEvent.click(screen.getByRole("button", { name: /Back to graph/ }));
    expect(screen.getByText(/Composition graph/)).toBeTruthy();          // restored on exit
  });
});
