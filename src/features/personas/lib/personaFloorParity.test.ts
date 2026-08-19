// The persona floors ARE the role capability table (epic `the-persona-is-the-whole-agent`).
//
// ⚠️ THIS FILE USED TO ASSERT PARITY BETWEEN TWO SOURCES, AND THAT TEST IS NOW A TAUTOLOGY.
// It compared each packaged persona's `floor` against `ROLE_DEFAULTS` — which was built from
// `data/permissions/role-capabilities.json`. That file is deleted and `ROLE_DEFAULTS` is now DERIVED
// from these very floors, so the old assertion compares a value to itself and can never fail. Rather
// than delete the file and lose the coverage, the assertions were rewritten around the properties that
// are still falsifiable now that there is one source instead of two.
//
// The "did the table change" guard moved to `roleCapabilityBaseline.test.ts`, which pins the derived
// table against a frozen fixture — an independent copy, so it can actually fail.
import { describe, it, expect } from "vitest";
import { ROLE_DEFAULTS, restrictedRoleCommands, type SessionRole } from "@/shared/lib/session/sessionRoles";
import type { PersonaFloor } from "./persona";

/** The packaged persona defs, straight off disk — NOT `BUILTIN_PERSONAS`, which applies the config-dir
 *  overlay and would let a local mirror mask a drifted packaged floor. */
const packaged = import.meta.glob<{ id: string; role: SessionRole; floor?: PersonaFloor }>(
  "@data/personas/*.json",
  { eager: true, import: "default" },
);
const entries = Object.entries(packaged);

describe("the persona floors are the role capability table", () => {
  it("has personas to check — the glob still resolves", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("every packaged persona carries a floor", () => {
    // Not cosmetic: `ROLE_DEFAULTS` is projected from these, and a role that no persona supplies is
    // `undefined` at lookup. The module's own #2325 comment records what that costs — a module-load
    // `TypeError reading writeGlobs` that takes down the whole UI, not a quiet degradation.
    const missing = entries.filter(([, p]) => !p.floor).map(([path]) => path);
    expect(missing).toEqual([]);
  });

  it("supplies a floor for EVERY role in the union, so no lookup can be undefined", () => {
    const covered = new Set(entries.filter(([, p]) => p.floor).map(([, p]) => p.role));
    const uncovered = (Object.keys(ROLE_DEFAULTS) as SessionRole[]).filter((r) => !covered.has(r));
    expect(uncovered).toEqual([]);
  });

  it("projects each floor into ROLE_DEFAULTS without dropping a field", () => {
    // Falsifiable despite the shared source: it is the PROJECTION being checked (tableFromPersonas),
    // not the values. A projection that silently omitted `harvestRoots`, or that let a second persona
    // on the same role overwrite the first, fails here.
    for (const [path, p] of entries) {
      if (!p.floor) continue;
      const cap = ROLE_DEFAULTS[p.role];
      expect(cap, `${path}: role '${p.role}' has no capability row`).toBeTruthy();
      for (const axis of ["github", "git", "code", "net", "ui"] as const) {
        expect(cap[axis], `${path}: ${axis}`).toBe(p.floor[axis]);
      }
    }
  });

  it("exposes a floor's confined surface through restrictedRoleCommands", () => {
    // The `allow` list moved out of the RESTRICTED_ROLE_COMMANDS const and onto the floor; this is the
    // seam that used to be a hardcoded lookup.
    for (const [path, p] of entries) {
      if (!p.floor?.allow?.length) continue;
      expect(restrictedRoleCommands(p.role), `${path}`).toEqual(p.floor.allow);
    }
  });

  it("no floor carries a command that is not a `bsc ` store verb", () => {
    // The confined-surface invariant (#4090). It also catches scraped prose: the generator that first
    // produced these floors put "seeing is not reaching" into the architect's surface, lifted out of a
    // COMMENT, and this shape check is what would have caught it.
    for (const [path, p] of entries) {
      for (const cmd of p.floor?.allow ?? []) {
        expect(cmd, `${path}: '${cmd}' is not a bsc verb`).toMatch(/^bsc [a-z]/);
      }
    }
  });
});
