import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "@/store";
import type { ComponentRecord, Kit } from "./lib/model";
import type { Dispatch } from "./lib/propagation";
import { makeChange } from "./lib/propagation";
import { contractChanged, mergeDispatches } from "./store";
import { SEED_COMPONENTS, SEED_KITS, BASE_STUDIO_CODE_KIT_ID } from "./lib/seed";
import { SEED_THEMES, type KitThemeRecord } from "./lib/themes";
import { stampSeedHash } from "./lib/seedRefresh";
import * as bridge from "./lib/componentBridge";
import * as themeBridge from "./lib/themeBridge";
import * as usageBridge from "./lib/kitUsageBridge";
import { setActiveKitThemes, activeKitThemes, themeById } from "@/shared/ui/kit";

// The packaged seed is now a single EMPTY kit (#3543): SEED_KITS = [base-studio-code], SEED_COMPONENTS = [].
// The store-BEHAVIOR tests below (contract-diff propagation, live-focus fan-out, setComponent) need a real
// component to diff, so they carry their OWN fixture — one Button in the base-studio-code kit — instead of
// reaching into SEED_COMPONENTS for a seed component that no longer exists. Independent of the packaged seed.
const FIXTURE_BUTTON: ComponentRecord = {
  id: "button", name: "Button", kitId: BASE_STUDIO_CODE_KIT_ID, role: "primitive",
  version: "1.0.0", used: 3, tags: ["form"], variants: ["default", "primary"], composes: [],
  props: [
    { name: "size", type: "string", req: false, desc: "" },
    { name: "onClick", type: "() => void", req: false, desc: "" },
  ],
  whenUse: ["actions"], whenNot: ["links"], src: "Button.tsx", srcText: "<Button/>",
};
const FIXTURE_COMPONENTS: ComponentRecord[] = [FIXTURE_BUTTON];

describe("components store slice (#2281)", () => {
  beforeEach(() => {
    useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS });
    vi.restoreAllMocks();
  });

  it("hydrateComponents keeps the seed when the bridge is unreachable", async () => {
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce(null);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(null);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().components).toEqual(SEED_COMPONENTS);
    expect(useAppStore.getState().kits).toEqual(SEED_KITS);
  });

  // #3543: the clean-slate seed is ONE kit. An empty store recovers exactly it — the kit is appended
  // + pushed (recover/shadow-proof), along with the packaged components it ships.
  // The kit is no longer EMPTY (#3604): the app's own migrated pages are packaged as graph source
  // under `@data/components/app/**` and ride into `SEED_COMPONENTS`, so an empty store seeds them too.
  it("hydrateComponents seeds the base-studio-code kit + its packaged components into an empty store (#3543/#3604)", async () => {
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce([]);
    const pushC = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    const pushK = vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().kits).toEqual(SEED_KITS);
    expect(useAppStore.getState().kits.map((k) => k.id)).toEqual([BASE_STUDIO_CODE_KIT_ID]);
    expect(useAppStore.getState().components).toEqual(SEED_COMPONENTS);
    expect(pushK).toHaveBeenCalledTimes(1);
    expect(pushK).toHaveBeenCalledWith(expect.objectContaining({ id: BASE_STUDIO_CODE_KIT_ID }));
    // Each packaged component is pushed through the bridge too (recover/shadow-proof, same as the kit).
    expect(pushC).toHaveBeenCalledTimes(SEED_COMPONENTS.length);
  });

  // #3543: the wipe at the STORE/bridge layer — a pre-#3543 store still holding the retired packaged kits
  // (+ a pristine component) reconciles to just base-studio-code, and each retiree is dropped through the bridge.
  it("hydrateComponents retires every prior packaged kit + component, converging to base-studio-code (#3543)", async () => {
    const priorKit = (id: string): Kit =>
      stampSeedHash({ id, name: id, tech: "react", style: "studio", stack: id, dot: "green", builtin: true } as Kit);
    const oldKits = ["react-ui", "fleet", "base", "algo-viz", "matrix-viz", "graph-viz"].map(priorKit);
    const oldComp = stampSeedHash({ ...FIXTURE_BUTTON, kitId: "react-ui", builtin: true });
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([oldComp]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(oldKits);
    const dropC = vi.spyOn(bridge, "dropComponent").mockResolvedValue(undefined);
    const dropK = vi.spyOn(bridge, "dropKit").mockResolvedValue(undefined);
    vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().kits.map((k) => k.id)).toEqual([BASE_STUDIO_CODE_KIT_ID]);
    // The retirees are gone and the store converges to exactly the packaged set (#3604 — no longer empty).
    expect(useAppStore.getState().components).toEqual(SEED_COMPONENTS);
    expect(dropK).toHaveBeenCalledWith("react-ui");
    expect(dropK).toHaveBeenCalledWith("fleet");
    expect(dropC).toHaveBeenCalledWith(oldComp.id);
  });

  it("hydrateComponents keeps a user record from the store and does NOT re-push it", async () => {
    const userComp = { ...FIXTURE_BUTTON, id: "my-widget", name: "MyWidget", builtin: undefined };
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([userComp]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS); // all built-in kits already in the store
    const pushC = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    const pushK = vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().components.some((c) => c.id === "my-widget")).toBe(true);
    expect(pushC).not.toHaveBeenCalledWith(expect.objectContaining({ id: "my-widget" }));
    expect(pushK).not.toHaveBeenCalled(); // every kit already present → nothing to re-seed
  });
});

