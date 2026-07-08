import { describe, it, expect } from "vitest";
import { BUILTIN_PERSONAS, makeBuiltinPersonas, blankPersona, personaSlug, reconcilePersonas, type Persona } from "./persona";

describe("persona built-ins (#2094 / externalized #2185)", () => {
  it("every built-in references a real, distinct id and is flagged builtin", () => {
    const ids = BUILTIN_PERSONAS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);           // no dup ids
    expect(BUILTIN_PERSONAS.every((p) => p.builtin)).toBe(true);
    expect(BUILTIN_PERSONAS.some((p) => p.id === "persona-documentor" && p.role === "documentor")).toBe(true);
  });

  it("assembles the full packaged set from the @data/personas JSON, ordered", () => {
    const built = makeBuiltinPersonas();
    // The packaged personas are all present, one per role (documentor #1555, designer #2471) plus the
    // auditor persona (#2578 — a juror in a standing iteration loop) and the marketer (#2431).
    for (const id of [
      "persona-planner", "persona-worker", "persona-director", "persona-triage", "persona-reviewer",
      "persona-tester", "persona-issuer", "persona-juror", "persona-auditor", "persona-marketer", "persona-documentor", "persona-designer",
    ]) {
      expect(built.some((p) => p.id === id)).toBe(true);
    }
    // Ordered by each def's `order` field: planner leads, designer trails.
    expect(built[0]?.id).toBe("persona-planner");
    expect(built[built.length - 1]?.id).toBe("persona-designer");
    // `order`/`protocolFile` are load-time-only — they must not leak onto the assembled Persona.
    expect(built.every((p) => !("order" in p) && !("protocolFile" in p))).toBe(true);
  });

  it("the designer persona (#2471) rides the designer role and kicks off onto the bsc ui surface", () => {
    const designer = makeBuiltinPersonas().find((p) => p.id === "persona-designer")!;
    expect(designer.role).toBe("designer");
    expect(designer.builtin).toBe(true);
    // The start prompt IS the session kickoff (baked into the launch arg by useDesignerTerminal):
    // it must anchor the session to the bsc ui contract + CRUD and the deprecated alias.
    for (const needle of ["bsc ui", "bsc ui schema", "bsc ui validate", "bsc component", "composes"]) {
      expect(designer.startPrompt).toContain(needle);
    }
    // ...and teach the graduated bsc ui ladder (#2585): the discover verbs, the per-rung edit
    // verbs, and the default-to-the-highest-rung rule that makes the runtime design loop reachable.
    for (const needle of ["ladder", "highest rung", "bsc ui tokens", "bsc ui components", "set-token", "define-variant"]) {
      expect(designer.startPrompt).toContain(needle);
    }
  });

  it("the issuer persona (#2509) decomposes a modification into transformations at intake", () => {
    const issuer = makeBuiltinPersonas().find((p) => p.id === "persona-issuer")!;
    expect(issuer.role).toBe("issuer");
    // Runtime intake wiring: a modification decomposes into transformation rows via the plan.db CLI
    // (the uniform confirm queue), the user confirms, the issuer never confirms/routes/touches code.
    for (const needle of ["DECOMPOSE", "transformation", "bsc plan transformation add", "NEVER"]) {
      expect(issuer.startPrompt).toContain(needle);
    }
    // A net-new feature still becomes a single well-formed GitHub issue.
    expect(issuer.startPrompt).toContain("GitHub issue");
  });

  it("resolves the real fleet protocol prose into the worker/director start prompts", () => {
    const byId = new Map(makeBuiltinPersonas().map((p) => [p.id, p]));
    const worker = byId.get("persona-worker")!;
    const director = byId.get("persona-director")!;
    // Wired from @data/fleet/*-protocol.md (single source of truth), not the old empty placeholder.
    expect(worker.startPrompt).toContain("bsc-ask");
    expect(worker.startPrompt).toContain("MAINTENANCE");
    expect(director.startPrompt).toContain("bsc-answer");
    expect(director.startPrompt.length).toBeGreaterThan(200);
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

  it("an EMPTY saved startPrompt on a built-in inherits the packaged prose (the #2185 upgrade path)", () => {
    // Simulates an install seeded by an older app: worker persisted with an empty prompt. Reconcile
    // must NOT keep the empty string — it inherits the newly-wired fleet protocol prose.
    const persisted: Persona[] = [
      { id: "persona-worker", name: "Worker", blurb: "", role: "worker",
        startPrompt: "", skills: [], builtin: true },
    ];
    const worker = reconcilePersonas(persisted).find((p) => p.id === "persona-worker")!;
    expect(worker.startPrompt.trim().length).toBeGreaterThan(0);
    expect(worker.startPrompt).toContain("bsc-ask");
  });

  it("a built-in inherits a newly-packaged field the persisted copy predates (no masking)", () => {
    // worker.json is packaged with pooled:true. A copy seeded by an older app has no `pooled` key —
    // reconcile must NOT mask the packaged value with the absent field's undefined.
    const persisted: Persona[] = [
      { id: "persona-worker", name: "Worker", blurb: "", role: "worker", startPrompt: "x", skills: [], builtin: true },
    ];
    const worker = reconcilePersonas(persisted).find((p) => p.id === "persona-worker")!;
    expect(worker.pooled).toBe(true);
    // an EXPLICIT user value still wins over the package
    const off = reconcilePersonas([{ ...persisted[0], pooled: false }]).find((p) => p.id === "persona-worker")!;
    expect(off.pooled).toBe(false);
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
