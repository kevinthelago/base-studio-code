// The pane grammar + charter for the two personas on the crate drill
// (`a-noun-and-its-verbs-launch-their-personas`).
import { describe, it, expect } from "vitest";
import {
  nounPaneId, verbPaneId, surfacePaneIdForNode, surfaceAssignment, surfaceCharter,
  SURFACE_PANE_PREFIX, surfaceOperatorProfile, surfaceOperatorProfileId,
} from "@/features/glance/lib/surfaceSpawn";
import { resolveProfileSettings } from "@/shared/lib/security/profileEnforcement";
import type { CrateDrillDoc } from "@/features/glance/lib/surfaceNodes";

const doc: CrateDrillDoc = {
  crate: "logs", path: "crates/logs", surface: true, nouns: [],
  dependsOn: [], dependents: [], dependentCount: 0,
};

describe("a surface node's pane is DERIVED from the node", () => {
  it("resolves a noun and a verb, and nothing else", () => {
    expect(surfacePaneIdForNode("noun:logs")).toBe(nounPaneId("logs"));
    expect(surfacePaneIdForNode("verb:logs:sessions")).toBe(verbPaneId("logs", "sessions"));
    // not a surface node — must not mint a pane nothing can match back
    expect(surfacePaneIdForNode("studio-code:director")).toBeNull();
    expect(surfacePaneIdForNode("surface:logs")).toBeNull();
  });

  it("keys a verb pane on BOTH noun and verb", () => {
    // `bsc logs summary` and `bsc perf summary` are different commands; sharing one session would put
    // two maintainers in one terminal and lose whichever arrived second.
    expect(verbPaneId("logs", "summary")).not.toBe(verbPaneId("perf", "summary"));
  });

  it("refuses a malformed verb id rather than guessing", () => {
    // A pane minted from a half-parsed id can never be matched back to a node, so the session becomes
    // unopenable and unkillable — the failure the derived-id rule exists to prevent.
    expect(surfacePaneIdForNode("verb:")).toBeNull();
    expect(surfacePaneIdForNode("verb:logs")).toBeNull();
    expect(surfacePaneIdForNode("verb:logs:")).toBeNull();
    expect(surfacePaneIdForNode("verb::sessions")).toBeNull();
  });

  it("puts every surface pane under one prefix", () => {
    for (const id of [nounPaneId("logs"), verbPaneId("logs", "tail")]) {
      expect(id.startsWith(SURFACE_PANE_PREFIX)).toBe(true);
    }
  });
});

describe("the assignment says which persona and what it is pointed at", () => {
  it("a noun is an OPERATOR, a verb is a MAINTAINER", () => {
    expect(surfaceAssignment("noun:logs", doc)).toEqual({ kind: "operator", crate: "logs", path: "crates/logs", noun: "logs" });
    // THE PATH IS THE FIX. A surface session runs HERE, not at the repo root: `ensure_session_settings`
    // writes `<cwd>/.claude/settings.json`, so a confined session parked at the root wrote its
    // confinement into the tree every other session inherits. It comes from the drill as data — a
    // derived `crates/${crate}` would be a guess about a layout the doc already states.
    expect(surfaceAssignment("noun:logs", doc)?.path).toBe(doc.path);
    expect(surfaceAssignment("verb:logs:tail", doc)).toEqual({
      kind: "maintainer", crate: "logs", path: "crates/logs", noun: "logs", verb: "tail",
    });
  });

  it("is null with no document — the crate is not knowable from the node alone", () => {
    expect(surfaceAssignment("noun:logs", null)).toBeNull();
  });
});

