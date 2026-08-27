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
