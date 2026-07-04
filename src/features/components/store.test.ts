import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "@/store";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import * as bridge from "./lib/componentBridge";

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
