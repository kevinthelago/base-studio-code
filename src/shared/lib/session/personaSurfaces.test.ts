// A persona DECLARES the `bsc` command surfaces it drives, and is held to them
// (`a-persona-declares-its-command-surfaces`, epic `epic-command-surfaces-are-nodes`).
//
// `bsc` sits in the permission model's `mandatory` tier (`data/permissions/base.json`) — always
// allowed, every role, every posture — so before this a worker and a director could reach all ~33
// command surfaces, which is far more than either protocol asks for. The restriction is expressed as
// a DENY of the undeclared complement rather than as an `allow` list, and the difference is the whole
// design; `aWorkerKeepsItsBaselineCommandTiers` below is the test that pins it.
import { describe, it, expect } from "vitest";
import {
  ROLE_DEFAULTS,
  capabilitySurfaces,
  personaSurfaces,
  surfacesFromAllow,
  roleCapability,
  roleDeniedCommands,
  isRestrictedRole,
  restrictedRoleCommands,
  type SessionRole,
} from "@/shared/lib/session/sessionRoles";

/** A stand-in for `bsc surface list --json`'s ACTIVE rows — the shape the consumer joins against. */
const CATALOG = ["plan", "graph", "ui", "files", "errors", "fleet", "atlas", "teams", "persona", "publish", "logs", "request", "cad"];

describe("surfacesFromAllow — deriving a confined role's surfaces from the list it already carries", () => {
  it("takes the SECOND token, because an allow entry is a command prefix and not a surface name", () => {
    expect(surfacesFromAllow(["bsc ui", "bsc plan brief", "bsc shot preview"])).toEqual(["ui", "plan", "shot"]);
  });

  it("dedupes, so the designer's five loop verbs contribute ONE `loop` surface rather than five", () => {
    expect(surfacesFromAllow(["bsc loop new", "bsc loop say", "bsc loop watch"])).toEqual(["loop"]);
  });

  it("ignores an entry that is not a `bsc` command at all — it names no surface", () => {
    // A role may legitimately allow a non-bsc command; mapping it would invent a surface called `push`.
    expect(surfacesFromAllow(["git push", "bsc ui"])).toEqual(["ui"]);
    expect(surfacesFromAllow(["bsc"])).toEqual([]); // a bare `bsc` names no subcommand
  });

  it("is empty for an absent list rather than throwing", () => {
    expect(surfacesFromAllow(undefined)).toEqual([]);
    expect(surfacesFromAllow(null)).toEqual([]);
  });
});

describe("personaSurfaces — what a role declares", () => {
  it("returns NULL, not [], for a role that declares nothing", () => {
    // The distinction is load-bearing: `null` means UNCONSTRAINED (bsc is in the mandatory tier, so
    // the role reaches everything), while `[]` would read as "drives no surface at all" and, fed to
    // the complement below, would deny the entire CLI to every role not yet declared — the whole
    // fleet, today. A caller that conflates them locks out `triage`, `tester`, `reviewer` and the rest.
    expect(personaSurfaces("triage")).toBeNull();
    expect(personaSurfaces(null)).toBeNull();
    expect(personaSurfaces(undefined)).toBeNull();
  });

  it("returns the explicit list for a role that declares one", () => {
    expect(personaSurfaces("worker")).toEqual(["plan", "graph", "ui", "files", "errors"]);
    expect(personaSurfaces("director")).toContain("fleet");
  });

  it("DERIVES a confined role's list from its allow list rather than reading a second copy", () => {
    // The designer's floor names `bsc ui`, `bsc shot preview`, … and nothing restates those as
    // surfaces. Two copies of one fact drift the first time either is edited alone.
    expect(ROLE_DEFAULTS.designer.surfaces).toBeUndefined();
    expect(personaSurfaces("designer")).toEqual(surfacesFromAllow(ROLE_DEFAULTS.designer.allow));
    expect(personaSurfaces("designer")).toContain("ui");
  });

  it("agrees with the allow list for EVERY confined role — the derivation is not spot-checked", () => {
    const confined = (Object.keys(ROLE_DEFAULTS) as SessionRole[]).filter((r) => isRestrictedRole(r));
    expect(confined.length).toBeGreaterThan(0); // the assertion below is vacuous otherwise
    for (const role of confined) {
      expect(personaSurfaces(role)).toEqual(surfacesFromAllow(restrictedRoleCommands(role)));
    }
  });
});

describe("capabilitySurfaces — read the CAPABILITY, never re-look-up the role", () => {
  it("honours a per-assignment narrowing instead of reading the wider table row", () => {
    // `roleCapability` merges an override onto the role default. Looking the role up again would read
    // the shipped row and silently undo the narrowing — the bug this split exists to prevent.
    const narrowed = roleCapability("worker", { surfaces: ["plan"] });
    expect(capabilitySurfaces(narrowed)).toEqual(["plan"]);
    expect(personaSurfaces("worker")).not.toEqual(["plan"]); // the table row is still the wide one
  });

  it("is null for a capability that declares neither surfaces nor an allow list", () => {
    expect(capabilitySurfaces(roleCapability("triage"))).toBeNull();
    expect(capabilitySurfaces(null)).toBeNull();
  });
});

