// Every packaged persona's FLOOR must reproduce its role's capability exactly (epic
// `the-persona-is-the-whole-agent`, slice `the-persona-carries-its-floor`).
//
// The floors are GENERATED onto the persona JSONs by `scripts/gen-persona-floors.mjs`, which parses
// `RESTRICTED_ROLE_COMMANDS` out of the role model with a regex. This test is the real guard, and it is
// deliberately STRONGER than the generator: it reads the actual exports — `ROLE_DEFAULTS` and
// `restrictedRoleCommands()` — so a floor can only pass by matching what the role gate itself computes,
// not by matching whatever a regex managed to scrape.
//
// That distinction is not theoretical. The generator's FIRST run put `"seeing is not reaching"` and
// `"make a new one"` into the architect's real permission surface, scraped out of quoted prose inside
// the comments that annotate that literal. This test would have failed on it.
//
// It also pins the direction of travel: while both sources exist, they must agree. `personas-are-the-
// launch-primitive` deletes `role-capabilities.json`, and this test goes with it — at which point the
// persona floors are the sole source and there is nothing left to drift against.
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

/** The floor a role's capability implies — the same assembly the generator performs, from the exports. */
function expectedFloor(role: SessionRole): PersonaFloor {
  const cap = ROLE_DEFAULTS[role];
  const floor: PersonaFloor = {
    github: cap.github, git: cap.git, code: cap.code, net: cap.net, ui: cap.ui,
  };
  if (cap.writeGlobs.length) floor.writeGlobs = [...cap.writeGlobs];
  if (cap.harvestRoots?.length) floor.harvestRoots = [...cap.harvestRoots];
  const allow = restrictedRoleCommands(role);
  if (allow.length) floor.allow = allow;
  return floor;
}

describe("packaged persona floors reproduce their role's capability", () => {
  it("has personas to check — the glob still resolves", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("every packaged persona carries a floor", () => {
    const missing = entries.filter(([, p]) => !p.floor).map(([path]) => path);
    expect(missing, "run `node scripts/gen-persona-floors.mjs`").toEqual([]);
  });

  it.each(entries)("%s matches its role row exactly", (_path, persona) => {
    expect(persona.floor).toEqual(expectedFloor(persona.role));
  });

  it("covers every role in the table, so no capability row is left without a persona", () => {
    const covered = new Set(entries.map(([, p]) => p.role));
    const uncovered = (Object.keys(ROLE_DEFAULTS) as SessionRole[]).filter((r) => !covered.has(r));
    expect(uncovered).toEqual([]);
  });

  it("no floor carries a command that is not a `bsc ` store verb", () => {
    // The confined-surface invariant (#4090 and the architect's `bsc plan brief` note): every entry on
    // a restricted surface must be a bsc store verb. It is ALSO what catches scraped prose — the
    // generator's first run produced "seeing is not reaching", which fails here on shape alone.
    for (const [path, persona] of entries) {
      for (const cmd of persona.floor?.allow ?? []) {
        expect(cmd, `${path}: '${cmd}' is not a bsc verb`).toMatch(/^bsc [a-z]/);
      }
    }
  });
});
