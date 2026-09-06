// THE OFF SWITCH HAS TO BE READ, AND READ IN THE RIGHT ORDER (`auto-spawn-has-no-off-switch`).
//
// `planRequestSessions` already has full behavioural tests for `enabled: false` — it starts nothing and
// closes every live session. Those passed for months while the only call site hardcoded `enabled: true`,
// so the gate was fully tested and completely unreachable. That is the same failure as
// `verify-ui-fixes-in-the-running-app`: a correct pure function nothing routes real state into.
//
// So this is a WIRING guard over the mount's source, and it says so. It proves the switch is read and
// where; the behaviour behind it is pinned by `planRequestSessions`' own tests.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** The mount is a RECORD, not a file (docs/records.md) — read it out of the seed it ships in. */
function mountSource(): string {
  const seed = JSON.parse(readFileSync("src-tauri/data/knowledge/algorithms.json", "utf8"));
  let found: string | null = null;
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) return void o.forEach(walk);
    if (o && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      if (rec.id === "request-sessions-mount.ts" && typeof rec.code === "string") found = rec.code;
      for (const [k, v] of Object.entries(rec)) if (k !== "code") walk(v);
    }
  };
  walk(seed);
  if (!found) throw new Error("request-sessions-mount.ts is not in the algorithms seed");
  return found;
}

describe("the auto-spawn off switch is wired into the mount", () => {
  const src = mountSource();

  // UPDATED (`debug-sessions-have-a-global-off-switch`): the pause is now read THROUGH the combined
  // gate. `bsc request sessions --json` resolves the policy AND the pause in Rust and returns
  // `allowed`, so there is one read and the app combines nothing. The assertions below are unchanged
  // in intent — the switch is read, read BEFORE claiming, and degrades open.
  it("reads the switch at all — and NOT as a hardcoded literal", () => {
    expect(src).toContain(`["request", "sessions", "--json"]`);
    expect(src).toContain("enabled: !paused");
    // The regression this exists to prevent, stated as an assertion rather than a comment.
    expect(src).not.toContain("enabled: true");
  });

  it("reads it BEFORE claiming, because claiming is the side effect that creates the session", () => {
    // Order is the whole correctness. `claim` turns `open` into `claimed`, and `claimed` is what gets a
    // session — so reading the flag afterwards would leave a paused cycle having permanently taken work
    // off the open queue while starting nothing. That is worse than not pausing at all.
    const readAt = src.indexOf(`["request", "sessions", "--json"]`);
    const claimAt = src.indexOf(`["request", "claim", "--json"]`);
    expect(readAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(claimAt);
  });

  it("claims nothing while paused", () => {
    // The claim loop iterates `open`, so gating `open` is what makes a paused cycle claim-free.
    expect(src).toMatch(/const open = paused\s*\n?\s*\?\s*\[\]/);
  });

  it("degrades to ACTIVE when the read fails, never to paused", () => {
    // A failed `bsc` call must not silently stop the debug fleet; a pause has to have been asked for.
    expect(src).toContain("{ allowed: true }");
  });
});
