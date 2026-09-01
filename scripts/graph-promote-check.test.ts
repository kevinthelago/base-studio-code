import { describe, expect, it } from "vitest";
import { ago, attribute, diagnose, drifted, lastRepoCommit, shapeOf } from "./graph-promote-check.mjs";

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

/**
 * The two records as they ACTUALLY stood on 2026-09-01, when `graph-promote-check` had been red all
 * day on a rotating node and every `npm run promote` was forced through `--skip-gate`.
 *
 * The runtime copy is not a stale edit. Every value in it is the fixture of
 * `tests_set_upserts_by_name_and_does_not_drop_sibling_tests` in `crates/bsc-graph/src/cli.rs`, which
 * wrote into the real per-user store through an unlocked process-global `BSC_GRAPH_STORE`. Promoting
 * this id — the one thing the bare failure message advises — would have written 33 characters over a
 * 3263-character record permanently.
 */
const POISONED_RUNTIME = {
  id: "session-roles.ts",
  name: "session-roles",
  code: "export function sessionRoles() {}",
  tech: "typescript",
  rev: 4,
  updatedBy: "unknown",
  updatedAt: "2026-09-01T15:21:27Z",
};
const COMMITTED = {
  id: "session-roles.ts",
  name: "sessionRoles",
  code: "x".repeat(3263),
  tech: "typescript",
};

describe("graph-promote-check drift shape", () => {
  it("names WHICH FIELDS differ, so an id is not the whole answer", () => {
    const shape = shapeOf(POISONED_RUNTIME, COMMITTED);
    expect(shape?.fields).toEqual(["code", "name"]);
    expect(shape?.runtimeCode).toBe(33);
    expect(shape?.repoCode).toBe(3263);
  });

  it("flags the collapse that says a TEST wrote this, not an author", () => {
    expect(shapeOf(POISONED_RUNTIME, COMMITTED)?.collapsed).toBe(true);
  });

  /** A ratio on a tiny body means nothing — a two-line helper halving is ordinary. */
  it("does not cry collapse over a small record", () => {
    const repo = { id: "x.ts", code: "export const a = 1;\n".repeat(4) };
    const runtime = { id: "x.ts", code: "export const a = 1;\n" };
    expect(shapeOf(runtime, repo)?.collapsed).toBe(false);
  });

  it("does not cry collapse over an ordinary edit to a large record", () => {
    const runtime = { id: "x.ts", code: "y".repeat(3000) };
    expect(shapeOf(runtime, COMMITTED)?.collapsed).toBe(false);
    expect(shapeOf(runtime, COMMITTED)?.fields).toEqual(["code", "id", "name", "tech"]);
  });

  it("ignores the server-managed stamps, which move on every write", () => {
    const a = { id: "x.ts", code: "same", rev: 9, updatedAt: "then", updatedBy: "me", history: [1], build: {} };
    const b = { id: "x.ts", code: "same", rev: 1, updatedAt: "now", updatedBy: "you", history: [], build: null };
    expect(shapeOf(a, b)?.fields).toEqual([]);
  });

  it("has no opinion when a copy cannot be read", () => {
    expect(shapeOf(null, COMMITTED)).toBeNull();
    expect(shapeOf(POISONED_RUNTIME, null)).toBeNull();
  });
});

describe("graph-promote-check repo-side attribution", () => {
  const commits = [
    { sha: "ccc", author: "c", date: "2026-09-01", subject: "touched the file, not this record" },
    { sha: "bbb", author: "b", date: "2026-08-30", subject: "changed the record" },
    { sha: "aaa", author: "a", date: "2026-08-28", subject: "first" },
  ];

  /** The commit that CHANGED it, not the newest that merely touched the 2.3 MB file around it. */
  it("names the commit whose value differs from its predecessor's", () => {
    const at = (sha: string) => (sha === "aaa" ? { id: "x", code: "old" } : { id: "x", code: "new" });
    expect(lastRepoCommit("x", commits, at)?.sha).toBe("bbb");
  });

  it("names the newest commit when it is the one that changed the record", () => {
    const at = (sha: string) => ({ id: "x", code: sha === "ccc" ? "newest" : "older" });
    expect(lastRepoCommit("x", commits, at)?.sha).toBe("ccc");
  });

  /** A record present in the oldest commit examined was introduced at or before it — say so. */
  it("reports an exhausted window rather than claiming nothing changed the record", () => {
    const at = () => ({ id: "x", code: "same throughout" });
    const found = lastRepoCommit("x", commits, at, 2);
    expect(found?.sha).toBe("bbb");
    expect(found?.exhausted).toBe(true);
  });

  it("returns null when the record never appears and there is nothing to attribute", () => {
    expect(lastRepoCommit("x", commits, () => null)).toBeNull();
    expect(lastRepoCommit("x", [], () => ({ id: "x" }))).toBeNull();
  });
});

describe("graph-promote-check diagnosis", () => {
  const io = {
    runtime: () => POISONED_RUNTIME,
    repo: () => COMMITTED,
    blame: () => ({ sha: "bd928e01", author: "princess-bubblegum", date: "2026-08-29", subject: "merge: the measurement surfaces" }),
  };

  /**
   * THE WHOLE POINT OF THIS SLICE. The old output named an id and advised `bsc graph promote`. Reading
   * it took forty minutes to establish that following that advice would destroy the record; this must
   * say so in one screen.
   */
  it("turns a bare id into a cause, an owner and a refusal", () => {
    const out = diagnose(["session-roles.ts"], io);
    expect(out).toContain("session-roles.ts");
    expect(out).toContain("bd928e01");
    expect(out).toContain("princess-bubblegum");
    expect(out).toContain("code 3263 -> 33 chars");
    expect(out).toContain("name");
    expect(out).toContain("the shape of a TEST that");
    expect(out).toContain("DO NOT `bsc graph promote`");
  });

  it("does not warn off a promote for ordinary drift", () => {
    const out = diagnose(["x.ts"], {
      runtime: () => ({ id: "x.ts", code: "y".repeat(3000) }),
      repo: () => COMMITTED,
      blame: () => null,
    });
    expect(out).toContain("no commit in the examined window changed this record");
    expect(out).not.toContain("DO NOT");
  });

  it("says the shape is unknown rather than dropping a node it cannot read", () => {
    const out = diagnose(["x.ts"], { runtime: () => null, repo: () => COMMITTED, blame: () => null });
    expect(out).toContain("could not be read");
  });

  it("emits nothing at all when nothing drifted", () => {
    expect(diagnose([], io)).toBe("");
  });
});
