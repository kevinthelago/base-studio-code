// Unit tests for the per-project auto-triage toggle store action (#2265). The toggle gates the
// runtime fault → routed fix loop; it defaults OFF (surface-only) and persists per project key.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";

describe("setAutoTriage (#2265)", () => {
  beforeEach(() => {
    useAppStore.setState({ autoTriage: {} });
  });

  it("defaults to OFF (absent ⇒ surface-only)", () => {
    expect(useAppStore.getState().autoTriage["proj-a"]).toBeUndefined();
  });

  it("turns a project's toggle ON", () => {
    useAppStore.getState().setAutoTriage("proj-a", true);
    expect(useAppStore.getState().autoTriage["proj-a"]).toBe(true);
  });

  it("turning OFF drops the entry (keeps the map sparse)", () => {
    const { setAutoTriage } = useAppStore.getState();
    setAutoTriage("proj-a", true);
    setAutoTriage("proj-a", false);
    expect(useAppStore.getState().autoTriage["proj-a"]).toBeUndefined();
  });

  it("is per-project — flipping one leaves the others untouched", () => {
    const { setAutoTriage } = useAppStore.getState();
    setAutoTriage("proj-a", true);
    setAutoTriage("proj-b", true);
    setAutoTriage("proj-a", false);
    expect(useAppStore.getState().autoTriage["proj-a"]).toBeUndefined();
    expect(useAppStore.getState().autoTriage["proj-b"]).toBe(true);
  });
});
