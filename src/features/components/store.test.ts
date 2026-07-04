import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "@/store";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import * as bridge from "./lib/componentBridge";
import * as usageBridge from "./lib/kitUsageBridge";

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

  it("hydrateComponents reconciles + re-seeds a dropped built-in, pushing it back through the bridge", async () => {
    vi.spyOn(bridge, "loadComponents").mockResolvedValueOnce([]); // store empty → every built-in re-seeds
    vi.spyOn(bridge, "loadKits").mockResolvedValueOnce([]);
    const pushC = vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    const pushK = vi.spyOn(bridge, "pushKit").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().components.some((c) => c.id === "button" && c.builtin)).toBe(true);
    expect(pushC).toHaveBeenCalledWith(expect.objectContaining({ id: "button" }));
    expect(useAppStore.getState().kits.some((k) => k.id === "react-ui")).toBe(true);
    expect(pushK).toHaveBeenCalledWith(expect.objectContaining({ id: "react-ui" }));
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

  it("a breaking edit fans out to an opted-in dormant consumer as an issue", () => {
    vi.spyOn(bridge, "pushComponent").mockResolvedValue(undefined);
    useAppStore.setState({ kitUsage: [{ projectKey: "app-a", kitId: "react-ui", auto: true, live: false }] });
    useAppStore.getState().setComponent({ ...button, version: "3.0.0", props: button.props.filter((p) => p.name !== "size") });
    const d = useAppStore.getState().kitDispatches;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ projectKey: "app-a", kind: "issue" });
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
