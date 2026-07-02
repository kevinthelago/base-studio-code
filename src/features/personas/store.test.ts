import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { BUILTIN_PERSONAS } from "./lib/persona";

describe("personas store slice (#2094)", () => {
  beforeEach(() => {
    useAppStore.setState({ personas: BUILTIN_PERSONAS });
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
