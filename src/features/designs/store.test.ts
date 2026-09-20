import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "@/store";
import type { ComponentRecord, Kit } from "@/features/designs/lib/model";
import type { Dispatch } from "@/features/designs/lib/propagation";
import { makeChange } from "@/features/designs/lib/propagation";
import { contractChanged, mergeDispatches, foldTouches, AI_RING_MAX, AI_HYDRATE_DEBOUNCE_MS, type AiTouch } from "./store";
import { SEED_COMPONENTS, SEED_KITS, BASE_STUDIO_CODE_KIT_ID } from "./lib/seed";
import { APP_RECONCILE_WRITER } from "./lib/componentBridge";
import { SEED_THEMES, type KitThemeRecord } from "@/features/designs/lib/themes";
import { stampSeedHash } from "@/features/designs/lib/seedRefresh";
import * as bridge from "./lib/componentBridge";
import * as themeBridge from "@/features/designs/lib/themeBridge";
import * as usageBridge from "@/features/designs/lib/kitUsageBridge";
import * as kitStoreRead from "@/features/designs/lib/kitStoreRead";
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
    // #98: a converge push is the app's OWN background write — tagged `app-reconcile` (2nd arg to
    // `pushKit`) so `bsc components log` can tell it apart from a write some other session made.
    expect(pushK).toHaveBeenCalledWith(expect.objectContaining({ id: BASE_STUDIO_CODE_KIT_ID }), APP_RECONCILE_WRITER);
    // Each packaged component is pushed through the bridge too (recover/shadow-proof, same as the kit).
    expect(pushC).toHaveBeenCalledTimes(SEED_COMPONENTS.length);
    for (const [, opts] of pushC.mock.calls) expect(opts?.by).toBe(APP_RECONCILE_WRITER);
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

  it("skips the LITE fast path on a re-hydrate, so pages are not remounted", async () => {
    // #the-fast-paint-phase-remounts-every-page-on-every-rehydrate. Phase 1 blanks srcText (the lite
    // projection carries none). On a re-hydrate that sends every GraphComponent real -> "" -> real,
    // which drops each page to its fallback (unmounting its subtree) and recompiles it. The console
    // page holds the terminal, so the user loses focus mid-keystroke — reported live, and visible in
    // the log as `compile #2 "consolepage"` firing minutes from any page load.
    useAppStore.setState({ components: [{ ...FIXTURE_BUTTON }] } as never); // a FULL record already held
    const lite = vi.spyOn(bridge, "loadComponentsGraph").mockResolvedValue([]);
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([FIXTURE_BUTTON]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);

    await useAppStore.getState().hydrateComponents();
    expect(lite, "a warm store must not re-read the lite projection").not.toHaveBeenCalled();
  });

  it("still TAKES the lite fast path on a cold store — the paint win is kept", async () => {
    // The optimisation is worth keeping where it pays: `--full` is 1.72MB and measured up to 8s.
    useAppStore.setState({ components: [] } as never);
    const lite = vi.spyOn(bridge, "loadComponentsGraph").mockResolvedValue([{ ...FIXTURE_BUTTON, lite: true }] as never);
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([FIXTURE_BUTTON]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);

    await useAppStore.getState().hydrateComponents();
    expect(lite).toHaveBeenCalledTimes(1);
  });

  it("guards every converge push with the rev it READ (#a-stale-app-copy-overwrites-a-designer-edit)", async () => {
    // The converge writes records the app did not author, from the snapshot taken at the top of
    // `hydrateComponents` — so anything written to the store between that read and the push is
    // destroyed. That is what happened to a designer's `srcText` fix: read pre-edit, edited out of
    // band, converged back 23 minutes later with no notice.
    //
    // Every push must name the rev THIS load saw, so a store that has moved refuses the write.
    // A stored copy that is PRISTINE against its own (older) stamp while the packaged seed has moved on
    // — the REFRESH verdict, which is the branch that pushes. Re-stamping an altered body is what makes
    // it self-consistent-but-older; a merely stale stamp would read as "modified" and be KEPT instead.
    const seedComp = SEED_COMPONENTS[0];
    expect(seedComp, "the packaged component seed must be non-empty for this to exercise a push").toBeTruthy();
    const stored = stampSeedHash({ ...seedComp, srcText: "OLDER BODY", rev: 7 });
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([stored]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    const pushC = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();

    const guarded = pushC.mock.calls.filter(([c]) => c.id === stored.id);
    expect(guarded.length, "the REFRESH verdict must actually push — otherwise this asserts nothing").toBeGreaterThan(0);
    for (const [, opts] of guarded) {
      expect(opts?.ifVersion, `a push of ${stored.id} must carry the rev the load saw`).toBe(7);
    }
    // A record the store did NOT hold has no prior rev to name — it is written unguarded, as before.
    for (const [c, opts] of pushC.mock.calls) {
      if (c.id !== stored.id) expect(opts?.ifVersion).toBeUndefined();
    }
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
    // A `ui-focus` (bsc components get / preview-props): drive the preview, but do NOT refetch the library —
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

describe("the activity RING + in-kit focus (#auto-focus-in-kit-and-drop-the-activity-pills)", () => {
  const realHydrateComponents = useAppStore.getState().hydrateComponents;
  /** A touch stamped `now`, so it is inside the follow window unless a test says otherwise. */
  const t = (id: string, kitId?: string, over: Partial<AiTouch> = {}): AiTouch =>
    ({ kind: "touch", collection: "component", id, kitId, pane: "design-studio:designer", at: Date.now(), ...over });

  beforeEach(() => {
    useAppStore.setState({
      components: SEED_COMPONENTS, kits: SEED_KITS,
      aiFocusedId: null, aiTouches: [], designsKitId: "", designsCompId: null,
    });
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ hydrateComponents: realHydrateComponents });
  });

  describe("foldTouches", () => {
    it("prepends newest-first and caps the ring", () => {
      // `fresh` arrives oldest-first (log order); the ring reads newest-first (display order).
      expect(foldTouches([t("old")], [t("a"), t("b")]).map((x) => x.id)).toEqual(["b", "a", "old"]);
      const many = Array.from({ length: AI_RING_MAX + 4 }, (_, i) => t(`c${i}`));
      expect(foldTouches([], many)).toHaveLength(AI_RING_MAX);
    });
  });

  it("focuses an IN-KIT touch even with a component selected — a brief focus is the point, not a disruption", () => {
    // The old behaviour suppressed this whenever anything was selected and then added a chip strip to
    // recover the signal. Focusing the node that was just written is what was wanted all along.
    useAppStore.setState({ designsKitId: "base-studio-code", designsCompId: "settings-security" });
    useAppStore.getState().pushAiTouches([t("chip", "base-studio-code")], { hydrate: false });
    expect(useAppStore.getState().aiFocusedId).toBe("chip");
    expect(useAppStore.getState().designsCompId).toBe("settings-security"); // the SELECTION is still not disturbed
  });

  it("IGNORES a cross-kit touch without blanking the focus — the original blank-page defect", () => {
    // This is the regression that matters. Writing an out-of-kit id to `aiFocusedId` is what emptied the
    // page: the Studio filters the pulse, the pan AND the Inspector subject by kit, so `aiComp` went
    // null. Measured over 200 touches the fleet spanned three kits, so it was the COMMON case, not an
    // edge one. Ignoring must therefore mean NOT WRITING it — the previous subject stays on screen.
    useAppStore.setState({ designsKitId: "base-studio-code", designsCompId: null, aiFocusedId: "chip" });
    useAppStore.getState().pushAiTouches([t("workercard", "mobile-studio-code")], { hydrate: false });
    expect(useAppStore.getState().designsKitId).toBe("base-studio-code"); // no kit switch
    expect(useAppStore.getState().aiFocusedId).toBe("chip");              // NOT moved, and NOT nulled
    expect(useAppStore.getState().aiTouches.map((x) => x.id)).toEqual(["workercard"]); // still in the ring
  });

  it("focuses an in-kit touch regardless of AGE — the kit is the only condition", () => {
    // An age cut-off was considered and deliberately not added: the priming tick already focused the
    // newest historical touch before this change, and focusing the most recent work when the Studio
    // opens is reasonable. Pinned so the omission reads as a decision rather than an oversight.
    useAppStore.setState({ designsKitId: "base-studio-code", aiFocusedId: null });
    const old = t("chip", "base-studio-code", { at: Date.now() - 3_600_000 });
    useAppStore.getState().pushAiTouches([old], { hydrate: false });
    expect(useAppStore.getState().aiFocusedId).toBe("chip");
  });

  it("falls back to the STORE for a legacy line that carries no kit", () => {
    // A 5-column line predates the kitId column, so the kit can only come from the record itself.
    const known = SEED_COMPONENTS[0];
    useAppStore.setState({ designsKitId: known.kitId });
    useAppStore.getState().pushAiTouches([t(known.id)], { hydrate: false }); // no kitId on the touch
    expect(useAppStore.getState().aiFocusedId).toBe(known.id);
  });

  it("coalesces a BURST of writes into exactly ONE hydrate", async () => {
    // Every touch used to reload + reconcile + re-diff the whole ~590-record library. Under a live
    // fleet that ran several times a minute, and it is what made the Studio jank while working.
    vi.useFakeTimers();
    const hydrateComponents = vi.fn();
    useAppStore.setState({ hydrateComponents });
    const burst = ["a", "b", "c", "d"].map((id) => t(id, "base-studio-code"));
    useAppStore.getState().pushAiTouches(burst);
    expect(hydrateComponents).not.toHaveBeenCalled();          // nothing fires inside the window
    vi.advanceTimersByTime(AI_HYDRATE_DEBOUNCE_MS + 10);
    expect(hydrateComponents).toHaveBeenCalledTimes(1);        // ONE reload for four writes
  });

  it("a READ-focus batch schedules no hydrate at all (#3545 — nothing changed to reload)", () => {
    vi.useFakeTimers();
    const hydrateComponents = vi.fn();
    useAppStore.setState({ hydrateComponents });
    useAppStore.getState().pushAiTouches([t("chip", "base-studio-code", { kind: "focus" })]);
    vi.advanceTimersByTime(AI_HYDRATE_DEBOUNCE_MS + 10);
    expect(hydrateComponents).not.toHaveBeenCalled();
  });

  it("accepts a touch whose record is GONE — a retired id from `bsc components merge` (#3725 tombstone)", () => {
    // `bsc components merge`/`suppress` emit activity for the RETIRED id, and 3 of the last 200 real touches
    // were exactly that. It is real work and must show; it simply resolves to no record and no kit.
    // The id must genuinely resolve to NOTHING or this tests the wrong thing. The previous version used
    // `windowcontrols`, which is a real record — it passed only because its kit assertion was trivially
    // true, so the tombstone path was never exercised at all. Assert the premise rather than assume it.
    const retired = "retired-by-merge-zzz";
    expect(useAppStore.getState().components.some((c) => c.id === retired)).toBe(false);

    useAppStore.setState({ designsKitId: "base-studio-code", aiFocusedId: "chip" });
    useAppStore.getState().pushAiTouches([t(retired)], { hydrate: false });
    expect(useAppStore.getState().aiTouches.map((x) => x.id)).toEqual([retired]);
    expect(useAppStore.getState().designsKitId).toBe("base-studio-code"); // nothing to switch to
    // A retired id resolves to no record and therefore no kit, so it must not take the focus either —
    // focusing an id the graph does not contain empties the Inspector exactly like a cross-kit one.
    expect(useAppStore.getState().aiFocusedId).toBe("chip");
  });

  it("setAiFocused(null) empties the RING too, so a finished session stops reading as live", () => {
    useAppStore.getState().pushAiTouches([t("chip", "base-studio-code")], { hydrate: false });
    useAppStore.getState().setAiFocused(null);
    expect(useAppStore.getState().aiTouches).toEqual([]);
    expect(useAppStore.getState().aiFocusedId).toBeNull();
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

  // THE FIXTURE IDS MUST NOT EXIST IN THE REAL SEED. Both tests below build their stale store as
  // `[...SEED_COMPONENTS, ...staleComps]`, and the reconcile keys by id — so a fixture reusing a
  // REAL component id collapses into it, and the retirement the test means to exercise silently
  // never happens. That is not hypothetical: these fixtures were named `personaspanel` /
  // `agentsboard` / `personastore`, and the records migration promoted `PersonasPanel.tsx` into the
  // base kit under exactly that id, at which point the drop assertion started reporting the NEXT
  // component instead. The ids are `examples-`-prefixed now, and this guard is what keeps them free.
  it("the retired-kit fixture ids are absent from the real seed (#2506)", () => {
    const seeded = new Set(SEED_COMPONENTS.map((c) => c.id));
    for (const id of ["examples-personaspanel", "examples-agentsboard", "examples-personastore"])
      expect(seeded.has(id)).toBe(false);
  });

  it("boot hydrate DELETES the retired examples kit + its components from a stale store (#2506)", async () => {
    // The mechanism that cleans every existing install: #2506 removed `examples` from the packaged
    // seed, so the #2483 reconcile must reach the DELETE verdict for the pristine stored copies and
    // converge the global store through the bridge drops — no manual cleanup.
    const staleComps = [
      exampleComp("examples-personaspanel", "PersonasPanel", "page", ["PersonaStore"]),
      exampleComp("examples-agentsboard", "AgentsBoard", "page"),
      exampleComp("examples-personastore", "PersonaStore", "service"),
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
    const edited = { ...exampleComp("examples-personaspanel", "PersonasPanel", "page"), srcText: "// my tweaks" };
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([...SEED_COMPONENTS, edited]);
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce(SEED_KITS);
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    const dropC = vi.spyOn(bridge, "dropComponent").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().components.find((c) => c.id === "examples-personaspanel")).toEqual(edited);
    expect(dropC).not.toHaveBeenCalled();
    expect(useAppStore.getState().seedNotices).toEqual([
      { kind: "orphaned", type: "component", id: "examples-personaspanel", name: "PersonasPanel" },
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
    useAppStore.setState({ kitUsage: [], kitUsageUnread: false });
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

  it("hydrateKitUsage replaces from the store, keeps the cache when the read could not RUN, and SAYS SO", async () => {
    // `the-kit-cluster-folds-into-bsc-ui`: keeping the cache was already right, but it was SILENT — the
    // renderer could not tell a stale cache from what the store holds. `kitUsageUnread` is that
    // difference, and it matters because a consumer count of 0 read off a failed hydrate says "this kit
    // is unused", which is the input someone acts on to retire a kit.
    useAppStore.setState({ kitUsage: [{ projectKey: "cached", kitId: "react-ui" }], kitUsageUnread: false });
    vi.spyOn(kitStoreRead, "readKitUsage").mockResolvedValueOnce(null); // the read could not happen
    await useAppStore.getState().hydrateKitUsage();
    expect(useAppStore.getState().kitUsage).toEqual([{ projectKey: "cached", kitId: "react-ui" }]);
    expect(useAppStore.getState().kitUsageUnread).toBe(true);

    const edges = [{ projectKey: "m", kitId: "spring-kotlin" }];
    vi.spyOn(kitStoreRead, "readKitUsage").mockResolvedValueOnce({ edges });
    await useAppStore.getState().hydrateKitUsage();
    expect(useAppStore.getState().kitUsage).toEqual(edges);
    expect(useAppStore.getState().kitUsageUnread).toBe(false); // a successful read CLEARS the flag
  });

  it("a store that ANSWERED with no edges replaces the cache — a real empty is not an unreadable one", async () => {
    // The other side of the same distinction. `[]` from a live store is a FACT and must overwrite a
    // stale cache; only `null` may preserve it. Collapsing the two is what made the old reader unable
    // to report anything but "keep whatever you had".
    useAppStore.setState({ kitUsage: [{ projectKey: "cached", kitId: "react-ui" }], kitUsageUnread: true });
    vi.spyOn(kitStoreRead, "readKitUsage").mockResolvedValueOnce({ edges: [] });
    await useAppStore.getState().hydrateKitUsage();
    expect(useAppStore.getState().kitUsage).toEqual([]);
    expect(useAppStore.getState().kitUsageUnread).toBe(false);
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

  it("stamps a PAGE like any other record — nothing is seed-authoritative any more", async () => {
    // THIS CASE ASSERTED THE OPPOSITE UNTIL `a5ee053b`, and the reversal was deliberate. #3723 made a
    // page `seedAuthoritative`, force-resetting its store copy to the seed — and `planRestamp` deferred
    // pages precisely because of that: stamping one would have handed the seed authority over what the
    // app renders. `a5ee053b` ("store always wins — the seed is a starting point, not an authority")
    // removed the predicate, because the force-reset "silently deleted the moved tests from
    // consolepage/projectspage seconds after they were written".
    //
    // With nothing force-resetting a page there is nothing to defer, so stamping one is a PROVENANCE
    // repair rather than a content swap. No caller passes `seedAuthoritative` anywhere in src/ —
    // AppBanners says so twice, and `deferred` is structurally always 0.
    //
    // Kept rather than deleted: this is the seam where a reintroduced seed authority would show up. If
    // this case ever fails again, check whether a `seedAuthoritative` predicate came back BEFORE
    // changing the expectation — restoring the deferral without restoring the force-reset would defer
    // repairs for a danger that no longer exists.
    vi.spyOn(bridge, "loadComponents").mockResolvedValue([unstamped(seedPage)]);
    vi.spyOn(bridge, "loadKits").mockResolvedValue(null);
    const stamp = vi.spyOn(bridge, "stampComponent").mockResolvedValue(undefined);

    const r = await useAppStore.getState().restampUnstamped();

    expect(r).toEqual({ stamped: 1, deferred: 0 });
    // …and it carries the SEED's hash, not the record's own — the subtle half of #4207. Stamped with its
    // own hash the record would read as pristine-but-stale, which is the REFRESH verdict, and the seed
    // copy would replace the store copy on the very next hydrate.
    expect(stamp).toHaveBeenCalledWith(seedPage.id, seedPage.seedHash);
  });

  it("is a no-op when the bridge is unreachable — nothing to repair against", async () => {
    vi.spyOn(bridge, "loadComponents").mockResolvedValue(null);
    const stamp = vi.spyOn(bridge, "stampComponent").mockResolvedValue(undefined);

    expect(await useAppStore.getState().restampUnstamped()).toEqual({ stamped: 0, deferred: 0 });
    expect(stamp).not.toHaveBeenCalled();
  });
});
