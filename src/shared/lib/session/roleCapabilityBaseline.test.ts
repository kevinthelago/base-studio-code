// The role capability table may not change by accident (epic `the-persona-is-the-whole-agent`).
//
// WHY A FROZEN FIXTURE RATHER THAN MORE ASSERTIONS. The table's source inverted: it used to be
// `data/permissions/role-capabilities.json`, a single reviewable file whose diff showed every
// capability change; it is now projected from 18 separate persona records. That is the right shape —
// one description of an agent, and a write path that can be clamped — but it costs the property the
// old file had for free: a capability change used to be one obvious line in one obvious file, and it
// is now a field inside whichever persona happened to be edited.
//
// This fixture buys that property back. It is an INDEPENDENT copy of the table, captured at the
// inversion and proven equal to the deleted file on every field at that moment. Any change to a
// persona's floor that moves a role's capability fails here and has to be acknowledged.
//
// ⚠️ WHEN THIS FAILS, THE FIXTURE IS NOT AUTOMATICALLY THE THING TO FIX. Decide first whether the
// capability change was intended. Widening a role is the change this file exists to make visible, so
// "update the fixture until it is green" is precisely the move it is here to prevent.
import { describe, it, expect } from "vitest";
import { ROLE_DEFAULTS, type RoleCapability, type SessionRole } from "@/shared/lib/session/sessionRoles";
import baseline from "./roleCapabilityBaseline.fixtures.json";

const frozen = baseline.roles as Record<string, RoleCapability>;
const roles = Object.keys(frozen) as SessionRole[];

describe("the role capability table matches its frozen baseline", () => {
  it("covers the same set of roles — none added or dropped unnoticed", () => {
    expect(Object.keys(ROLE_DEFAULTS).sort()).toEqual(roles.slice().sort());
  });

  it.each(roles)("%s carries exactly its baseline capability", (role) => {
    expect(ROLE_DEFAULTS[role]).toEqual(frozen[role]);
  });

  it("no role has been widened on any access axis", () => {
    // Stated separately from the equality check above so a FAILURE READS CORRECTLY. Equality tells you
    // something moved; this tells you it moved in the direction that grants more, which is the half
    // that matters when triaging a red gate under time pressure.
    const rank = { none: 0, read: 1, write: 2 } as const;
    const widened: string[] = [];
    for (const role of roles) {
      // `graph` joins the widening check the moment the axis exists, so the store it governs cannot
      // be handed to a new role the way it was handed to EVERY role before it had a gate at all
      // (`the-algorithms-graph-has-no-write-gate`).
      for (const axis of ["github", "git", "code", "net", "ui", "graph"] as const) {
        const now = rank[ROLE_DEFAULTS[role]?.[axis] as keyof typeof rank] ?? 0;
        const was = rank[frozen[role][axis] as keyof typeof rank] ?? 0;
        if (now > was) widened.push(`${role}.${axis}: ${frozen[role][axis]} → ${ROLE_DEFAULTS[role][axis]}`);
      }
    }
    expect(widened).toEqual([]);
  });

  it("no role has gained a write glob or a harvest root it did not have", () => {
    const gained: string[] = [];
    for (const role of roles) {
      for (const glob of ROLE_DEFAULTS[role]?.writeGlobs ?? []) {
        if (!(frozen[role].writeGlobs ?? []).includes(glob)) gained.push(`${role}.writeGlobs += ${glob}`);
      }
      for (const root of ROLE_DEFAULTS[role]?.harvestRoots ?? []) {
        if (!(frozen[role].harvestRoots ?? []).includes(root)) gained.push(`${role}.harvestRoots += ${root}`);
      }
    }
    expect(gained).toEqual([]);
  });

  it("no CONFINED role has had its command surface lifted or extended", () => {
    // The asymmetric field: `allow` absent means UNCONFINED, so losing it is a widening even though
    // "fewer entries" reads like a narrowing everywhere else in this file.
    const loosened: string[] = [];
    for (const role of roles) {
      const was = frozen[role].allow ?? [];
      if (!was.length) continue;
      const now = ROLE_DEFAULTS[role]?.allow ?? [];
      if (!now.length) { loosened.push(`${role}: confined surface REMOVED — the role is now unconfined`); continue; }
      for (const cmd of now) if (!was.includes(cmd)) loosened.push(`${role}.allow += ${cmd}`);
    }
    expect(loosened).toEqual([]);
  });
});