describe("designer AI live-focus (#2525)", () => {
  // The real hydrate actions, captured so a test that swaps in vi.fn() spies restores them after —
  // otherwise the mocked no-op actions leak into the later hydrate tests (the store is a singleton).
  const realHydrateComponents = useAppStore.getState().hydrateComponents;
  const realHydrateThemes = useAppStore.getState().hydrateThemes;
  beforeEach(() => {
    useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, aiFocusedId: null });
    vi.restoreAllMocks();
  });
  afterEach(() => {
    useAppStore.setState({ hydrateComponents: realHydrateComponents, hydrateThemes: realHydrateThemes });
  });

  it("setAiFocused records the touched id AND re-hydrates so the AI's edit shows without a relaunch", () => {
    const hydrateComponents = vi.fn();
    const hydrateThemes = vi.fn();
    useAppStore.setState({ hydrateComponents, hydrateThemes });

    // A component touch: focus the id + re-pull the components (not themes).
    useAppStore.getState().setAiFocused("chip", "component");
    expect(useAppStore.getState().aiFocusedId).toBe("chip");
    expect(hydrateComponents).toHaveBeenCalledTimes(1);
    expect(hydrateThemes).not.toHaveBeenCalled();

    // A theme touch: focus + re-pull BOTH (components load kits; themes reload the palette set).
    useAppStore.getState().setAiFocused("neon", "theme");
    expect(useAppStore.getState().aiFocusedId).toBe("neon");
    expect(hydrateComponents).toHaveBeenCalledTimes(2);
    expect(hydrateThemes).toHaveBeenCalledTimes(1);
  });

  it("setAiFocused(null) clears the focus WITHOUT re-hydrating (session end)", () => {
    const hydrateComponents = vi.fn();
    useAppStore.setState({ hydrateComponents, aiFocusedId: "chip" });
    useAppStore.getState().setAiFocused(null);
    expect(useAppStore.getState().aiFocusedId).toBeNull();
    expect(hydrateComponents).not.toHaveBeenCalled();
  });

  it("setAiFocused with hydrate:false focuses WITHOUT re-hydrating — a read-focus (#3545)", () => {
    const hydrateComponents = vi.fn();
    useAppStore.setState({ hydrateComponents });
    // A `ui-focus` (bsc ui get / preview-props): drive the preview, but do NOT refetch the library —
    // nothing changed, and this fires on every read.
    useAppStore.getState().setAiFocused("chip", "component", { hydrate: false });
    expect(useAppStore.getState().aiFocusedId).toBe("chip");
    expect(hydrateComponents).not.toHaveBeenCalled();
  });
});

