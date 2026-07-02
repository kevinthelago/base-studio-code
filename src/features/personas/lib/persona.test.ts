import { describe, it, expect } from "vitest";
import { BUILTIN_PERSONAS, blankPersona, personaSlug, reconcilePersonas, type Persona } from "./persona";

describe("persona built-ins (#2094)", () => {
  it("every built-in references a real, distinct id and is flagged builtin", () => {
    const ids = BUILTIN_PERSONAS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);           // no dup ids
    expect(BUILTIN_PERSONAS.every((p) => p.builtin)).toBe(true);
    expect(BUILTIN_PERSONAS.some((p) => p.id === "persona-documentor" && p.role === "reviewer")).toBe(true);
  });
});

describe("personaSlug", () => {
  it("slugifies and never yields empty", () => {
    expect(personaSlug("Doc Writer!")).toBe("doc-writer");
    expect(personaSlug("  ")).toBe("persona");
    expect(personaSlug("A/B  C")).toBe("a-b-c");
  });
});

describe("blankPersona", () => {
  it("seeds an editable (non-builtin) persona on the given role", () => {
    const p = blankPersona("persona-x", "worker");
    expect(p).toMatchObject({ id: "persona-x", role: "worker", skills: [], startPrompt: "" });
    expect(p.builtin).toBeUndefined();
  });
});

describe("reconcilePersonas (#2094)", () => {
  it("seeds all built-ins from an empty persisted set", () => {
    const out = reconcilePersonas([]);
    expect(out.length).toBe(BUILTIN_PERSONAS.length);
    expect(out.every((p) => p.builtin)).toBe(true);
  });

  it("preserves user edits to a built-in but restores its builtin identity", () => {
    // A persisted built-in the user renamed + (maliciously or via stale state) marked non-builtin.
    const persisted: Persona[] = [
      { id: "persona-worker", name: "My Worker", blurb: "custom", role: "worker",
        startPrompt: "edited", skills: ["s1"], builtin: false },
    ];
    const out = reconcilePersonas(persisted);
    const worker = out.find((p) => p.id === "persona-worker")!;
    expect(worker.name).toBe("My Worker");        // edit kept
    expect(worker.startPrompt).toBe("edited");    // edit kept
    expect(worker.skills).toEqual(["s1"]);        // edit kept
    expect(worker.builtin).toBe(true);            // identity restored — cannot become deletable
  });

  it("re-seeds a built-in the persisted set dropped", () => {
    const persisted = BUILTIN_PERSONAS.filter((p) => p.id !== "persona-juror");
    const out = reconcilePersonas(persisted);
    expect(out.some((p) => p.id === "persona-juror" && p.builtin)).toBe(true);
  });

  it("keeps user-authored personas as non-builtin", () => {
    const persisted: Persona[] = [
      { id: "persona-mine", name: "Mine", blurb: "", role: "reviewer", startPrompt: "", skills: [] },
    ];
    const out = reconcilePersonas(persisted);
    const mine = out.find((p) => p.id === "persona-mine")!;
    expect(mine).toBeTruthy();
    expect(mine.builtin).toBe(false);
  });
});