describe("roleDeniedCommands — the undeclared complement is denied", () => {
  it("denies every ACTIVE surface a declaring role did not name", () => {
    const denies = roleDeniedCommands(roleCapability("worker"), CATALOG);
    expect(denies).toContain("bsc atlas");
    expect(denies).toContain("bsc cad");
    expect(denies).toContain("bsc teams");
  });

  it("does NOT deny a surface the role declared", () => {
    const denies = roleDeniedCommands(roleCapability("worker"), CATALOG);
    for (const surface of ["plan", "graph", "ui", "files", "errors"]) {
      expect(denies).not.toContain(`bsc ${surface}`);
    }
  });

  it("gives the director its own set — the two roles are not interchangeable", () => {
    const denies = roleDeniedCommands(roleCapability("director"), CATALOG);
    expect(denies).not.toContain("bsc fleet");    // its whole job
    expect(denies).not.toContain("bsc publish");
    expect(denies).toContain("bsc graph");        // a worker's surface, not the director's
    expect(denies).toContain("bsc ui");
  });

  it("denies NOTHING extra for an undeclared role, so the undeclared fleet is unaffected", () => {
    const before = roleDeniedCommands(roleCapability("triage"));
    const after = roleDeniedCommands(roleCapability("triage"), CATALOG);
    expect(after).toEqual(before);
  });

  it("FAILS OPEN on an empty catalog rather than denying the whole CLI", () => {
    // The catalog is read from a subprocess, so "could not read it" and "no surfaces" are the same
    // value here. Complementing against nothing must deny nothing — the alternative bricks every
    // session the moment that read fails.
    //
    // Compared against the NO-CATALOG call rather than filtered by prefix: the role gate already
    // emits `bsc ui set`, `bsc persona set` and friends for their own reasons, so a `startsWith("bsc ")`
    // filter would assert those away too and pass for the wrong reason.
    expect(roleDeniedCommands(roleCapability("worker"), [])).toEqual(roleDeniedCommands(roleCapability("worker")));
  });

  it("carries a SPACE in every surface deny, so it can never match the bare `bsc` program", () => {
    // `deny_matches` (crates/bsc-util/src/deny.rs) gives a bare program name program-TOKEN semantics
    // and keeps substring semantics for anything else. A deny of `bsc` alone would kill the entire CLI.
    for (const d of roleDeniedCommands(roleCapability("worker"), CATALOG).filter((x) => x.startsWith("bsc"))) {
      expect(d).toMatch(/^bsc \S/);
    }
  });

  it("emits no duplicate — `bsc request` is denied both as a surface and as the tooling queue", () => {
    const denies = roleDeniedCommands(roleCapability("worker"), CATALOG);
    expect(denies.filter((d) => d === "bsc request")).toHaveLength(1);
    expect(new Set(denies).size).toBe(denies.length);
  });
});

describe("the restriction is a DENY, never an `allow` — the trap this design avoids", () => {
  it("leaves a worker UNCONFINED, so it keeps cargo/npm/git/gh at launch", () => {
    // `allow`'s presence is what flips `isRestrictedRole`, and that suppresses the BASELINE command
    // tiers (`restrictedAllow`). Expressing the surface restriction as an allow list would have taken
    // a worker's build toolchain away with it — the session could no longer run its own gate.
    expect(isRestrictedRole("worker")).toBe(false);
    expect(isRestrictedRole("director")).toBe(false);
    expect(ROLE_DEFAULTS.worker.allow).toBeUndefined();
    expect(ROLE_DEFAULTS.director.allow).toBeUndefined();
  });

  it("still confines the studio roles, which DO mean the allow-list semantics", () => {
    expect(isRestrictedRole("designer")).toBe(true);
    expect(isRestrictedRole("librarian")).toBe(true);
  });
});

describe("the declared sets match what each protocol actually asks for", () => {
  it("a worker drives the stores its protocol names, and NOT the director's fleet verbs", () => {
    const worker = personaSurfaces("worker")!;
    // data/fleet/worker-protocol.md: `bsc graph impl get`, `bsc ui get/set/backing`, `bsc plan …`,
    // `bsc files read`, `bsc errors run`.
    expect(worker.slice().sort()).toEqual(["errors", "files", "graph", "plan", "ui"]);
    // `bsc fleet` appears in that protocol ONLY as the director's `bsc fleet wake`, and the global
    // tooling queue is deliberately the director's escalation — a worker files `bsc plan request`.
    expect(worker).not.toContain("fleet");
    expect(worker).not.toContain("request");
  });

  it("a director keeps the tooling queue, because it is the sanctioned escalation point", () => {
    // `mayFileToolingRequest(director)` is true (#4001), so denying `bsc request` here would
    // contradict the role model and close the only lane a worker's ask can be promoted through.
    expect(personaSurfaces("director")).toContain("request");
    expect(roleDeniedCommands(roleCapability("director"), CATALOG)).not.toContain("bsc request");
  });
});