describe("kit-change origin (#2810 — a CLI edit fires propagation)", () => {
  const button = FIXTURE_BUTTON;
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({ components: FIXTURE_COMPONENTS, kits: SEED_KITS, kitUsage: [], kitDispatches: [], aiFocusedId: null });
  });

  it("contractChanged: true on a props/variants/version change, false on a non-contract field", () => {
    expect(contractChanged(button, button)).toBe(false);
    expect(contractChanged(button, { ...button, variants: [...button.variants, "loading"] })).toBe(true);
    expect(contractChanged(button, { ...button, version: `${button.version}-x` })).toBe(true);
    expect(contractChanged(button, { ...button, used: button.used + 1 })).toBe(false); // reuse count isn't a contract change
  });

  it("mergeDispatches appends only fresh dispatches (deduped by dispatchKey)", () => {
    const d = (projectKey: string): Dispatch =>
      ({ projectKey, kind: "assign", reason: "", change: makeChange({ ...button, version: "9.9.9" }, button, { class: "breaking" }) });
    const a = d("p1");
    expect(mergeDispatches([], [a])).toHaveLength(1);
    expect(mergeDispatches([a], [a])).toHaveLength(1); // same (project, change) → not re-added
    expect(mergeDispatches([a], [d("p2")])).toHaveLength(2);
  });

  it("a ui-touch whose component contract changed fans out to a kit consumer", async () => {
    const edited = { ...button, variants: [...button.variants, "loading"] };
    useAppStore.setState({ kitUsage: [{ projectKey: "p", kitId: button.kitId }] });
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([...FIXTURE_COMPONENTS.filter((c) => c.id !== button.id), edited]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    useAppStore.getState().setAiFocused(button.id, "component");
    await new Promise((r) => setTimeout(r, 25)); // let the async hydrate + diff settle
    const q = useAppStore.getState().kitDispatches;
    expect(q.length).toBeGreaterThan(0);
    expect(q[0].projectKey).toBe("p");
  });

  it("a ui-touch with NO contract change queues nothing (no noise on every touch)", async () => {
    useAppStore.setState({ kitUsage: [{ projectKey: "p", kitId: button.kitId }] });
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce(FIXTURE_COMPONENTS);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    useAppStore.getState().setAiFocused("chip", "component");
    await new Promise((r) => setTimeout(r, 25));
    expect(useAppStore.getState().kitDispatches).toEqual([]);
  });
});

