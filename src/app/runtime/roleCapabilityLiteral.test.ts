// NO RECORD MAY VENDOR A ROLE CAPABILITY — the standing guard
// (`toolsview-shows-triage-permissions-for-fifteen-of-nineteen-roles`).
//
// THE INVARIANT. What a session role may do is composed in Rust (`bsc-perms`) and read with
// `bsc session perms`. A record that writes the answer down instead is a second opinion, and a second
// opinion about permissions is the one place a display must never have one. `toolsview` carried exactly
// that — a four-role table plus `?? ROLE_DEFAULTS.triage` — and the consequence was measured: fifteen of
// nineteen roles rendered a posture that was not theirs, and the fallback row was not even triage's real
// capability. Fixing the instance repairs one component; this is what stops the next one.
//
// WHY A SCANNER AND NOT A TYPE. The offending shape is a plain object literal in a record's SOURCE
// STRING — records are data, not files, so there is nothing for tsc or eslint to bind to. The precedent
// for a records-aware vitest guard is `recordBoundary.test.ts` / `platformBoundary.test.ts`, which read
// the same two surfaces for different questions; this is a third.
//
// IT TARGETS THE LITERAL, NOT THE IMPORT, and that distinction is load-bearing. Legitimate readers exist
// and must keep working: `personaeditor` imports `ROLE_DEFAULTS` to enumerate role NAMES, and
// `teams-inspector` imports `roleCapability` while its own header records that reading capability BY
// ROLE became wrong once a persona could carry a narrower floor. Neither writes a capability down. A
// guard that fired on the import would be demanding the wrong change.
//
// BOTH SURFACES, because the frontend is mostly not files: the packaged component seed
// (`data/components/app/**`) and the committed algorithm store. Measured when this landed: one offender
// across 311 component records and 2,957 implementations, and it is the one this slice removes.
import { describe, it, expect } from "vitest";
import { loadImplementations } from "@scripts/lib/recordStore.mjs";
import baseline from "@/shared/lib/session/roleCapabilityBaseline.fixtures.json";

/** The role names the gate actually knows — read from the frozen baseline, never retyped here. */
const ROLE_NAMES = Object.keys((baseline as unknown as { roles: Record<string, unknown> }).roles);

/** A `<role>: {` key — the shape of a hand-written role→capability table. */
const ROLE_KEY = new RegExp(
  String.raw`(?:^|[\s,{])["']?(${ROLE_NAMES.map((r) => r.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})["']?\s*:\s*\{`,
  "g",
);

/** An access axis assigned one of the three tiers — `github: "read"`, `code: 'none'`, … */
const TIER_LITERAL = /\b(?:github|git|code|net|ui|graph)\b\s*:\s*["'](?:none|read|write)["']/g;

/**
 * Does this source vendor a role capability?
 *
 * BOTH halves are required, deliberately. A tier literal alone is how a real reader NARROWS or tests one
 * axis; role keys alone are how a registry lists roles. It is the pairing — two or more role names each
 * opening an object, in a source that also writes tier values — that means a table.
 */
export function vendorsRoleCapability(src: string): { roles: string[]; tiers: number } | null {
  const roles = [...new Set([...src.matchAll(ROLE_KEY)].map((m) => m[1]))];
  const tiers = [...src.matchAll(TIER_LITERAL)].length;
  if (roles.length < 2 || tiers < 2) return null;
  return { roles: roles.sort(), tiers };
}

/** Every packaged component record, as it ships. */
const SEED = import.meta.glob<{ id?: string; srcText?: string; suppressed?: boolean }>(
  "@data/components/app/**/*.json",
  { eager: true, import: "default" },
);
const COMPONENTS = Object.values(SEED).filter((r) => r?.id && r.suppressed !== true);

const IMPLS = ((loadImplementations() ?? []) as { id: string; code?: string; suppressed?: boolean }[])
  .filter((i) => i.id && i.suppressed !== true);

describe("the role-capability scanner still works", () => {
  // GUARD THE GUARD. A scanner that silently stops matching finds nothing, reports no offenders, and
  // reads exactly like a pass — this repo's signature failure. These two cases fix that in place: the
  // positive control is the literal this slice deleted, verbatim in shape.
  it("FIRES on a vendored table — the exact shape that was removed from toolsview", () => {
    const offending = `
      const ROLE_DEFAULTS = {
        planner:  { github: "read", git: "read", code: "none", writeGlobs: [] },
        worker:   { github: "write", git: "write", code: "write", writeGlobs: ["src/**"] },
        triage:   { github: "read", git: "read", code: "none", writeGlobs: [] },
      };
      function roleCapability(role) { return ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.triage; }
    `;
    const hit = vendorsRoleCapability(offending);
    expect(hit).not.toBeNull();
    expect(hit?.roles).toEqual(["planner", "triage", "worker"]);
  });

  it("does NOT fire on a legitimate reader that imports the answer instead of writing it", () => {
    // `personaeditor` and `teams-inspector` in miniature. Demanding a change here would be wrong.
    expect(vendorsRoleCapability(`
      import { ROLE_DEFAULTS, type SessionRole } from "@/shared/lib/session/sessionRoles";
      const ROLES = Object.keys(ROLE_DEFAULTS) as SessionRole[];
      const cap = roleCapability(persona.role);
      const tier = cap.github;
    `)).toBeNull();
    // One axis narrowed on one role is not a table either.
    expect(vendorsRoleCapability(`const narrowed = { ...cap, code: "none" };`)).toBeNull();
  });

  it("knows the real role names — a fixture that shrank would narrow the scan silently", () => {
    expect(ROLE_NAMES).toHaveLength(19);
    expect(ROLE_NAMES).toContain("director");
  });
});

describe("no record vendors a role capability", () => {
  it("found both record surfaces — an empty scan passes vacuously", () => {
    expect(COMPONENTS.length, "the component seed glob matched nothing").toBeGreaterThan(250);
    expect(IMPLS.length, "the committed store loaded no implementations").toBeGreaterThan(2000);
  });

  it("no COMPONENT record writes a role→capability table", () => {
    const offenders = COMPONENTS
      .map((r) => ({ id: r.id as string, hit: vendorsRoleCapability(r.srcText ?? "") }))
      .filter((x) => x.hit)
      .map((x) => `${x.id} (roles: ${x.hit?.roles.join(", ")}; ${x.hit?.tiers} tier literals)`);
    expect(
      offenders,
      "a component may not carry its own role capability — read it from `bsc session perms` and take " +
        "it as a prop, as ToolsView does:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("no ALGORITHM record writes one either", () => {
    const offenders = IMPLS
      .map((r) => ({ id: r.id, hit: vendorsRoleCapability(r.code ?? "") }))
      .filter((x) => x.hit)
      .map((x) => `${x.id} (roles: ${x.hit?.roles.join(", ")}; ${x.hit?.tiers} tier literals)`);
    expect(offenders, "records vendoring a role capability:\n  " + offenders.join("\n  ")).toEqual([]);
  });
});
