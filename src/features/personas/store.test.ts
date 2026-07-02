import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "@/store";
import { BUILTIN_PERSONAS } from "./lib/persona";
import * as bridge from "./lib/personaBridge";

describe("personas store slice (#2094)", () => {
  beforeEach(() => {
    useAppStore.setState({ personas: BUILTIN_PERSONAS });
  });

  it("hydratePersonas keeps the seeded set when the bridge is unreachable", async () => {
    vi.spyOn(bridge, "loadPersonas").mockResolvedValueOnce(null);
    useAppStore.setState({ personas: BUILTIN_PERSONAS });
    await useAppStore.getState().hydratePersonas();
    expect(useAppStore.getState().personas).toEqual(BUILTIN_PERSONAS);
  });

  it("hydratePersonas reconciles the loaded set + re-seeds a dropped built-in", async () => {
    // The store returns only a subset (juror dropped) + a user persona.
    const loaded = BUILTIN_PERSONAS.filter((p) => p.id !== "persona-juror").concat({
      id: "persona-mine", name: "Mine", blurb: "", role: "reviewer" as const, startPrompt: "", skills: [],
    });
    vi.spyOn(bridge, "loadPersonas").mockResolvedValueOnce(loaded);
    const push = vi.spyOn(bridge, "pushPersona").mockResolvedValue(undefined);
    await useAppStore.getState().hydratePersonas();
    const personas = useAppStore.getState().personas;
    expect(personas.some((p) => p.id === "persona-juror" && p.builtin)).toBe(true); // re-seeded
    expect(personas.some((p) => p.id === "persona-mine" && !p.builtin)).toBe(true); // user kept
    // The re-seeded built-in (absent from the loaded set) is pushed back to the store.
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ id: "persona-juror" }));
  });

  it("addPersona appends an editable persona and returns its id", () => {
    const before = useAppStore.getState().personas.length;
    const id = useAppStore.getState().addPersona("worker");
    const personas = useAppStore.getState().personas;
    expect(personas.length).toBe(before + 1);
    const p = personas.find((x) => x.id === id)!;
    expect(p.role).toBe("worker");
    expect(p.builtin).toBeUndefined();
  });

  it("addPersona mints collision-free ids", () => {
    const a = useAppStore.getState().addPersona();
    const b = useAppStore.getState().addPersona();
    expect(a).not.toBe(b);
  });

  it("clonePersona copies a built-in into a new editable persona", () => {
    const id = useAppStore.getState().clonePersona("persona-juror");
    const clone = useAppStore.getState().personas.find((p) => p.id === id)!;
    expect(clone.role).toBe("juror");            // carried from the source
    expect(clone.builtin).toBe(false);           // clone is user-owned
    expect(clone.name).toMatch(/copy/i);
  });

  it("updatePersona patches fields but keeps builtin identity", () => {
    useAppStore.getState().updatePersona("persona-worker", { name: "Hacked", role: "reviewer" });
    const worker = useAppStore.getState().personas.find((p) => p.id === "persona-worker")!;
    expect(worker.name).toBe("Hacked");
    expect(worker.role).toBe("reviewer");        // a built-in's editable fields still patch
    expect(worker.builtin).toBe(true);           // builtin identity preserved (not in the patch type)
  });

  it("applyPersonaToPane stamps role + start prompt + model and marks perms stale", () => {
    useAppStore.setState({ paneRoles: {}, paneModels: {}, paneStartupPromptText: {}, panePermsStale: {} });
    // Documentor: role reviewer + a real start prompt, no model override.
    useAppStore.getState().applyPersonaToPane("t0p0", "persona-documentor");
    const st = useAppStore.getState();
    expect(st.paneRoles["t0p0"]).toBe("reviewer");
    expect(st.paneStartupPromptText["t0p0"]).toMatch(/documentor/i);
    expect(st.panePermsStale["t0p0"]).toBe(true);
    expect(st.paneModels["t0p0"]).toBeUndefined();   // documentor has no model override
  });

  it("applyPersonaToPane is a no-op for an unknown persona id", () => {
    useAppStore.setState({ paneRoles: {}, panePermsStale: {} });
    useAppStore.getState().applyPersonaToPane("t0p0", "persona-nope");
    expect(useAppStore.getState().paneRoles["t0p0"]).toBeUndefined();
    expect(useAppStore.getState().panePermsStale["t0p0"]).toBeUndefined();
  });

  it("removePersona deletes a user persona but NOT a built-in", () => {
    const id = useAppStore.getState().addPersona();
    useAppStore.getState().removePersona(id);
    expect(useAppStore.getState().personas.some((p) => p.id === id)).toBe(false);
    // Built-in is a no-op.
    const n = useAppStore.getState().personas.length;
    useAppStore.getState().removePersona("persona-worker");
    expect(useAppStore.getState().personas.length).toBe(n);
    expect(useAppStore.getState().personas.some((p) => p.id === "persona-worker")).toBe(true);
  });
});