// The hash-based reconcile at the STORE/bridge layer (#2483). With the clean-slate seed (#3543) the
// refresh/upstream-notice branches (which need a seed record to refresh TOWARD) are covered by
// seed.test.ts against the current seed; what remains here is the DROP path — the mechanism that wipes
// every retired built-in from an existing install — plus the legacy-refresh and notice-dismiss surface.
describe("hash-based built-in seed refresh (#2483)", () => {
  beforeEach(() => {
    useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, seedNotices: [] });
    vi.restoreAllMocks();
  });

  it("drops a pristine built-in kit that left the seed (spring-kotlin regression) via the bridge", async () => {
    const springKotlin = stampSeedHash({ id: "spring-kotlin", name: "Spring Kotlin", stack: "Spring · Kotlin", dot: "green", builtin: true });
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce(SEED_COMPONENTS);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce([...SEED_KITS, springKotlin]);
    vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);
    const dropK = vi.spyOn(bridge, "dropKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().kits.some((k) => k.id === "spring-kotlin")).toBe(false);
    expect(dropK).toHaveBeenCalledWith("spring-kotlin");
    expect(useAppStore.getState().seedNotices).toEqual([]);
  });

  // The retired `examples` exemplar kit (#2506) — a stale store fixture shaped EXACTLY like the
  // copies a pre-#2506 install holds: `builtin` + self-consistently `seedHash`-stamped, i.e. what
  // `makeBuiltinKits` shipped before the kit left the seed.
  const examplesKit: Kit = stampSeedHash({
    id: "examples", name: "examples", tech: "react", style: "demo",
    stack: "React · demo", dot: "var(--state-wait)", builtin: true,
  });
  const exampleComp = (id: string, name: string, role: ComponentRecord["role"], composes: string[] = []): ComponentRecord =>
    stampSeedHash({
      id, name, kitId: "examples", role, version: "1.0.0", used: 0, tags: ["demo"],
      variants: ["default"], composes, props: [], whenUse: ["demo"], whenNot: ["real UI"],
      src: `examples/${name}.tsx`, srcText: `<${name} />`, builtin: true,
    });

  it("boot hydrate DELETES the retired examples kit + its components from a stale store (#2506)", async () => {
    // The mechanism that cleans every existing install: #2506 removed `examples` from the packaged
    // seed, so the #2483 reconcile must reach the DELETE verdict for the pristine stored copies and
    // converge the global store through the bridge drops — no manual cleanup.
    const staleComps = [
      exampleComp("personaspanel", "PersonasPanel", "page", ["PersonaStore"]),
      exampleComp("agentsboard", "AgentsBoard", "page"),
      exampleComp("personastore", "PersonaStore", "service"),
    ];
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([...SEED_COMPONENTS, ...staleComps]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce([...SEED_KITS, examplesKit]);
    const pushC = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    const pushK = vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);
    const dropC = vi.spyOn(bridge, "dropComponent").mockResolvedValue(undefined);
    const dropK = vi.spyOn(bridge, "dropKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    // The kit and every one of its components are gone from the reconciled collection…
    expect(useAppStore.getState().kits.map((k) => k.id)).toEqual(SEED_KITS.map((k) => k.id));
    expect(useAppStore.getState().components.some((c) => c.kitId === "examples")).toBe(false);
    // …and the store converges via the bridge: one dropKit + one dropComponent per stale record.
    expect(dropK).toHaveBeenCalledWith("examples");
    for (const c of staleComps) expect(dropC).toHaveBeenCalledWith(c.id);
    expect(dropC).toHaveBeenCalledTimes(staleComps.length);
    // Everything else was current → nothing re-pushed, and a DELETE is silent (no orphan notice).
    expect(pushC).not.toHaveBeenCalled();
    expect(pushK).not.toHaveBeenCalled();
    expect(useAppStore.getState().seedNotices).toEqual([]);
  });

  it("keeps a USER-EDITED copy of a retired examples component, marked orphaned (#2506)", async () => {
    // The safety valve on the same retirement: content moved off its recorded baseline → never
    // deleted, surfaced as an `orphaned` notice instead.
    const edited = { ...exampleComp("personaspanel", "PersonasPanel", "page"), srcText: "// my tweaks" };
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([...SEED_COMPONENTS, edited]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    const dropC = vi.spyOn(bridge, "dropComponent").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().components.find((c) => c.id === "personaspanel")).toEqual(edited);
    expect(dropC).not.toHaveBeenCalled();
    expect(useAppStore.getState().seedNotices).toEqual([
      { kind: "orphaned", type: "component", id: "personaspanel", name: "PersonasPanel" },
    ]);
  });

  it("legacy no-hash pristine records refresh once, re-pushed with the stamp", async () => {
    const legacyKits = SEED_KITS.map((k) => ({ ...k, seedHash: undefined }));
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce(SEED_COMPONENTS);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(legacyKits);
    const pushK = vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().kits).toEqual(SEED_KITS);
    expect(pushK).toHaveBeenCalledTimes(SEED_KITS.length);
    expect(useAppStore.getState().seedNotices).toEqual([]);
  });

  it("dismissSeedNotice drops exactly the dismissed notice", () => {
    useAppStore.setState({
      seedNotices: [
        { kind: "orphaned", type: "kit", id: "spring-kotlin", name: "Spring Kotlin" },
        { kind: "updated-upstream", type: "component", id: "button", name: "Button" },
      ],
    });
    useAppStore.getState().dismissSeedNotice("kit", "spring-kotlin");
    expect(useAppStore.getState().seedNotices).toEqual([
      { kind: "updated-upstream", type: "component", id: "button", name: "Button" },
    ]);
  });
});

