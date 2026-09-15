import { describe, it, expect } from "vitest";
import { BUILTIN_PERSONAS, makeBuiltinPersonas, blankPersona, personaSlug, reconcilePersonas, proseFingerprint, type Persona } from "@/features/personas/lib/persona";
import architectProtocolMd from "@data/fleet/architect-protocol.md?raw";

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
    // auditor persona (#2578 — a juror in a standing iteration loop), the marketer (#2431), the team
    // architect (#2755 — the Teams Studio's teams/personas authoring session), and the knowledge
    // librarian (#2787 — the Algorithms tab's knowledge-store session).
    for (const id of [
      "persona-planner", "persona-worker", "persona-director", "persona-triage", "persona-reviewer",
      "persona-tester", "persona-issuer", "persona-juror", "persona-auditor", "persona-marketer", "persona-documentor", "persona-designer", "persona-architect", "persona-librarian", "persona-surface-operator", "persona-lexicographer", "persona-tutor", "persona-debugger",
    ]) {
      expect(built.some((p) => p.id === id)).toBe(true);
    }
    // Ordered by each def's `order` field: planner leads, the debugger trails (order 13, after the librarian #3322).
    expect(built[0]?.id).toBe("persona-planner");
    expect(built[built.length - 1]?.id).toBe("persona-debugger");
    // `order`/`protocolFile` are load-time-only — they must not leak onto the assembled Persona.
    expect(built.every((p) => !("order" in p) && !("protocolFile" in p))).toBe(true);
  });

  it("the architect persona is the funnel's front door, drawn from the architect protocol", () => {
    const architect = makeBuiltinPersonas().find((p) => p.id === "persona-architect")!;
    expect(architect.role).toBe("architect");
    expect(architect.builtin).toBe(true);
    // #funnel-architect-front-door — the prompt is no longer authored on the def; it resolves from
    // `fleet/architect-protocol.md` (the same overlay-able source the worker/director draw from), so
    // there is ONE architect prose and the persona cannot drift from it.
    expect(architect.startPrompt).toBe(architectProtocolMd.trim());
    // The two halves it owns, and the fact that discovery is worked one topic at a time — everything
    // below the architect runs unattended, so a half-settled topic has nobody to ask.
    for (const needle of ["DISCOVERY", "AUTHORITY", "one topic at a time"]) {
      expect(architect.startPrompt).toContain(needle);
    }
    // Exactly one write surface and exactly one outbound channel — and the channel reaches DIRECTORS
    // only (the tier constraint `briefInjections` enforces at the other end).
    for (const needle of ["bsc plan requirement set", "bsc plan brief", "director"]) {
      expect(architect.startPrompt).toContain(needle);
    }
    // Team authoring is still reachable here until it moves to the director, so the Teams Studio
    // session (STUDIO_SESSIONS.architect, which launches on this persona) keeps its surface.
    for (const needle of ["bsc teams list", "bsc persona list"]) {
      expect(architect.startPrompt).toContain(needle);
    }
  });

  it("tells the architect to check a brief will LAND before sending it (#the-architect-cannot-see-a-stopped-director)", () => {
    const architect = makeBuiltinPersonas().find((p) => p.id === "persona-architect")!;
    // `bsc plan brief` is the architect's only outbound channel, and a brief to a director that is
    // not running is written into a session nobody reads — it goes quietly missing. The protocol has
    // to name the check, because nothing else will tell the architect the brief was lost.
    expect(architect.startPrompt).toContain("bsc fleet directors");
    // All four states, spelled as the command prints them — an architect matching prose to output is
    // how a state gets acted on.
    for (const state of ["running", "idle", "stopped", "never-launched"]) {
      expect(architect.startPrompt).toContain(state);
    }
    // And the boundary: only a running director reads a brief, and starting one is the USER's act —
    // the architect has no verb for it and must not imply otherwise.
    expect(architect.startPrompt).toMatch(/Only `running` reads you/);
  });

  it("the designer persona (#2471) rides the designer role and kicks off onto the bsc ui surface", () => {
    const designer = makeBuiltinPersonas().find((p) => p.id === "persona-designer")!;
    expect(designer.role).toBe("designer");
    expect(designer.builtin).toBe(true);
    // The start prompt IS the session kickoff (baked into the launch arg by useDesignerTerminal):
    // it must anchor the session to the bsc ui contract + CRUD.
    for (const needle of ["bsc ui", "bsc ui schema", "bsc ui validate", "composes"]) {
      expect(designer.startPrompt).toContain(needle);
    }
    // ...and teach the graduated bsc ui ladder (#2585): the discover verbs, the per-rung edit
    // verbs, and the default-to-the-highest-rung rule that makes the runtime design loop reachable.
    for (const needle of ["ladder", "highest rung", "bsc ui tokens", "bsc ui components", "set-token", "define-variant"]) {
      expect(designer.startPrompt).toContain(needle);
    }
    // ...and, on a bsc ui wall, file a request for the debug session instead of asking for out-of-surface
    // permissions (#3300 — the designer→debug channel), grounded in the failing command.
    for (const needle of ["bsc request new", "bsc request list --open", "FAILING COMMAND"]) {
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

  it("owns logging/perf as part of its own glob, not a separate stream's job (#172)", () => {
    // Director hit the persona-write role gate filing bsc request 172: the worker protocol was
    // missing an explicit statement that instrumentation/perf watching belongs to whoever owns the
    // glob, not a hand-off to the `logs` stream. Fixed at the packaged SOURCE — worker-protocol.md +
    // worker.json's `responsibilities` — rather than the live store, so it reaches every install and
    // survives `reconcilePersonas` rather than the CLI-set edit that got silently reverted first.
    const worker = makeBuiltinPersonas().find((p) => p.id === "persona-worker")!;
    const needle = "Logging and performance are part of what you own, not a separate stream's job.";
    const anchor = "Build against the planned contracts, in parallel — do NOT wait on another stream.";
    expect(worker.startPrompt).toContain(needle);
    expect(worker.startPrompt).toContain(anchor);
    // The section must land BEFORE the "build against contracts" anchor named in the request.
    expect(worker.startPrompt.indexOf(needle)).toBeLessThan(worker.startPrompt.indexOf(anchor));
    expect(worker.startPrompt).toContain("bsc logs");

    expect(worker.responsibilities?.[1]).toBe(
      "Instrument and watch your owned glob's logging and performance, not just its correctness",
    );
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
    // SEALED, because that is what a record written by this app now looks like: the seal is what says
    // "the prose diverged from packaged deliberately". See the bootstrap test below for the unsealed
    // case, which is the pre-seal upgrade and behaves differently on purpose.
    const persisted: Persona[] = [
      { id: "persona-worker", name: "My Worker", blurb: "custom", role: "worker",
        startPrompt: "edited", skills: ["s1"], builtin: false,
        proseSeal: { startPrompt: "deadbeef", blurb: "deadbeef", responsibilities: "deadbeef" } },
    ];
    const out = reconcilePersonas(persisted);
    const worker = out.find((p) => p.id === "persona-worker")!;
    expect(worker.name).toBe("My Worker");        // edit kept
    expect(worker.startPrompt).toBe("edited");    // edit kept
    expect(worker.blurb).toBe("custom");          // edit kept
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

// ── The prose seal ──────────────────────────────────────────────────────────────────────────────
//
// THE BUG IT FIXES. A packaged persona's prose was unreachable once seeded: the merge preferred the
// persisted value for every field except an EMPTY `startPrompt`. So when discovery was moved onto the
// architect and its packaged protocol was rewritten to say so, every already-seeded store kept serving
// the old teams-only prompt — the one that tells it to refuse anything but teams and personas and to
// send the user to a planner that no longer exists. Its POWERS moved (those are computed from the
// packaged JSON, not the store) and its instructions did not, so the session held the funnel's
// capability and the previous job's charter. Measured on a real store: the architect was the ONLY
// built-in whose prose diverged from packaged — director and worker both carried theirs.
describe("reconcilePersonas — packaged prose reaches an already-seeded store", () => {
  const packagedArchitect = () => BUILTIN_PERSONAS.find((p) => p.id === "persona-architect")!;

  /** A persisted built-in as an OLDER app wrote it: real prose, no seal. */
  const unsealed = (over: Partial<Persona> = {}): Persona => ({
    id: "persona-architect", name: "Team architect", blurb: "the old teams-only blurb",
    role: "architect", startPrompt: "You are the team architect — teams and personas only.",
    skills: [], builtin: true, ...over,
  });

  it("re-seeds a stale unsealed built-in — the architect gets its funnel protocol", () => {
    const out = reconcilePersonas([unsealed()]).find((p) => p.id === "persona-architect")!;
    expect(out.startPrompt).toBe(packagedArchitect().startPrompt);
    expect(out.startPrompt).toContain("tier 1 of the funnel");
    expect(out.blurb).toBe(packagedArchitect().blurb);
  });

  it("keeps the displaced prose recoverable rather than destroying it", () => {
    // The one-time bootstrap is the only thing that can displace text the app did not write, so it is
    // the only thing that records a replacement. Nothing reads this; it exists so an upgrade the user
    // did not ask for cannot be a deletion.
    const out = reconcilePersonas([unsealed()]).find((p) => p.id === "persona-architect")!;
    expect(out.replacedProse?.startPrompt).toContain("teams and personas only");
    expect(out.replacedProse?.blurb).toBe("the old teams-only blurb");
  });

  it("NEVER clobbers a sealed edit, however many times a packaged bump lands", () => {
    // The promise from the seal forward: once a record has been through reconcile, a prose value that
    // no longer fingerprints as what we wrote is the user's, permanently.
    const edited = unsealed({ startPrompt: "MY OWN PROMPT", proseSeal: { startPrompt: "0000dead" } });
    let out = reconcilePersonas([edited]).find((p) => p.id === "persona-architect")!;
    expect(out.startPrompt).toBe("MY OWN PROMPT");
    expect(out.replacedProse?.startPrompt).toBeUndefined();   // nothing was displaced
    out = reconcilePersonas([out]).find((p) => p.id === "persona-architect")!;
    expect(out.startPrompt).toBe("MY OWN PROMPT");            // and again, and again
  });

  it("re-seeds a field whose seal says we wrote it, and only that field", () => {
    // The exact mechanism: the fingerprint matches what reconcile last wrote ⇒ untouched ⇒ ours.
    // The user's edited blurb beside it must survive the same pass.
    const stale = unsealed({
      startPrompt: "OLD PACKAGED PROSE",
      blurb: "a blurb I wrote myself",
      proseSeal: { startPrompt: proseFingerprint("OLD PACKAGED PROSE"), blurb: "0000dead" },
    });
    const out = reconcilePersonas([stale]).find((p) => p.id === "persona-architect")!;
    expect(out.startPrompt).toBe(packagedArchitect().startPrompt);   // ours → re-seeded
    expect(out.blurb).toBe("a blurb I wrote myself");                // theirs → kept
  });

  it("stamps a seal on every reconciled built-in, so the NEXT edit is already protected", () => {
    // Without this a user's first edit would land on an unsealed record and be re-seeded away by the
    // following packaged bump — the bootstrap firing twice for one user.
    const fresh = reconcilePersonas([]).find((p) => p.id === "persona-architect")!;
    expect(fresh.proseSeal?.startPrompt).toBe(proseFingerprint(packagedArchitect().startPrompt));

    const theirEdit = { ...fresh, startPrompt: "changed by the user" };
    const after = reconcilePersonas([theirEdit]).find((p) => p.id === "persona-architect")!;
    expect(after.startPrompt).toBe("changed by the user");
  });

  it("is idempotent — a reconciled record reconciles to itself", () => {
    const once = reconcilePersonas([unsealed()]).find((p) => p.id === "persona-architect")!;
    const twice = reconcilePersonas([once]).find((p) => p.id === "persona-architect")!;
    expect(twice.startPrompt).toBe(once.startPrompt);
    expect(twice.proseSeal).toEqual(once.proseSeal);
    expect(twice.replacedProse).toEqual(once.replacedProse);
  });

  it("leaves user-authored personas entirely alone — they are never re-seeded", () => {
    const mine: Persona = { id: "persona-mine-1", name: "Mine", blurb: "b", role: "reviewer",
      startPrompt: "my prompt", skills: [] };
    const out = reconcilePersonas([mine]).find((p) => p.id === "persona-mine-1")!;
    expect(out.startPrompt).toBe("my prompt");
    expect(out.builtin).toBe(false);
    expect(out.proseSeal).toBeUndefined();
  });
});

describe("proseFingerprint", () => {
  it("separates values that differ, and agrees with itself", () => {
    expect(proseFingerprint("a")).toBe(proseFingerprint("a"));
    expect(proseFingerprint("a")).not.toBe(proseFingerprint("b"));
  });

  it("treats absent and empty alike — an unset field is not a different field", () => {
    expect(proseFingerprint(undefined)).toBe(proseFingerprint(""));
  });

  it("does not confuse an array's joins — the separator cannot occur in the prose", () => {
    // `responsibilities` is a string[]; joining on a character that CAN appear in a responsibility
    // would make ["a b"] and ["a", "b"] fingerprint alike, and a real change would read as none.
    expect(proseFingerprint(["a b"])).not.toBe(proseFingerprint(["a", "b"]));
  });
});
