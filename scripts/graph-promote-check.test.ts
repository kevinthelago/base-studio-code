import { describe, expect, it } from "vitest";
import { ago, attribute, drifted } from "./graph-promote-check.mjs";

const NOW = Date.parse("2026-09-01T15:21:58Z");

describe("graph-promote-check attribution", () => {
  it("pulls the drifted ids out of the checker's JSON line", () => {
    // The real stdout: a human message, the JSON, then the message again.
    const out = [
      "bsc: the repo store is out of date — 1 drifted (session-roles.ts).",
      '{"checked":69,"drifted":["session-roles.ts"],"runtimeBehind":[],"ok":false}',
      "bsc: the repo store is out of date — 1 drifted (session-roles.ts).",
    ].join("\n");
    expect(drifted(out)).toEqual(["session-roles.ts"]);
  });

  it("is quiet rather than throwing when there is no JSON to read", () => {
    expect(drifted("graph: no usable `bsc` binary")).toEqual([]);
    expect(drifted("{not json at all")).toEqual([]);
    expect(drifted("")).toEqual([]);
  });

  /**
   * THE CASE THIS EXISTS FOR. A gate went red 31 seconds after another session authored the record —
   * the check reads a SHARED runtime store, so a red is often live authoring rather than stale drift.
   * Following the bare "run `bsc graph promote`" advice there commits someone's half-written record.
   */
  it("warns off a promote when the drift is seconds old", () => {
    const h = { rev: 4, updatedBy: "", updatedAt: "2026-09-01T15:21:27Z" };
    const out = attribute(["session-roles.ts"], () => h, NOW);
    expect(out).toContain("31s ago");
    expect(out).toContain("ANOTHER SESSION IS PROBABLY MID-EDIT");
    expect(out).toContain("Do NOT `bsc graph promote`");
    expect(out).toContain("unknown"); // an unattributed write is itself the finding
  });

  it("does not cry mid-edit over drift that is genuinely stale", () => {
    const h = { rev: 2, updatedBy: "claude", updatedAt: "2026-08-30T09:00:00Z" };
    const out = attribute(["old-node.ts"], () => h, NOW);
    expect(out).toContain("by claude");
    expect(out).not.toContain("MID-EDIT");
  });

  /** `fleet-director-bridge.ts` was exactly this: rev 0, no author, no timestamp, unowned for weeks. */
  it("reports a never-stamped record as never stamped rather than inventing an age", () => {
    const out = attribute(["fleet-director-bridge.ts"], () => ({ rev: 0, updatedBy: "", updatedAt: "" }), NOW);
    expect(out).toContain("never stamped");
    expect(out).not.toContain("MID-EDIT");
  });

  it("says so when a node's history cannot be read, instead of dropping it", () => {
    expect(attribute(["x.ts"], () => null, NOW)).toContain("no history available");
  });

  it("emits nothing at all when nothing drifted", () => {
    expect(attribute([], () => null, NOW)).toBe("");
  });

  it("scales the age and refuses to guess at an unparseable stamp", () => {
    expect(ago("2026-09-01T15:21:27Z", NOW)).toBe("31s ago");
    expect(ago("2026-09-01T14:21:58Z", NOW)).toBe("60m ago");
    expect(ago("2026-08-30T15:21:58Z", NOW)).toBe("2d ago");
    expect(ago("", NOW)).toBeNull();
    expect(ago(undefined, NOW)).toBeNull();
  });
});