describe("kit-theme collection slice (#2488)", () => {
  beforeEach(() => {
    useAppStore.setState({ kitThemes: SEED_THEMES, seedNotices: [] });
    setActiveKitThemes([]); // reset the shared resolvers to the packaged registry
    vi.restoreAllMocks();
  });

  it("hydrateThemes keeps the packaged seed when the bridge is unreachable", async () => {
    vi.spyOn(themeBridge, "loadThemes").mockResolvedValueOnce(null);
    await useAppStore.getState().hydrateThemes();
    expect(useAppStore.getState().kitThemes).toEqual(SEED_THEMES);
  });

  it("hydrateThemes re-seeds an empty store, pushing stamped built-ins, and syncs the resolvers", async () => {
    vi.spyOn(themeBridge, "loadThemes").mockResolvedValueOnce([]);
    const push = vi.spyOn(themeBridge, "pushTheme").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateThemes();
    expect(useAppStore.getState().kitThemes).toEqual(SEED_THEMES);
    expect(push).toHaveBeenCalledTimes(SEED_THEMES.length);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ id: "default", builtin: true }));
    // The shared resolvers (themeById/ThemeScope) now resolve against the hydrated set.
    expect(activeKitThemes()).toEqual(SEED_THEMES);
  });

  it("hydrateThemes keeps a designer-edited built-in — themeById serves the edit — with a theme notice", async () => {
    const soft = SEED_THEMES.find((t) => t.id === "nord")!;
    const edited: KitThemeRecord = { ...soft, vars: { "--card-bg": "black" }, seedHash: "00000000" };
    vi.spyOn(themeBridge, "loadThemes").mockResolvedValueOnce([...SEED_THEMES.filter((t) => t.id !== "nord"), edited]);
    const push = vi.spyOn(themeBridge, "pushTheme").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateThemes();
    expect(useAppStore.getState().kitThemes.find((t) => t.id === "nord")).toEqual(edited);
    expect(push).not.toHaveBeenCalled();
    expect(useAppStore.getState().seedNotices).toEqual([
      { kind: "updated-upstream", type: "theme", id: "nord", name: soft.label },
    ]);
    expect(themeById("nord").vars).toEqual({ "--card-bg": "black" });
  });

  it("orders the hydrated collection: packaged registry order first, authored themes after", async () => {
    const neon: KitThemeRecord = { id: "neon", tech: "react", label: "Neon", description: "", vars: { "--chip-bg": "red" } };
    // A filesystem-order shuffle: the authored theme first, built-ins reversed.
    vi.spyOn(themeBridge, "loadThemes").mockResolvedValueOnce([neon, ...[...SEED_THEMES].reverse()]);
    await useAppStore.getState().hydrateThemes();
    expect(useAppStore.getState().kitThemes.map((t) => t.id)).toEqual([...SEED_THEMES.map((t) => t.id), "neon"]);
  });

  it("theme notices survive a later hydrateComponents (the two hydrates race on boot)", async () => {
    const soft = SEED_THEMES.find((t) => t.id === "nord")!;
    const edited: KitThemeRecord = { ...soft, vars: { "--card-bg": "black" }, seedHash: "00000000" };
    vi.spyOn(themeBridge, "loadThemes").mockResolvedValueOnce([...SEED_THEMES.filter((t) => t.id !== "nord"), edited]);
    await useAppStore.getState().hydrateThemes();
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce(SEED_COMPONENTS);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().seedNotices).toEqual([
      { kind: "updated-upstream", type: "theme", id: "nord", name: soft.label },
    ]);
  });

  it("dismissSeedNotice works for theme notices via the shared surface", () => {
    useAppStore.setState({ seedNotices: [{ kind: "orphaned", type: "theme", id: "gone", name: "Gone" }] });
    useAppStore.getState().dismissSeedNotice("theme", "gone");
    expect(useAppStore.getState().seedNotices).toEqual([]);
  });
});

