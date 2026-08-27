// The architect is described TWICE, and the two copies drifted — this pins them together.
//
// `@data/architect/claude.md` is written into the Teams Studio workspace as the session's CLAUDE.md
// (`setup_architect_workspace`). `@data/fleet/architect-protocol.md` becomes the architect persona's
// `startPrompt` and is appended to that same file at launch. One session reads both, so a disagreement
// between them is not a documentation nit — it is contradictory instructions in one context window.
//
// THEY DID DISAGREE, and it broke the feature. Discovery was moved onto the architect and the protocol
// was rewritten to say so, while the studio charter still opened with "you work on these stores and
// nothing else … if asked for anything outside those stores, refuse briefly and point the user back to
// the appropriate surface (the planner for planning)". A user arriving to plan an application was
// refused and redirected to a session that no longer exists. Nothing failed; the architect simply did
// its old job correctly.
//
// So the agreements below are asserted against BOTH documents at once. A future edit that teaches one
// of them something is forced to teach the other.
import { describe, it, expect } from "vitest";
import charterMd from "@data/architect/claude.md?raw";
import protocolMd from "@data/fleet/architect-protocol.md?raw";

const DOCS: ReadonlyArray<readonly [string, string]> = [
  ["architect/claude.md", charterMd],
  ["fleet/architect-protocol.md", protocolMd],
];

describe("the two architect documents agree", () => {
  it.each(DOCS)("%s names the whole arc — discover, record, create the project, create the DIRECTOR", (_name, md) => {
    // The handoff is the step that was missing from both: `bsc fleet director new` appeared in NEITHER
    // document, while the persona's floor granted it. An architect cannot spawn a director it has never
    // been told exists, so the funnel stopped at tier 1 and the user's plan went nowhere.
    for (const needle of [
      "bsc plan requirement set",     // what the user wants + what may be decided without them
      "bsc plan classify",            // the usesGithub decision
      "bsc project new",              // creation begins where the conversation is
      "bsc fleet director new",       // THE HANDOFF
      "bsc plan brief",               // correcting a running build afterwards
    ]) {
      expect(md).toContain(needle);
    }
  });

  it.each(DOCS)("%s tells the architect discovery is ITS job, not something to hand off", (_name, md) => {
    expect(md).toContain("discovery");
    expect(md.toLowerCase()).toContain("one topic at a time");
    expect(md).toContain("propose");
  });

  it.each(DOCS)("%s names the research surface it actually has", (_name, md) => {
    // Both servers are already in the session's `.mcp.json`; both documents used to say the architect
    // had "no network" and mention neither, so a capability that shipped was disclaimed in prose. An
    // architect that believes it cannot research cannot "propose, don't interrogate" on anything it
    // does not already know — which is the whole discovery method.
    expect(md).toContain("Research");
    expect(md).toContain("Compliance");
  });

  it.each(DOCS)("%s does not send the user to the DELETED planner", (_name, md) => {
    // The planner session and the planning screen are gone; the architect IS the surface they named.
    // A redirect here is worse than unhelpful — it is a refusal that sounds like routing.
    expect(md).not.toMatch(/the planner for planning/i);
    expect(md).not.toMatch(/planner['’]s and the director['’]s/i);
  });

  it.each(DOCS)("%s does not claim a network denial that swallows the MCP servers", (_name, md) => {
    // "no network" is the sentence that made the architect disclaim Research + Compliance. The precise
    // truth — WebFetch/WebSearch are denied, the MCP tools are not — is what both must say instead.
    expect(md).not.toMatch(/you have no network/i);
    expect(md).not.toMatch(/no `?git`?, no `?gh`?, no network/i);
  });

  it.each(DOCS)("%s still bounds the architect where the funnel needs it bounded", (_name, md) => {
    // Widening the prose must not quietly widen the role. It stays the least-capable tier: it settles
    // WHAT is wanted, and the director it creates writes the plan.
    expect(md).toMatch(/do(es)? not (write|touch)/i);
    expect(md).toContain("director");
  });

  it("both name `bsc fleet directors` as the pre-brief check, since only a running director reads", () => {
    // Paired with the funnelTiers grant test: the prose says to run it, and that test proves the emitted
    // rule actually permits it. Prose and permission were out of step here for exactly this command.
    for (const [, md] of DOCS) expect(md).toContain("bsc fleet directors");
  });
});

// The prose above tells the architect to run `bsc fleet directors` before briefing. This is the other
// half of that claim: that the grant actually PERMITS it.
//
// They were out of step, and the test that should have caught it asserted the wrong thing. Rust wraps
// each granted command as `Bash(<cmd>)` and `Bash(<cmd> *)` (`bash_rule`/`bare_bash_rule`,
// session/settings.rs), so the `*` sits behind a LITERAL SPACE. `bsc fleet director` covers
// `bsc fleet director new x` and does NOT cover `bsc fleet directors` — a different verb that merely
// shares a prefix. Two separate tests asserted
//
//     expect("bsc fleet directors".startsWith("bsc fleet director")).toBe(true)
//
// and called that proof the read resolved. It is true of the TS strings and false of the rule, so both
// stayed green while the command was refused and the protocol went on naming it.
describe("the architect's grants permit what its documents tell it to run", () => {
  /** Does a granted command auto-run `line`? Modelled the way the emitted rule reads it. */
  const autoRuns = (grants: readonly string[], line: string): boolean =>
    grants.some((c) => line === c || line.startsWith(`${c} `));

  it("permits every command the documents name", async () => {
    const { restrictedRoleCommands } = await import("@/shared/lib/session/roleModel");
    const surface = restrictedRoleCommands("architect");
    for (const line of [
      "bsc plan requirement set",
      "bsc plan classify set",
      "bsc plan classify get",
      'bsc project new "My App"',
      "bsc fleet director new my-app",
      "bsc fleet directors",
      "bsc plan brief my-app:director",
    ]) {
      expect(autoRuns(surface, line), `${line} must auto-run`).toBe(true);
    }
  });

  it("still refuses what the documents say it must not reach", async () => {
    const { restrictedRoleCommands } = await import("@/shared/lib/session/roleModel");
    const surface = restrictedRoleCommands("architect");
    for (const line of ["bsc fleet wake s1", "bsc fleet list", "bsc plan issue add", "bsc plan feature set"]) {
      expect(autoRuns(surface, line), `${line} must NOT auto-run`).toBe(false);
    }
  });

  it("pins the trap itself: sharing a prefix is not being granted", () => {
    expect(autoRuns(["bsc fleet director"], "bsc fleet directors")).toBe(false);
    expect(autoRuns(["bsc fleet director"], "bsc fleet director new x")).toBe(true);
    expect(autoRuns(["bsc fleet director"], "bsc fleet director")).toBe(true);
  });
});
