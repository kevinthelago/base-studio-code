// Unit tests for the per-project kit auto-dispatch toggle store action (#2277). The toggle gates the
// kit-change drain (useKitDispatch); it defaults OFF (notify-only) and persists per consumer project key.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";

describe("setAutoKitDispatch (#2277)", () => {
  beforeEach(() => {
    useAppStore.setState({ autoKitDispatch: {} });
  });

  it("defaults to OFF (absent ⇒ notify-only)", () => {
    expect(useAppStore.getState().autoKitDispatch["proj-a"]).toBeUndefined();
  });

  it("turns a project's toggle ON", () => {
    useAppStore.getState().setAutoKitDispatch("proj-a", true);
    expect(useAppStore.getState().autoKitDispatch["proj-a"]).toBe(true);
  });

  it("turning OFF drops the entry (keeps the map sparse)", () => {
    const { setAutoKitDispatch } = useAppStore.getState();
    setAutoKitDispatch("proj-a", true);
    setAutoKitDispatch("proj-a", false);
    expect(useAppStore.getState().autoKitDispatch["proj-a"]).toBeUndefined();
  });

  it("is per-project — flipping one leaves the others untouched", () => {
    const { setAutoKitDispatch } = useAppStore.getState();
    setAutoKitDispatch("proj-a", true);
    setAutoKitDispatch("proj-b", true);
    setAutoKitDispatch("proj-a", false);
    expect(useAppStore.getState().autoKitDispatch["proj-a"]).toBeUndefined();
    expect(useAppStore.getState().autoKitDispatch["proj-b"]).toBe(true);
  });
});