describe("kit-usage consumer index slice (#2277)", () => {
  beforeEach(() => {
    useAppStore.setState({ kitUsage: [] });
    vi.restoreAllMocks();
  });

  it("addKitUsage appends, dedups by (project, kit), and pushes through the bridge once", () => {
    const push = vi.spyOn(usageBridge, "pushKitUsage").mockResolvedValue(undefined);
    useAppStore.getState().addKitUsage("proj-a", "react-ui");
    useAppStore.getState().addKitUsage("proj-a", "react-ui"); // duplicate → no-op
    useAppStore.getState().addKitUsage("", "react-ui"); // empty → rejected
    expect(useAppStore.getState().kitUsage).toEqual([{ projectKey: "proj-a", kitId: "react-ui" }]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("proj-a", "react-ui");
  });

  it("removeKitUsage drops the edge and pushes the removal by its deterministic id", () => {
    vi.spyOn(usageBridge, "pushKitUsage").mockResolvedValue(undefined);
    const drop = vi.spyOn(usageBridge, "dropKitUsage").mockResolvedValue(undefined);
    useAppStore.getState().addKitUsage("proj-a", "react-ui");
    useAppStore.getState().removeKitUsage("proj-a", "react-ui");
    expect(useAppStore.getState().kitUsage).toHaveLength(0);
    expect(drop).toHaveBeenCalledWith("proj-a>react-ui"); // matches the Rust usage_id
  });

  it("hydrateKitUsage replaces from the bridge, but keeps the cache when unreachable", async () => {
    useAppStore.setState({ kitUsage: [{ projectKey: "cached", kitId: "react-ui" }] });
    vi.spyOn(usageBridge, "loadKitUsage").mockResolvedValueOnce(null); // unreachable → keep
    await useAppStore.getState().hydrateKitUsage();
    expect(useAppStore.getState().kitUsage).toEqual([{ projectKey: "cached", kitId: "react-ui" }]);
    const loaded = [{ projectKey: "m", kitId: "spring-kotlin" }];
    vi.spyOn(usageBridge, "loadKitUsage").mockResolvedValueOnce(loaded);
    await useAppStore.getState().hydrateKitUsage();
    expect(useAppStore.getState().kitUsage).toEqual(loaded);
  });
});

describe("component change origin → propagation (#2277)", () => {
  const button = FIXTURE_BUTTON;
  beforeEach(() => {
    useAppStore.setState({ components: FIXTURE_COMPONENTS, kits: SEED_KITS, kitUsage: [], kitDispatches: [] });
    vi.restoreAllMocks();
  });

  it("setComponent write-throughs the edit and upserts it", () => {
    const push = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    const edited = { ...button, version: "2.3.1" };
    useAppStore.getState().setComponent(edited);
    expect(useAppStore.getState().components.find((c) => c.id === button.id)!.version).toBe("2.3.1");
    expect(push).toHaveBeenCalledWith(edited);
  });

  it("a breaking edit fans out to an opted-in dormant consumer as an assignment", () => {
    // The GH-issue rail was dropped for `bsc-assign` (kit-vendoring epic #2793): a breaking edit to an
    // opted-in consumer now dispatches `kind: "assign"` — the only dispatch kinds are notify | assign.
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    useAppStore.setState({ kitUsage: [{ projectKey: "app-a", kitId: button.kitId, auto: true, live: false }] });
    useAppStore.getState().setComponent({ ...button, version: "3.0.0", props: button.props.filter((p) => p.name !== "size") });
    const d = useAppStore.getState().kitDispatches;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ projectKey: "app-a", kind: "assign" });
    expect(d[0].change.class).toBe("breaking");
  });

  it("an additive edit is notify-only, even for an opted-in live consumer", () => {
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    useAppStore.setState({ kitUsage: [{ projectKey: "app-a", kitId: button.kitId, auto: true, live: true }] });
    useAppStore.getState().setComponent({ ...button, version: "2.4.0", variants: [...button.variants, "loading"] });
    expect(useAppStore.getState().kitDispatches.every((x) => x.kind === "notify")).toBe(true);
  });

  it("a brand-new component is not a change (no dispatch)", () => {
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    useAppStore.setState({ kitUsage: [{ projectKey: "app-a", kitId: button.kitId, auto: true, live: false }] });
    useAppStore.getState().setComponent({ ...button, id: "brand-new", name: "BrandNew" });
    expect(useAppStore.getState().kitDispatches).toHaveLength(0);
  });

  it("the same change re-emitted dedups; dismiss drops the queued dispatch", () => {
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    useAppStore.setState({ kitUsage: [{ projectKey: "app-a", kitId: button.kitId, auto: true, live: false }] });
    const breaking = { ...button, version: "3.0.0", props: button.props.filter((p) => p.name !== "size") };
    useAppStore.getState().setComponent(breaking);
    useAppStore.setState({ components: FIXTURE_COMPONENTS }); // reset the component so the SAME transition repeats
    useAppStore.getState().setComponent(breaking);
    expect(useAppStore.getState().kitDispatches).toHaveLength(1); // deduped by (projectKey, change.id)
    const { change } = useAppStore.getState().kitDispatches[0];
    useAppStore.getState().dismissKitDispatch("app-a", change.id);
    expect(useAppStore.getState().kitDispatches).toHaveLength(0);
  });
});

