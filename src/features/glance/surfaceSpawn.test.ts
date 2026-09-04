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
  crate: "logs", path: "crates/logs", surface: true,
  nouns: [{
    noun: "logs", status: "active", catalog: "projected",
    verbs: [
      { verb: "sessions", summary: "every session, one line each", usage: "USAGE:\n  bsc logs sessions" },
      { verb: "tail", summary: "newest raw lines of one stream", usage: "USAGE:\n  bsc logs tail <stream>" },
    ],
  }],
  dependsOn: [], dependents: [], dependentCount: 0,
};

/** The same crate with NO published catalog — distinct from an empty one. */
const uncatalogued: CrateDrillDoc = { ...doc, nouns: [{ noun: "logs", status: "active", catalog: "unreachable", verbs: null }] };

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

  // WAS: "gives the operator the EXACT --surface string its requests must carry". That string was how
  // the request QUEUE routed a finding — and the queue is worked by the debug session, not by the
  // maintainer of the verb (`the-noun-asks-the-verbs-own-session`). The address that matters now is the
  // maintainer's pane, and the charter hands it over already built rather than asking the operator to
  // assemble one.
  it("gives the operator the maintainer's address, already built", () => {
    const c = surfaceCharter({ kind: "operator", crate: "logs", path: "crates/logs", noun: "logs" }, "P", doc);
    expect(c).toContain("bsc session ask surface-studio:verb-logs-sessions");
    expect(c).not.toContain("bsc request new");
  });

  // WAS: "points the maintainer at that same queue". It no longer reads a queue — the operator asks it
  // directly and it answers on that loop. What survives unchanged is the catalog obligation, and it
  // matters MORE now: the operator's charter is generated FROM that catalog, so a stale `CmdDoc`
  // teaches a command that does not run.
  it("points the maintainer at the loop it answers on, and at the catalog it must keep true", () => {
    const c = surfaceCharter({ kind: "maintainer", crate: "logs", path: "crates/logs", noun: "logs", verb: "tail" }, "P", doc);
    expect(c).toContain("bsc session reply");
    expect(c).toContain("bsc surface verbs logs");
    expect(c).toContain("bsc logs tail");
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

// ── the charter TEACHES the surface (`a-session-is-taught-its-surface`) ────────────────────────────
//
// It used to open "Read it first with `bsc <noun> help` and `bsc surface drill <crate> --json`", which
// spent two turns of a twenty-turn budget before anything was run — and left the model inferring the
// command SHAPE. MEASURED: a session reached for `bsc-studio-help`, generalising from the hyphenated
// `bsc-ask`/`bsc-answer` helpers it had been granted. That is not a command at all.
describe("the charter teaches the surface rather than sending the session to find it", () => {
  const op = { kind: "operator", crate: "logs", path: "crates/logs", noun: "logs" } as const;

  it("lists every verb as a literal command line", () => {
    const c = surfaceCharter(op, "P", doc);
    expect(c).toContain("bsc logs sessions");
    expect(c).toContain("every session, one line each");
    expect(c).toContain("bsc logs tail");
    // ...and does NOT send it off to discover what it was just told.
    expect(c).not.toContain("bsc surface drill");
  });

  // THE REGRESSION, named. The hyphen is not a typo the model invented from nothing — it generalised
  // from the helper family, so the charter has to draw the line rather than assume it.
  it("states the command shape, because a hyphenated guess is not a command", () => {
    const c = surfaceCharter(op, "P", doc);
    expect(c).toContain("SPACED, NEVER HYPHENATED");
    expect(c).toContain("`bsc-logs-<verb>` is not a command");
    // `bsc-session` was a real attempt, so it is named rather than left to the general rule. A model
    // that reaches for one hyphenated form reaches for the next.
    expect(c).toContain("`bsc-session`");
  });

  // NAME THE BINARY (`a-session-knows-the-binary-is-bsc`). A session reached for `bsc-session`,
  // apparently to file a request — it knew what it wanted and not what to type. The entry point is
  // stated, and so is the gap between what the APP has and what THIS session may auto-run: a confined
  // role runs exactly its allow list and stops to ask for anything else, which for an unattended
  // session is a stall rather than a refusal it can read.
  it("names the binary and the one command that lists everything", () => {
    const c = surfaceCharter(op, "P", doc);
    expect(c).toContain("THE BINARY IS `bsc`");
    expect(c).toContain("bsc help");
    expect(c).toContain("bsc persona whatami");
    expect(c).toContain("YOUR GRANT IS NARROWER THAN THAT CATALOG");
  });

  it("gives the operator the maintainer's pane id per verb, already built", () => {
    const c = surfaceCharter(op, "P", doc);
    expect(c).toContain("bsc session ask surface-studio:verb-logs-sessions");
    expect(c).toContain("bsc session ask surface-studio:verb-logs-tail");
  });

  // The two instructions the personas replaced. Leaving them here made the charter contradict the
  // persona — and the charter is APPENDED, so its version was the last thing the session read.
  it("no longer routes findings to the request queue or tells a maintainer to claim", () => {
    const c = surfaceCharter(op, "P", doc);
    expect(c).not.toContain("bsc request new");
    const m = surfaceCharter({ ...op, kind: "maintainer", verb: "tail" }, "P", doc);
    expect(m).not.toContain("bsc request claim");
    expect(m).toContain("bsc session reply");
  });

  it("gives the maintainer its own verb's usage and the directory it runs in", () => {
    const m = surfaceCharter({ ...op, kind: "maintainer", verb: "tail" }, "P", doc);
    expect(m).toContain("bsc logs tail <stream>");
    expect(m).toContain("crates/logs");
  });

  // ABSENT IS NOT EMPTY. A crate that serves the noun but publishes no catalog must say so, or the
  // charter reads as "this surface has no verbs" — which describes a broken surface, not a missing doc.
  it("says a catalog is unpublished rather than rendering an empty surface", () => {
    const c = surfaceCharter(op, "P", uncatalogued);
    expect(c).toContain("publishes no verb catalog");
    expect(c).toContain("bsc logs help");
    expect(c).toContain("surface-studio:verb-logs-<verb>");
  });

  it("still degrades to the persona prompt alone when no doc reached it", () => {
    const c = surfaceCharter(op, "PERSONA-PROMPT-BODY", null);
    expect(c.startsWith("PERSONA-PROMPT-BODY")).toBe(true);
    expect(c).toContain("SPACED, NEVER HYPHENATED");
  });
});
