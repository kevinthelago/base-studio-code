// The STEWARD is a network's root session — it USES what the network has already built
// (`a-network-gets-a-root-session-that-can-use-what-it-owns`).
//
// WHY THESE ASSERTIONS AND NOT A RENDER TEST. The role's whole content is an AUTHORITY, and an
// authority is invisible until something is refused. These pin the two properties that would be
// expensive to discover the normal way: that the steward is not quietly the surface operator, and
// that "read-only by default" is expressed as an allow-list rather than a deny.
import { describe, it, expect } from "vitest";
import { ROLE_DEFAULTS, type SessionRole } from "@/shared/lib/session/sessionRoles";

const steward = ROLE_DEFAULTS.steward;
const allow = steward?.allow ?? [];

/** The verbs that CHANGE something the steward can see. */
const MUTATING = ["bsc deploy push", "bsc deploy rollback", "bsc fleet start", "bsc plan status"];

describe("the steward is a distinct role from the surface operator", () => {
  it("exists as its own role", () => {
    expect(steward, "the steward role is projected from src-tauri/data/personas/steward.json").toBeTruthy();
    expect(steward.role).toBe("steward");
  });

  it("is NOT the operator — they are different authorities behind different words", () => {
    // `surface-operator-runs-confined-to-its-own-noun` (verified) uses `operator` for a session
    // confined to ONE `bsc` noun, reporting what that noun COSTS. A steward ranges across a whole
    // domain's finished systems. One word for both would put "may drive the network's deployed
    // machines" and "may measure one CLI" behind the same grant.
    const operator = ROLE_DEFAULTS.operator as typeof steward | undefined;
    expect(operator, "the operator still exists — this is an addition, not a rename").toBeTruthy();
    expect(steward.allow).not.toEqual(operator?.allow);
  });
});

describe("the steward is read-only by DEFAULT", () => {
  it("holds no write on any access axis", () => {
    for (const axis of ["github", "git", "code", "net", "ui", "graph"] as const) {
      expect(steward[axis], `steward.${axis} must not grant write`).not.toBe("write");
    }
  });

  it("can READ what the network can do — the capability surface it exists to report on", () => {
    // Without these it cannot answer its one question, and would have to guess — which is the failure
    // `docs/llm-operator/context.md` demonstrates.
    for (const verb of ["bsc capability", "bsc deploy status", "bsc project list"]) {
      expect(allow, `a steward must be able to run \`${verb}\``).toContain(verb);
    }
  });

  it("does NOT auto-run a mutating verb — so each one stops and asks", () => {
    // THE AUTHORITY MODEL, and the direction is deliberate. A mutating verb is ABSENT from the allow
    // list rather than denied: absent falls through to the default posture's prompt, so the human
    // decides per action, while a deny would make it unreachable even when the user wants it.
    for (const verb of MUTATING) {
      expect(allow, `\`${verb}\` must not auto-run for a steward`).not.toContain(verb);
    }
  });

  it("can still file a tooling request, which is how it reports a gap it cannot close", () => {
    expect(allow).toContain("bsc request new");
  });
});

describe("the role vocabulary stayed coherent", () => {
  it("every allowed verb is a `bsc` verb — the steward's whole surface is the CLI", () => {
    // Like the designer and the architect: the stores are the surface, so a shell escape hatch would
    // be a second, ungoverned way to reach them.
    for (const verb of allow) expect(verb.startsWith("bsc "), `unexpected non-bsc grant: ${verb}`).toBe(true);
  });

  it("does not collide with an existing role name", () => {
    const roles = Object.keys(ROLE_DEFAULTS) as SessionRole[];
    expect(roles.filter((r) => r === "steward")).toHaveLength(1);
    expect(roles).toContain("operator");
  });
});