describe("restampUnstamped — the #4207 repair", () => {
  // A real packaged seed of each kind, so the test binds to the actual seed set rather than a fixture
  // that could drift away from it.
  const seedNonPage = SEED_COMPONENTS.find((c) => c.role !== "page")!;
  const seedPage = SEED_COMPONENTS.find((c) => c.role === "page")!;

  beforeEach(() => {
    useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS });
    vi.restoreAllMocks();
  });

  /** The store's copy of a packaged seed, with the stamp stripped — what a pre-#4197 partial write left. */
  const unstamped = (from: ComponentRecord): ComponentRecord => {
    const { builtin: _b, seedHash: _h, ...rest } = from;
    return { ...rest, version: "0.0.1-store-edit" } as ComponentRecord;
  };

  it("stamps an unstamped record through the MERGING write, never the replacing one", async () => {
    vi.spyOn(bridge, "loadComponents").mockResolvedValue([unstamped(seedNonPage)]);
    vi.spyOn(bridge, "loadKits").mockResolvedValue(null);
    const stamp = vi.spyOn(bridge, "stampComponent").mockResolvedValue(undefined);
    const push = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);

    const r = await useAppStore.getState().restampUnstamped();

    expect(r.stamped).toBe(1);
    expect(stamp).toHaveBeenCalledWith(seedNonPage.id, seedNonPage.seedHash);
    // `--replace` on THIS record would push the bridge PROJECTION over the stored one — the #4197
    // failure, committed by the pass meant to repair it. (The re-hydrate that follows pushes the
    // built-ins the mocked store lacks, which is the normal seed path and not this record.)
    expect(push.mock.calls.map((c) => c[0].id)).not.toContain(seedNonPage.id);
  });

  it("defers a page rather than handing the seed authority over what renders", async () => {
    vi.spyOn(bridge, "loadComponents").mockResolvedValue([unstamped(seedPage)]);
    vi.spyOn(bridge, "loadKits").mockResolvedValue(null);
    const stamp = vi.spyOn(bridge, "stampComponent").mockResolvedValue(undefined);

    const r = await useAppStore.getState().restampUnstamped();

    expect(r).toEqual({ stamped: 0, deferred: 1 });
    expect(stamp).not.toHaveBeenCalled();
  });

  it("is a no-op when the bridge is unreachable — nothing to repair against", async () => {
    vi.spyOn(bridge, "loadComponents").mockResolvedValue(null);
    const stamp = vi.spyOn(bridge, "stampComponent").mockResolvedValue(undefined);

    expect(await useAppStore.getState().restampUnstamped()).toEqual({ stamped: 0, deferred: 0 });
    expect(stamp).not.toHaveBeenCalled();
  });
});