describe("the charter carries the persona's own words, then the assignment", () => {
  it("leads with the persona prompt rather than restating it", () => {
    // ONE copy of what an operator is. A charter that re-described the persona would drift from it, and
    // drift between two descriptions of the same actor is the failure this whole catalog exists to end.
    const c = surfaceCharter({ kind: "operator", crate: "logs", path: "crates/logs", noun: "logs" }, "PERSONA-PROMPT-BODY");
    expect(c.startsWith("PERSONA-PROMPT-BODY")).toBe(true);
  });

  it("gives the operator the EXACT --surface string its requests must carry", () => {
    // The maintainer's queue is `bsc request list --surface <noun>`. If the operator files under
    // anything else the report is filed, correct, and invisible to the only actor who can act on it.
    const c = surfaceCharter({ kind: "operator", crate: "logs", path: "crates/logs", noun: "metrics" }, "P");
    expect(c).toContain('--surface "metrics"');
    expect(c).toContain("bsc request new");
  });

  it("points the maintainer at that same queue, and at the catalog it must keep true", () => {
    const c = surfaceCharter({ kind: "maintainer", crate: "logs", path: "crates/logs", noun: "metrics", verb: "cost" }, "P");
    expect(c).toContain('bsc request list --surface "metrics"');
    expect(c).toContain("bsc surface verbs metrics");
    expect(c).toContain("bsc metrics cost");
  });
});

// ── the per-pane noun grant (`surface-operator-runs-confined-to-its-own-noun`) ─────────────────────
//
// The operator's ROLE is confined, and `build_allow_rules` returns EARLY under `restricted_allow`
// with only the wrapped allowedCommands — no baseline tiers, no mandatory tier, no `Bash(bsc-*)`. So
// a confined session auto-runs exactly what its allow list names. The role carries the cross-cutting
// half; the noun is chosen per SESSION and can only come from here.
describe("the operator's per-pane profile", () => {
  it("grants ITS noun — the one command the session exists to run", () => {
    const p = surfaceOperatorProfile("studio");
    expect(p.id).toBe(surfaceOperatorProfileId("studio"));
    expect(resolveProfileSettings(p).allowedCommands).toContain("bsc studio");
    // Derived from the noun, so re-opening the same one reuses its row rather than minting a
    // duplicate per launch.
    expect(surfaceOperatorProfileId("persona")).not.toBe(surfaceOperatorProfileId("studio"));
  });

  // THE SAFETY ARGUMENT, and the reason this profile can carry a grant at all. A tool tier of `allow`
  // becomes a VERBATIM rule, so `bash: "allow"` emits a bare `Bash` that auto-approves everything and
  // silently reopens the confinement. `deny` is skipped for bash specifically (a blanket Bash deny
  // would kill the guaranteed git/gh), so it emits NO rule and shell control stays with the allow
  // list. This is the single line that must never be "tidied" to `allow`.
  it("never blanket-allows Bash — that would reopen everything the role closed", () => {
    const p = surfaceOperatorProfile("studio");
    expect(p.tools.bash).toBe("deny");
    const s = resolveProfileSettings(p);
    expect(s.allowToolRules).not.toContain("Bash");
    // and `deny` emits nothing for bash either, so `git`/`gh` are not collaterally killed
    expect(s.denyToolRules).not.toContain("Bash");
  });

  it("carries the bsc-* helpers its charter tells it to use", () => {
    // Shell FUNCTIONS from bsc-env.sh, not the binary: `Bash(bsc *)` cannot match them (no space
    // after `bsc`), and the blanket `Bash(bsc-*)` every unconfined posture gets is on the far side of
    // that early return. Without an explicit grant the charter names a command it cannot run.
    const cmds = resolveProfileSettings(surfaceOperatorProfile("studio")).allowedCommands;
    expect(cmds).toContain("bsc-ask");
    expect(cmds).toContain("bsc-answer");
  });

  it("denies every mutating tool — it reports on a surface, it does not fix one", () => {
    const s = resolveProfileSettings(surfaceOperatorProfile("studio"));
    for (const t of ["Edit", "Write", "WebFetch", "WebSearch", "Task"]) expect(s.denyToolRules).toContain(t);
    expect(s.allowToolRules).toContain("Read");
  });

  // No build toolchain reaches the allow list — the regression that started this: the session ran
  // `cargo run --bin bsc` in the tree the running app owns, to invoke a binary already on its PATH.
  it("grants no build toolchain at all", () => {
    const cmds = resolveProfileSettings(surfaceOperatorProfile("studio")).allowedCommands;
    for (const c of cmds) expect(c.startsWith("bsc")).toBe(true);
    for (const bad of ["cargo", "npm", "python", "python3", "node"]) expect(cmds).not.toContain(bad);
  });
});
