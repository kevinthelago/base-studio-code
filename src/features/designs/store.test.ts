import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "@/store";
import type { ComponentRecord, Kit } from "./lib/model";
import type { Dispatch } from "./lib/propagation";
import { makeChange } from "./lib/propagation";
import { contractChanged, mergeDispatches } from "./store";
import { SEED_COMPONENTS, SEED_KITS, DEFAULT_KIT_SEEDED, DEFAULT_KIT_ID } from "./lib/seed";
import { SEED_THEMES, type KitThemeRecord } from "./lib/themes";
import { stampSeedHash } from "./lib/seedRefresh";
import * as bridge from "./lib/componentBridge";
import * as themeBridge from "./lib/themeBridge";
import * as usageBridge from "./lib/kitUsageBridge";
import { setActiveKitThemes, activeKitThemes, themeById } from "@/shared/ui/kit";
import { ALGO_VIZ_KIT_ID } from "@/shared/ui/kit/algoVizAnimations";

// Everything that seeds REGARDLESS of DEFAULT_KIT_SEEDED, so the #3029 "default kit disabled" hydrate
// tests below expect it to survive/recover while react-ui retires: the shared `base` motion kit
// (#3451, always-on because react-ui's primitives REFERENCE its animations by name), the VIZ kits
// (algo-viz #3194 + matrix-viz/graph-viz #3242), and every non-default PACKAGED kit (`fleet`, #3462).
//
// Defined as "not the gated default" against seed.ts's own DEFAULT_KIT_ID rather than by listing the
// styles that happen to qualify. The previous form (`style === "data-viz" || id === BASE_KIT_ID`) was
// a restatement of the seed rule that drifted the moment a kit arrived which was neither — which is
// exactly what #3462 did, leaving these tests red on develop for four slices.
const ALWAYS_ON_KITS = SEED_KITS.filter((k) => k.id !== DEFAULT_KIT_ID);
const ALWAYS_ON_KIT_IDS = new Set(ALWAYS_ON_KITS.map((k) => k.id));
const ALWAYS_ON_COMPS = SEED_COMPONENTS.filter((c) => c.kitId && ALWAYS_ON_KIT_IDS.has(c.kitId));

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

  // TEMPORARY (#3029/#3194): the packaged react-ui DEFAULT kit is disabled while it's redefined via the
  // designer, so it seeds NOTHING — but the always-on `algo-viz` builtin (#3194) IS recovered into an
  // empty store. Restore the react-ui half to "empty store re-seeds every built-in" when the default returns.
  it.skipIf(DEFAULT_KIT_SEEDED)("hydrateComponents seeds ONLY the always-on builtins (base + viz) into an empty store while the default kit is disabled (#3194/#3242/#3451)", async () => {
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce([]);
    const pushC = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    const pushK = vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    // react-ui stays disabled (nothing of it seeds); the viz kits are appended + pushed (recover/shadow-proof).
    expect(useAppStore.getState().kits).toEqual(ALWAYS_ON_KITS);
    expect(useAppStore.getState().components).toEqual(ALWAYS_ON_COMPS);
    expect(pushK).toHaveBeenCalledTimes(ALWAYS_ON_KITS.length);
    expect(pushC).toHaveBeenCalledTimes(ALWAYS_ON_COMPS.length);
    expect(pushK).toHaveBeenCalledWith(expect.objectContaining({ id: ALGO_VIZ_KIT_ID }));
  });

  // TEMPORARY (#3029/#3194): the current default (react-ui) retires from an EXISTING store on the next
  // boot — its pristine built-ins left the seed, so the #2483 reconcile drops them — while the always-on
  // algo-viz builtin (#3194) survives. Remove the react-ui half when the default returns.
  it.skipIf(DEFAULT_KIT_SEEDED)("hydrateComponents retires the now-unseeded default built-ins but keeps the always-on kits (#3194/#3242/#3451)", async () => {
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce(SEED_COMPONENTS);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    const dropC = vi.spyOn(bridge, "dropComponent").mockResolvedValue(undefined);
    const dropK = vi.spyOn(bridge, "dropKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().kits).toEqual(ALWAYS_ON_KITS);
    expect(useAppStore.getState().components).toEqual(ALWAYS_ON_COMPS);
    expect(dropK).toHaveBeenCalledWith("react-ui");
    expect(dropC).toHaveBeenCalled();
  });

  it("hydrateComponents keeps a user record from the store and does NOT re-push it", async () => {
    const userComp = { ...SEED_COMPONENTS[0], id: "my-widget", name: "MyWidget", builtin: undefined };
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
  const button = SEED_COMPONENTS.find((c) => c.name === "Button")!;
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, kitUsage: [], kitDispatches: [], aiFocusedId: null });
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
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([...SEED_COMPONENTS.filter((c) => c.id !== button.id), edited]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    useAppStore.getState().setAiFocused(button.id, "component");
    await new Promise((r) => setTimeout(r, 25)); // let the async hydrate + diff settle
    const q = useAppStore.getState().kitDispatches;
    expect(q.length).toBeGreaterThan(0);
    expect(q[0].projectKey).toBe("p");
  });

  it("a ui-touch with NO contract change queues nothing (no noise on every touch)", async () => {
    useAppStore.setState({ kitUsage: [{ projectKey: "p", kitId: button.kitId }] });
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce(SEED_COMPONENTS);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    useAppStore.getState().setAiFocused("chip", "component");
    await new Promise((r) => setTimeout(r, 25));
    expect(useAppStore.getState().kitDispatches).toEqual([]);
  });
});

