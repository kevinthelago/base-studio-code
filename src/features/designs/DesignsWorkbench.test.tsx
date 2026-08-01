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
import { REACT_UI_KIT, REACT_UI_COMPONENTS } from "./lib/reactUiKit";
import { SEED_THEMES } from "./lib/themes";
import type { Kit } from "./lib/model";
import { useAppStore } from "@/store";

// #3543: the packaged seed is now a single EMPTY kit (`base-studio-code`, filled by the designer). These
// workbench tests drive the react-ui LIBRARY (the manifest-generated assembler — the exact populated kit
// the seed used to carry) as their fixture, so the rail/graph/inspector have real components to render.
// (The multi-kit "rail hierarchy" describe below builds its OWN synthetic multi-kit fixture.)
const SEED_COMPONENTS = REACT_UI_COMPONENTS;
const SEED_KITS = [REACT_UI_KIT];

/** Reset the library slice to the seed before each test (the store is a singleton). #3274 lifted the
 *  kit + component SELECTION out of DesignsWorkbench's local state into the store, so it is now part of
 *  that singleton and must be reset here too — otherwise a selection from one test bleeds into the next
 *  (the "hidden on mount" cases in particular assume nothing is focused). */
beforeEach(() => {
  useAppStore.setState({
    components: SEED_COMPONENTS,
    kits: SEED_KITS,
    kitThemes: SEED_THEMES,
    aiFocusedId: null,
    designsKitId: "",
    designsCompId: null,
    // The studio must be the VISIBLE page (#3627): `scanVisible` gates the rail, the component
    // scan and the activity poll on it, so a hidden Studio does no background work. Without this
    // the workbench renders the graph but no rail — and every rail-driven assertion below fails.
    // (`DesignsWorkbench.visibility.test.tsx` owns the hidden-page cases.)
    activeWorkspace: "projects",
    projectsPageMode: "designs",
  });
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
    // #3852: the graph header no longer repeats the studio's name or its kit — the PageTabs strip titles
    // the studio and the rail names the kit. Its leading slot is the LOOP banner; `fit` is the header
    // control that proves the row mounted at all.
    expect(screen.getByRole("button", { name: "Auto-improve" })).toBeTruthy(); // the header's leading slot
    expect(screen.getByRole("button", { name: "fit" })).toBeTruthy();          // …and the graph chrome
    expect(screen.queryByText(/Composition graph/)).toBeNull();                // the eyebrow is gone
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
    expect(screen.getByRole("button", { name: "fit" })).toBeTruthy(); // the graph shell still mounts
    expect(screen.getByLabelText("Search components")).toBeTruthy();
    expect(container.querySelector('[data-testid="ds-inspector"]')).toBeNull();
  });

  it("the inspector carries the library detail: live preview + Overview/Source/Usage tabs", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));                              // focus a node to reveal the details pane
    expect(screen.getByTitle("Chip preview")).toBeTruthy();          // the live-preview iframe leads the pane
    expect(screen.getByLabelText("Theme")).toBeTruthy();             // the single Theme dropdown (#2545)
    // #3190: the preview leads the inspector with NO control bar — the "Live preview" title, the data-state
    // (loaded/empty/loading) buttons, and the variant + screen-size (sm/md/fluid) toggles are all gone.
    expect(screen.queryByText("Live preview")).toBeNull();
    expect(screen.queryByText("loaded")).toBeNull();
    expect(screen.queryByText("⤢ fluid")).toBeNull();
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
    // #3852: the header no longer names the kit, so assert the thing that actually matters — the graph is
    // re-scoped to the new kit's components (its node is present, the old kit's are not).
    expect(graphNode("VueButton")).toBeTruthy();
    expect(graphNode("Chip")).toBeFalsy(); // scoped to graph NODES — "Chip" still lists in the rail tree
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

  describe("the Tests tab (#3884)", () => {
    /** Focus `name` and open its Tests tab. */
    function openTests(name: string) {
      render(<DesignsWorkbench />);
      fireEvent.click(graphNode(name));
      fireEvent.click(screen.getByRole("tab", { name: /^Tests/ }));
    }

    it("lists each test the node carries — name + source", () => {
      const target = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
      useAppStore.setState({
        components: SEED_COMPONENTS.map((c) => c.id === target.id
          ? { ...c, tests: [{ name: "calls onSelect with the clicked row", src: "it('fires', () => { expectSomething(); });" }] }
          : c),
      });
      openTests(target.name);
      expect(screen.getByText("calls onSelect with the clicked row")).toBeTruthy();
      expect(screen.getByText(/expectSomething/)).toBeTruthy();
    });

    it("reads an untested INTERACTIVE node as the `no-tests` gap it is, naming its action props", () => {
      // The empty state must agree with the doctor: an action prop makes the node interactive, which is
      // exactly what `no-tests` flags. Give the node one and assert the tab says so.
      const target = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
      useAppStore.setState({
        components: SEED_COMPONENTS.map((c) => c.id === target.id
          ? { ...c, tests: [], props: [{ name: "onPick", type: "(id: string) => void", req: false, desc: "" }] }
          : c),
      });
      openTests(target.name);
      expect(screen.getByText(/no-tests/)).toBeTruthy();
      expect(screen.getByText(/onPick/)).toBeTruthy();
    });

    it("stays quiet for a DISPLAY-ONLY node — no action prop, so the check does not fire", () => {
      const target = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
      useAppStore.setState({
        components: SEED_COMPONENTS.map((c) => c.id === target.id
          ? { ...c, tests: [], props: [{ name: "label", type: "string", req: true, desc: "" }] }
          : c),
      });
      openTests(target.name);
      // It still NAMES the check (so the reader knows which one is silent) — what must not appear is the
      // gap verdict the interactive case carries.
      expect(screen.getByText(/stays silent/)).toBeTruthy();
      expect(screen.queryByText(/reports it as no-tests/)).toBeNull();
    });

    it("carries the COUNT on the tab label", () => {
      const target = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
      useAppStore.setState({
        components: SEED_COMPONENTS.map((c) => c.id === target.id
          ? { ...c, tests: [{ name: "a", src: "1" }, { name: "b", src: "2" }] }
          : c),
      });
      render(<DesignsWorkbench />);
      fireEvent.click(graphNode(target.name));
      expect(screen.getByRole("tab", { name: /^Tests\s*2$/ })).toBeTruthy();
    });

    it("omits the count at zero — a bare `0` reads as a broken badge", () => {
      const target = SEED_COMPONENTS.find((c) => c.kitId === "react-ui")!;
      useAppStore.setState({ components: SEED_COMPONENTS.map((c) => (c.id === target.id ? { ...c, tests: [] } : c)) });
      render(<DesignsWorkbench />);
      fireEvent.click(graphNode(target.name));
      expect(screen.getByRole("tab", { name: "Tests" })).toBeTruthy();
    });
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

  // #3543: the packaged seed is now a single empty kit, so this describe builds its OWN multi-kit fixture to
  // exercise the tech→style grouping shapes the rail must render: a multi-kit `studio` group (react-ui +
  // Fleet), a single-kit `motion` style (base), and a multi-kit `data-viz` group (three viz kits). This
  // reproduces the pre-#3543 packaged structure AS TEST DATA (a grouping fixture, not a claim about what
  // ships); the react-ui LIBRARY supplies the components rendered under the studio kit.
  const mkKit = (id: string, name: string, style: string): Kit =>
    ({ id, name, tech: "react", style, stack: name, dot: "var(--accent)" });
  const PACKAGED_KITS: Kit[] = [
    REACT_UI_KIT,
    mkKit("fleet", "Fleet", "studio"),
    mkKit("base", "base", "motion"),
    mkKit("algo-viz", "Algorithm Viz", "data-viz"),
    mkKit("matrix-viz", "Matrix Viz", "data-viz"),
    mkKit("graph-viz", "Graph Viz", "data-viz"),
  ];
  beforeEach(() => {
    useAppStore.setState({ kits: PACKAGED_KITS, components: REACT_UI_COMPONENTS });
  });

  it("the packaged library renders grouped at BOTH levels: react (tech) → studio kit + data-viz group → components (#3194/#3242)", () => {
    const { container } = render(<DesignsWorkbench />);
    // Level 1 — the react tech header (all kits share react) + the multi-kit `data-viz` STYLE group (three
    // viz kits now: algo-viz + matrix-viz + graph-viz, #3242), both `.ds-grouphead`.
    const heads = [...container.querySelectorAll(".ds-grouphead")];
    expect(heads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react"), expect.stringContaining("studio"), expect.stringContaining("data-viz"),
    ]);
    expect(heads[0].getAttribute("aria-expanded")).toBe("true"); // default OPEN
    // Level 2 — `studio` now holds react-ui + `fleet` (#3462), so it is a GROUP with a kit row each
    // rather than a merged single-kit head; `motion` is still single-kit (merged, labelled by STYLE);
    // the data-viz group's three kits are kitheads labelled by KIT NAME.
    const kitHeads = [...container.querySelectorAll(".ds-kithead")];
    expect(kitHeads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react-ui"),
      expect.stringContaining("Fleet"),
      expect.stringContaining("motion"), // the shared `base` motion kit, single-kit style (#3451)
      expect.stringContaining("Algorithm Viz"),
      expect.stringContaining("Matrix Viz"),
      expect.stringContaining("Graph Viz"),
    ]);
    // The components list directly under the studio style header (the kit defaults open).
    expect(railRow("Chip")).toBeTruthy();
  });

  it("a multi-tech library nests one collapsible tech group per technology, each style header a kit", () => {
    useAppStore.setState({ kits: [...PACKAGED_KITS, vueKit] });
    const { container } = render(<DesignsWorkbench />);
    const heads = [...container.querySelectorAll(".ds-grouphead")];
    // react tech + its multi-kit data-viz style group (#3242), then the vue tech.
    expect(heads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react"), expect.stringContaining("studio"),
      expect.stringContaining("data-viz"), expect.stringContaining("vue"),
    ]);
    // Groups default OPEN — studio's two kits (react-ui + fleet, #3462) + motion + the three data-viz
    // kits (by name) under react, then vue's merged material kithead.
    const kitHeads = [...container.querySelectorAll(".ds-kithead")];
    expect(kitHeads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react-ui"), expect.stringContaining("Fleet"),
      expect.stringContaining("motion"),
      expect.stringContaining("Algorithm Viz"), expect.stringContaining("Matrix Viz"), expect.stringContaining("Graph Viz"),
      expect.stringContaining("material"),
    ]);
  });

  it("collapsing a tech group hides its kits (and their components); re-expanding restores them", () => {
    useAppStore.setState({ kits: [...PACKAGED_KITS, vueKit] });
    const { container } = render(<DesignsWorkbench />);
    const reactHead = container.querySelector(".ds-grouphead") as HTMLElement;
    fireEvent.click(reactHead); // collapse the react group — only the vue style/kit head remains
    expect(reactHead.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".ds-kithead").length).toBe(1);
    fireEvent.click(reactHead); // …and back
    expect(container.querySelectorAll(".ds-kithead").length).toBe(PACKAGED_KITS.length + 1);
  });

  it("a component under the grouped rail is still fully driveable — selecting it follows in the inspector", () => {
    useAppStore.setState({ kits: [...PACKAGED_KITS, vueKit] });
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
    useAppStore.setState({ kits: [...PACKAGED_KITS, bare] });
    const { container } = render(<DesignsWorkbench />);
    // react (+ its multi-kit data-viz style group #3242) + the trailing missing-field tech bucket; the bare
    // kit merges into its "other" style head.
    const heads = [...container.querySelectorAll(".ds-grouphead")];
    expect(heads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react"), expect.stringContaining("studio"),
      expect.stringContaining("data-viz"), expect.stringContaining("other"),
    ]);
    expect(container.querySelectorAll(".ds-kithead").length).toBe(PACKAGED_KITS.length + 1);
  });

  it("SEVERAL kits sharing one (tech, style) still nest kit rows beneath the style group", () => {
    const twin: Kit = { id: "react-ui-2", name: "react-ui-2", tech: "react", style: "studio", stack: "React", dot: "var(--accent)" };
    useAppStore.setState({ kits: [...PACKAGED_KITS, twin] });
    const { container } = render(<DesignsWorkbench />);
    // react tech header + TWO multi-kit style groups: studio (react-ui + twin) and data-viz (the three viz
    // kits, #3242). Both styles now hold several kits, so both are groupheads.
    expect([...container.querySelectorAll(".ds-grouphead")].map((h) => h.textContent)).toEqual([
      expect.stringContaining("react"), expect.stringContaining("studio"), expect.stringContaining("data-viz"),
    ]);
    // studio's two kit rows, then the single-kit `motion` style (merged, labelled by STYLE — #3451),
    // then data-viz's three kit rows.
    const kitHeads = [...container.querySelectorAll(".ds-kithead")];
    expect(kitHeads.map((h) => h.textContent)).toEqual([
      expect.stringContaining("react-ui"), expect.stringContaining("Fleet"), expect.stringContaining("react-ui-2"),
      expect.stringContaining("motion"),
      expect.stringContaining("Algorithm Viz"), expect.stringContaining("Matrix Viz"), expect.stringContaining("Graph Viz"),
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
    expect(screen.getByText("Props / API")).toBeTruthy();                // per-component inspector restored
  });

  it("the expanded center carries the theme's palette strip alongside the preview (#2834)", () => {
    const { container } = render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    expect(container.querySelector(".ds-palette")).toBeNull();           // not before expanding
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    // The palette is OPT-IN behind its toggle now — expanding alone no longer mounts it.
    expect(container.querySelector(".ds-palette")).toBeNull();
    fireEvent.click(screen.getByTitle(/Show the theme palette/));
    // Toggled on, the strip carries the grouped semantic swatches.
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
    // #3154: the expanded preview is a pan/zoom canvas, so it renders at a FIXED world per breakpoint
    // (fit-to-frame replaces "fluid"); `auto` maps to a desktop-width world.
    expect(frame().style.width).toBe("1200px");                          // auto → desktop world
    fireEvent.click(screen.getByText("sm"));
    expect(frame().style.width).toBe("380px");                           // resized to the sm breakpoint
    fireEvent.click(screen.getByText("md"));
    expect(frame().style.width).toBe("640px");                           // …and the md breakpoint
  });

  it("the expanded preview has its own pan/zoom controls (#3154)", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    // The preview's own ZoomControls (+/−) + a fit button are wired to the preview viewport. The graph's
    // toolbar (its own ZoomControls) is hidden in preview mode, so these are unambiguously the preview's.
    expect(screen.getByRole("button", { name: /zoom in/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /zoom out/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "fit" })).toBeTruthy();
  });

  it("the preview is interactive + driven by the in-iframe CRISP engine, not a host viewport (#3190)", () => {
    render(<DesignsWorkbench />);
    fireEvent.click(graphNode("Chip"));
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    // No select/pan toggle, and no per-component gating.
    expect(screen.queryByText("🖐 pan")).toBeNull();
    expect(screen.queryByText("select")).toBeNull();
    // #3190 crisp pass: pan/zoom moved INSIDE the iframe (a DOM transform → sharp), so the host no longer
    // owns a viewport — no `onCanvasDown`, no `data-node`. #3551: in fluid mode (the default) the frame
    // mounts DIRECTLY in the canvas — the placer wrapper is dropped — and nothing in the chain sets
    // pointer-events:none, so the engine inside still receives drag/wheel; the +/−/fit buttons RELAY via
    // `__cmd` postMessages.
    const iframe = screen.getByTitle("Chip preview") as HTMLIFrameElement;
    const worldWrap = iframe.parentElement!.parentElement as HTMLElement;
    expect(worldWrap.style.pointerEvents).not.toBe("none"); // nothing blocks the engine's drag/wheel
    expect(worldWrap.getAttribute("data-node")).toBeNull(); // not wired as a graph node
    const posts: unknown[] = [];
    const win = iframe.contentWindow!;
    const spy = vi.spyOn(win, "postMessage").mockImplementation(((m: unknown) => { posts.push(m); }) as typeof win.postMessage);
    fireEvent.click(screen.getByRole("button", { name: /zoom in/ }));
    fireEvent.click(screen.getByRole("button", { name: "fit" }));
    expect(posts).toContainEqual({ __cmd: "zoomIn" });        // the +/−/fit buttons drive the engine
    expect(posts).toContainEqual({ __cmd: "fit" });
    spy.mockRestore();
  });

  it("preview mode hides the graph chrome (the composition-graph toolbar); it returns on exit (#2849)", () => {
    const { container } = render(<DesignsWorkbench />);
    const chrome = () => screen.queryByRole("button", { name: /Share/ }); // header-ONLY (the expanded preview has its own fit)
    expect(chrome()).toBeTruthy();                                       // graph header shown normally
    fireEvent.click(graphNode("Chip"));
    fireEvent.click(screen.getByRole("button", { name: /Expand Chip preview/ }));
    expect(chrome()).toBeNull();                                         // hidden while previewing
    // …but the loop banner SURVIVES as the overlay (#3852): the header is gone, and its Stop is the only
    // brake on an unattended run, so it must not become unreachable.
    expect(container.querySelector(".designer-loop-banner:not(.dlb-inline)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back to graph/ }));
    expect(chrome()).toBeTruthy();                                       // restored on exit
  });
});

describe("component folders render as readable rows (#3632)", () => {
  const kit = REACT_UI_KIT;
  const foldered = (id: string, name: string, folder: string) =>
    ({ ...REACT_UI_COMPONENTS[0], id, name, kitId: kit.id, folder });

  it("a folder header is the readable RailRow (not the dim uppercase micro-label) and toggles its children", () => {
    // The first kit auto-expands, so its folder tree renders. The seed carries no `folder` (hence a
    // flat list), so inject foldered components to make `groupComponentsByFolder` produce a folder.
    useAppStore.setState({
      kits: [kit],
      components: [foldered("g-a", "Alpha", "widgets"), foldered("g-b", "Beta", "widgets")],
      designsKitId: kit.id,
      designsCompId: null,
    });
    const { container } = render(<DesignsWorkbench />);
    const folder = container.querySelector(".ds-compfolderhead") as HTMLElement;
    expect(folder).toBeTruthy();
    // The fix (#3632): folders wear the readable nav-row look, NOT the dim uppercase group micro-label.
    expect(folder.matches("button.rail-row")).toBe(true);
    expect(folder.classList.contains("rail-grouphead")).toBe(false);
    expect(folder.textContent).toContain("widgets");           // label reads in normal case (not "WIDGETS")
    // Scope to the RAIL: "Alpha" also labels its graph node, so a bare getByText matches twice.
    expect(railRow("Alpha")).toBeTruthy();                     // its components list under it (open by default)
    fireEvent.click(folder);                                   // collapse the folder…
    expect(railRow("Alpha")).toBeFalsy();                      // …hides its components (the graph node stays)
  });
});