// TEMPORARY (#3029): the default kit is disabled, so hydrate reconciles against an EMPTY seed — this
// whole seed-refresh block is dormant until DEFAULT_KIT_SEEDED flips back on (it auto-restores).
describe.skipIf(!DEFAULT_KIT_SEEDED)("hash-based built-in seed refresh (#2483)", () => {
  beforeEach(() => {
    useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, seedNotices: [] });
    vi.restoreAllMocks();
  });

  it("replaces a stale unmodified built-in with the new seed copy and re-pushes it", async () => {
    const current = SEED_COMPONENTS.find((c) => c.id === "button")!;
    // Yesterday's pristine copy: different content, self-consistently stamped.
    const stale = stampSeedHash({ ...current, version: "0.0.1", seedHash: undefined });
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([...SEED_COMPONENTS.filter((c) => c.id !== "button"), stale]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    const pushC = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    const dropC = vi.spyOn(bridge, "dropComponent").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().components.find((c) => c.id === "button")).toEqual(current);
    expect(pushC).toHaveBeenCalledTimes(1);
    expect(pushC).toHaveBeenCalledWith(current);
    expect(dropC).not.toHaveBeenCalled();
    expect(useAppStore.getState().seedNotices).toEqual([]);
  });

  it("keeps a user-edited built-in (never clobbers) and surfaces the upstream update as a notice", async () => {
    const current = SEED_COMPONENTS.find((c) => c.id === "button")!;
    // The user edited an OLD copy: recorded baseline ≠ current content ≠ the new seed's hash.
    const edited = { ...current, srcText: "// customized", seedHash: "00000000" };
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([...SEED_COMPONENTS.filter((c) => c.id !== "button"), edited]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    const pushC = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().components.find((c) => c.id === "button")).toEqual(edited);
    expect(pushC).not.toHaveBeenCalled();
    expect(useAppStore.getState().seedNotices).toEqual([
      { kind: "updated-upstream", type: "component", id: "button", name: current.name },
    ]);
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
  const button = SEED_COMPONENTS.find((c) => c.name === "Button")!;
  beforeEach(() => {
    useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, kitUsage: [], kitDispatches: [] });
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
    useAppStore.setState({ kitUsage: [{ projectKey: "app-a", kitId: "react-ui", auto: true, live: false }] });
    useAppStore.getState().setComponent({ ...button, version: "3.0.0", props: button.props.filter((p) => p.name !== "size") });
    const d = useAppStore.getState().kitDispatches;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ projectKey: "app-a", kind: "assign" });
    expect(d[0].change.class).toBe("breaking");
  });

  it("an additive edit is notify-only, even for an opted-in live consumer", () => {
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    useAppStore.setState({ kitUsage: [{ projectKey: "app-a", kitId: "react-ui", auto: true, live: true }] });
    useAppStore.getState().setComponent({ ...button, version: "2.4.0", variants: [...button.variants, "loading"] });
    expect(useAppStore.getState().kitDispatches.every((x) => x.kind === "notify")).toBe(true);
  });

  it("a brand-new component is not a change (no dispatch)", () => {
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    useAppStore.setState({ kitUsage: [{ projectKey: "app-a", kitId: "react-ui", auto: true, live: false }] });
    useAppStore.getState().setComponent({ ...button, id: "brand-new", name: "BrandNew" });
    expect(useAppStore.getState().kitDispatches).toHaveLength(0);
  });

  it("the same change re-emitted dedups; dismiss drops the queued dispatch", () => {
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    useAppStore.setState({ kitUsage: [{ projectKey: "app-a", kitId: "react-ui", auto: true, live: false }] });
    const breaking = { ...button, version: "3.0.0", props: button.props.filter((p) => p.name !== "size") };
    useAppStore.getState().setComponent(breaking);
    useAppStore.setState({ components: SEED_COMPONENTS }); // reset the component so the SAME transition repeats
    useAppStore.getState().setComponent(breaking);
    expect(useAppStore.getState().kitDispatches).toHaveLength(1); // deduped by (projectKey, change.id)
    const { change } = useAppStore.getState().kitDispatches[0];
    useAppStore.getState().dismissKitDispatch("app-a", change.id);
    expect(useAppStore.getState().kitDispatches).toHaveLength(0);
  });
});
