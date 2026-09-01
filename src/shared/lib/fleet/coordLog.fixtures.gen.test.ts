// The `coord.log` ingest, captured from the LIVE TypeScript so Rust can be proved to match it.
//
// ## Why a fixture rather than a hand-written table
//
// `coord.log` is written by the BACKEND (`crates/logs`, the app's pty env-writer) and by the pure-shell
// `bsc-*` emitters — and parsed only here, in `coordinationLog.ts` over the latch/waiter model in
// `coordinationState.ts`. So the fleet's own state (who is parked, who is ready, what was refused for
// crossing a project boundary) is knowable only while a renderer is alive.
// `epic-frontend-logic-over-backend-resources-belongs-in-rust` moves that derivation.
//
// It is ALREADY duplicated, narrowly and unproven: `crates/logs/src/waiting.rs` re-derives the
// blocked-on-a-human projection of this same fold, and says in its own doc comment that "the pairing
// logic cannot be shared with that reducer (it is TypeScript), so each rule is tested here
// independently rather than assumed equivalent." Independent tests of two copies is exactly how the
// `woke` arm drifted: Rust cleared only a `wait` while this reducer also clears `asking`, so a woken
// session's ask was immortal in `bsc logs waiting`.
//
// A port that is subtly different is worse than no port. So this generates the answer from the
// implementation that is live TODAY and a Rust test asserts its own derivation matches case for case.
// Hand-writing the expectations would only prove Rust agrees with whoever typed the table.
//
// Same pattern as `roleGate.fixtures.json` / `tunnelProtocol.fixtures.json` / `streamGate.fixtures.json`:
// one byte-exact artifact read by BOTH sides. Regenerate deliberately:
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/fleet/coordLog.fixtures.gen.test.ts
//
// A regeneration that changes the file is a CHANGE OF BEHAVIOUR. Read the diff before committing it.
//
// ## The timestamp domain is deliberately narrow
//
// `parseCoordLine` dates a line with `Date.parse`, which accepts far more than the emitters ever write
// (`date -u +%Y-%m-%dT%H:%M:%SZ`, and the app's `epoch_ms_to_iso8601`, which matches it). Two forms are
// therefore kept OUT of this fixture on purpose, because pinning them would pin the wrong thing:
// a timestamp with no zone (`2026-08-31T12:00:00`) is LOCAL time to `Date.parse`, so the fixture would
// encode the generating machine's timezone; and a fractional-second form is accepted by `Date.parse`
// and not by the Rust reader. Neither is emitted. What IS pinned is the emitted grammar and the
// fall-back-to-0 on a string that is not a time at all.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseCoordLine,
  ingestCoordLog,
  coordProjectOf,
  sameCoordProject,
  refusalKey,
} from "@/shared/lib/fleet/coordinationLog";
import { parseRef, refKey } from "@/shared/lib/fleet/coordinationState";
import type { CrossProjectRefusal } from "@/shared/lib/fleet/coordination.types";

const FIXTURE = join(process.cwd(), "src/shared/lib/fleet/coordLog.fixtures.json");

/** The emitted timestamp grammar — `date -u +%Y-%m-%dT%H:%M:%SZ`. */
const T = (s: number) => `2026-08-31T12:00:${String(s).padStart(2, "0")}Z`;

/** One TSV line, joined exactly as the emitters do. */
const L = (ts: string, session: string, ...rest: string[]) => [ts, session, ...rest].join("\t");

/** Every token `parseRef` can be handed, including the ones it must REJECT. */
const REF_TOKENS = [
  "", "   ", "#42", "#1", "#0", "#-1", "#abc", "#4.5", "#", "42", "007", "0",
  // `Number()` is what `#`-refs go through, so its grammar is part of the contract: it TRIMS, it
  // reads exponent notation, and it maps the empty string to 0. Pinned because a Rust `parse::<f64>`
  // agrees on none of those three by default.
  "# 7", "#1e3", "#  ",
  "contract:TunnelState", "contract:", "contract:  ", "file:src/lib/x.ts", "file:",
  "predicate:tests-pass", "predicate:symbol:Foo", "session:studio-code:api", "session:",
  "unknown:foo", "tests-pass", "a bare phrase", ":leading", "  #42  ", "#42 extra",
];

/** Pane-id pairs for the cross-project rule — including both unplaceable directions. */
const PROJECT_PAIRS: [string, string][] = [
  ["alpha:director", "alpha:api"],
  ["alpha:director", "beta:api"],
  ["alpha:director", "alpha:repo:triage"],
  ["t0p2", "alpha:api"],
  ["alpha:director", "t0p2"],
  ["t0p2", "t0p3"],
  ["?", "alpha:api"],
  ["alpha", "alpha"],
  ["", "alpha:api"],
];

/** One line per parse case — the point is the REJECTIONS as much as the accepts. */
const LINE_CASES: { name: string; line: string }[] = [
  { name: "too few columns", line: [T(0), "alpha:api", "woke"].join("\t") },
  { name: "empty line", line: "" },
  { name: "woke", line: L(T(1), "alpha:api", "woke", "") },
  { name: "woke with a trailing CRLF", line: L(T(1), "alpha:api", "woke", "") + "\r\n" },
  { name: "woke with a trailing LF", line: L(T(1), "alpha:api", "woke", "") + "\n" },
  { name: "unknown kind (brief-done IS emitted by the shell and has no arm here)", line: L(T(1), "alpha:api", "brief-done", "alpha:planner@1", "") },
  { name: "kind is case sensitive", line: L(T(1), "alpha:api", "Landed", "#42", "") },
  { name: "unparseable timestamp falls back to 0", line: L("not-a-time", "alpha:api", "woke", "") },
  { name: "empty timestamp falls back to 0", line: L("", "alpha:api", "woke", "") },

  { name: "blocked with mixed refs, one unparseable", line: L(T(2), "alpha:api", "blocked", "#42,contract:X,bogus:", "notes/cp.md") },
  { name: "blocked with no parseable ref", line: L(T(2), "alpha:api", "blocked", ",,", "") },
  { name: "blocked with an empty checkpoint column", line: L(T(2), "alpha:api", "blocked", "#7", "") },
  { name: "blocked with a whitespace checkpoint", line: L(T(2), "alpha:api", "blocked", "#7", "   ") },
  { name: "blocked with no checkpoint column at all", line: L(T(2), "alpha:api", "blocked", "#7") },

  { name: "landed", line: L(T(3), "alpha:api", "landed", "#42", "") },
  { name: "landed with an unparseable ref", line: L(T(3), "alpha:api", "landed", "unknown:x", "") },
  { name: "merged", line: L(T(3), "alpha:api", "merged", "contract:TunnelState", "") },
  { name: "closed", line: L(T(3), "alpha:api", "closed", "session:alpha:web", "") },
  { name: "failed with a reason", line: L(T(4), "alpha:api", "failed", "#42", "the gate went red") },
  { name: "failed with no reason column", line: L(T(4), "alpha:api", "failed", "#42") },
  { name: "failed with an unparseable ref", line: L(T(4), "alpha:api", "failed", "", "why") },

  { name: "waiting with a reason and a checkpoint", line: L(T(5), "alpha:api", "waiting", "needs a decision", "notes/cp.md") },
  { name: "waiting with an empty reason", line: L(T(5), "alpha:api", "waiting", "", "") },
  { name: "ask with a checkpoint", line: L(T(6), "alpha:api", "ask", "which pagination?", "notes/cp.md") },
  { name: "ask with no checkpoint", line: L(T(6), "alpha:api", "ask", "which pagination?", "") },

  { name: "fork with a subagent type", line: L(T(7), "alpha:director", "fork", "review three PRs", "general-purpose") },
  { name: "fork with no subagent type", line: L(T(7), "alpha:director", "fork", "review three PRs", "") },
  { name: "fork with an empty description", line: L(T(7), "alpha:director", "fork", "", "general-purpose") },
  { name: "fork with a whitespace description", line: L(T(7), "alpha:director", "fork", "   ", "") },

  { name: "answer", line: L(T(8), "alpha:director", "answer", "alpha:api", "use cursor pagination") },
  { name: "answer across projects (parses; refused at fold)", line: L(T(8), "alpha:director", "answer", "beta:api", "use cursor pagination") },
  { name: "answer with an empty target", line: L(T(8), "alpha:director", "answer", "", "text") },
  { name: "answer with no answer column", line: L(T(8), "alpha:director", "answer", "alpha:api") },

  { name: "request", line: L(T(9), "alpha:api", "request", "7", "there is no develop branch") },
  { name: "request with an empty id", line: L(T(9), "alpha:api", "request", "", "text") },
  { name: "request-resolved", line: L(T(9), "alpha:director", "request-resolved", "7", "") },
  { name: "request-resolved with an empty id", line: L(T(9), "alpha:director", "request-resolved", "", "") },

  { name: "issue with every column", line: L(T(10), "alpha:issuer", "issue", "Rate limiting is missing", "body text", "api", "iss-1") },
  { name: "issue with no id (falls back to session@at)", line: L(T(10), "alpha:issuer", "issue", "Rate limiting is missing", "body text", "api", "") },
  { name: "issue with only a title", line: L(T(10), "alpha:issuer", "issue", "Rate limiting is missing", "", "", "") },
  { name: "issue with an empty title", line: L(T(10), "alpha:issuer", "issue", "", "body", "api", "iss-2") },

  { name: "assign with every column", line: L(T(11), "alpha:director", "assign", "alpha:api", "start on the rate limiter", "iss-1", "Rate limiting is missing") },
  { name: "assign with only a target and body", line: L(T(11), "alpha:director", "assign", "alpha:api", "start on the rate limiter", "", "") },
  { name: "assign with an empty target", line: L(T(11), "alpha:director", "assign", "", "body", "", "") },

  { name: "maintain with a note", line: L(T(12), "alpha:api", "maintain", "owned issues complete", "") },
  { name: "maintain with no note", line: L(T(12), "alpha:api", "maintain", "", "") },

  { name: "brief with a ref", line: L(T(13), "alpha:planner", "brief", "director", "scope grew: add SSO", "#77") },
  { name: "brief with an unparseable ref", line: L(T(13), "alpha:planner", "brief", "director", "scope grew: add SSO", "unknown:x") },
  { name: "brief with an empty target", line: L(T(13), "alpha:planner", "brief", "", "body", "") },
  { name: "brief with an empty body", line: L(T(13), "alpha:planner", "brief", "director", "", "") },
  { name: "brief with a whitespace body", line: L(T(13), "alpha:planner", "brief", "director", "   ", "") },

  { name: "commission with a ref", line: L(T(14), "alpha:designer", "commission", "librarian", "author a debounce impl", "file:src/x.ts") },
  { name: "commission with an empty target", line: L(T(14), "alpha:designer", "commission", "", "body", "") },
  { name: "commission with a whitespace body", line: L(T(14), "alpha:designer", "commission", "librarian", "  ", "") },

  { name: "deliver", line: L(T(15), "alpha:librarian", "deliver", "alpha:designer@1", "debounce.ts") },
  { name: "deliver with no artifact", line: L(T(15), "alpha:librarian", "deliver", "alpha:designer@1", "") },
  { name: "deliver with no commission", line: L(T(15), "alpha:librarian", "deliver", "", "debounce.ts") },

  { name: "verdict pass", line: L(T(16), "alpha:juror", "verdict", "#42", "pass", "", "") },
  { name: "verdict reject with a reason", line: L(T(16), "alpha:juror", "verdict", "#42", "reject", "no test covers the null path", "") },
  { name: "verdict is case insensitive on the word", line: L(T(16), "alpha:juror", "verdict", "#42", "PASS", "", "") },
  { name: "verdict relevant=false", line: L(T(16), "alpha:juror", "verdict", "#42", "pass", "", "false") },
  { name: "verdict relevant=0", line: L(T(16), "alpha:juror", "verdict", "#42", "pass", "", "0") },
  { name: "verdict relevant=true", line: L(T(16), "alpha:juror", "verdict", "#42", "pass", "", "true") },
  { name: "verdict with an absent relevant column is undefined, an EMPTY one is true", line: L(T(16), "alpha:juror", "verdict", "#42", "pass", "") },
  { name: "verdict with an unknown word", line: L(T(16), "alpha:juror", "verdict", "#42", "maybe", "", "") },
  { name: "verdict with an empty target", line: L(T(16), "alpha:juror", "verdict", "", "pass", "", "") },
];

/** Whole-log replays — the fold, not just the parse. */
const LOG_CASES: { name: string; lines: string[] }[] = [
  { name: "an empty log", lines: [] },
  { name: "every line unparseable", lines: ["", "garbage", L(T(0), "alpha:api", "brief-done", "x", "")] },
  {
    name: "blocked then satisfied wakes the waiter and leaves it awaiting a woke ack",
    lines: [
      L(T(1), "alpha:api", "blocked", "#42,contract:X", "notes/cp.md"),
      L(T(2), "alpha:web", "landed", "#42", ""),
      L(T(3), "alpha:web", "merged", "contract:X", ""),
    ],
  },
  {
    // ARRIVAL ORDER, not alphabetical: `ready`/`answered`/`assigned` come back in the order the
    // sessions became pending, which is `Map` insertion order. Every other log case here has at most
    // one waiter, so without this one a port that used a hash/sorted map would pass the whole
    // fixture — verified by reverting the ordered map and watching only this case go red.
    name: "three waiters on one dep come back in arrival order, and a re-satisfy keeps that order",
    lines: [
      L(T(1), "zulu:api", "blocked", "#42", "notes/z.md"),
      L(T(2), "alpha:api", "blocked", "#42", "notes/a.md"),
      L(T(3), "mike:api", "blocked", "#42", "notes/m.md"),
      L(T(4), "alpha:svc", "landed", "#42", ""),
      L(T(5), "alpha:svc", "merged", "#42", ""),
    ],
  },
  {
    name: "answers and assignments are pending in arrival order too",
    lines: [
      L(T(1), "zulu:api", "ask", "which pagination?", ""),
      L(T(2), "alpha:api", "ask", "which cache?", ""),
      L(T(3), "alpha:director", "answer", "alpha:api", "redis"),
      L(T(4), "zulu:director", "answer", "zulu:api", "cursor"),
      L(T(5), "alpha:director", "assign", "alpha:web", "start on the shell", "", ""),
      L(T(6), "alpha:director", "assign", "alpha:api", "then the limiter", "", ""),
    ],
  },
  {
    name: "the woke ack retires the pending wake",
    lines: [
      L(T(1), "alpha:api", "blocked", "#42", "notes/cp.md"),
      L(T(2), "alpha:web", "landed", "#42", ""),
      L(T(3), "alpha:api", "woke", ""),
    ],
  },
  {
    name: "satisfy BEFORE the block is the lost-wakeup case: no waiter is registered, and ingest reports no pending wake",
    lines: [
      L(T(1), "alpha:web", "landed", "#42", ""),
      L(T(2), "alpha:api", "blocked", "#42", "notes/cp.md"),
    ],
  },
  {
    name: "failed is not a satisfy — the dependent stays blocked",
    lines: [
      L(T(1), "alpha:api", "blocked", "#42", ""),
      L(T(2), "alpha:web", "failed", "#42", "the gate went red"),
    ],
  },
  {
    name: "a later satisfy overwrites a failed latch and wakes the dependent",
    lines: [
      L(T(1), "alpha:api", "blocked", "#42", ""),
      L(T(2), "alpha:web", "failed", "#42", "the gate went red"),
      L(T(3), "alpha:web", "merged", "#42", ""),
    ],
  },
  {
    name: "ask then answer, same project",
    lines: [
      L(T(1), "alpha:api", "ask", "which pagination?", "notes/cp.md"),
      L(T(2), "alpha:director", "answer", "alpha:api", "cursor"),
    ],
  },
  {
    name: "an answer from ANOTHER project is refused and leaves the ask outstanding",
    lines: [
      L(T(1), "alpha:api", "ask", "which pagination?", "notes/cp.md"),
      L(T(2), "beta:director", "answer", "alpha:api", "cursor"),
    ],
  },
  {
    name: "an answer to a bare, unplaceable id is allowed",
    lines: [
      L(T(1), "t0p2", "ask", "which pagination?", ""),
      L(T(2), "alpha:director", "answer", "t0p2", "cursor"),
    ],
  },
  {
    name: "an answer resumes a user-wait too, carrying its checkpoint",
    lines: [
      L(T(1), "alpha:api", "waiting", "needs a decision", "notes/cp.md"),
      L(T(2), "alpha:director", "answer", "alpha:api", "do the second one"),
    ],
  },
  {
    name: "ask supersedes a plain wait for the same session",
    lines: [
      L(T(1), "alpha:api", "waiting", "needs a decision", "notes/cp.md"),
      L(T(2), "alpha:api", "ask", "which pagination?", "notes/cp2.md"),
    ],
  },
  {
    name: "declaring a dependency leaves the manual-wait list",
    lines: [
      L(T(1), "alpha:api", "waiting", "needs a decision", "notes/cp.md"),
      L(T(2), "alpha:api", "blocked", "#42", "notes/cp.md"),
    ],
  },
  {
    name: "issue then assign clears the pending issue and injects the work",
    lines: [
      L(T(1), "alpha:issuer", "issue", "Rate limiting is missing", "body", "api", "iss-1"),
      L(T(2), "alpha:director", "assign", "alpha:api", "start on it", "iss-1", "Rate limiting is missing"),
    ],
  },
  {
    name: "an assign from ANOTHER project is refused and the issue stays pending",
    lines: [
      L(T(1), "alpha:issuer", "issue", "Rate limiting is missing", "body", "api", "iss-1"),
      L(T(2), "beta:director", "assign", "alpha:api", "start on it", "iss-1", ""),
    ],
  },
  {
    name: "an assign with no issueId leaves intake untouched",
    lines: [
      L(T(1), "alpha:issuer", "issue", "Rate limiting is missing", "body", "api", "iss-1"),
      L(T(2), "alpha:director", "assign", "alpha:api", "start on it", "", ""),
    ],
  },
  {
    name: "maintain clears a wait and an ask, and survives a woke",
    lines: [
      L(T(1), "alpha:api", "waiting", "needs a decision", ""),
      L(T(2), "alpha:api", "ask", "which pagination?", ""),
      L(T(3), "alpha:api", "maintain", "owned issues complete", ""),
      L(T(4), "alpha:api", "woke", ""),
    ],
  },
  {
    name: "a replayed log does not double a brief, a fork, an issue or a request",
    lines: [
      L(T(1), "alpha:planner", "brief", "director", "scope grew", "#77"),
      L(T(2), "alpha:director", "fork", "review three PRs", "general-purpose"),
      L(T(3), "alpha:issuer", "issue", "Rate limiting is missing", "", "", "iss-1"),
      L(T(4), "alpha:api", "request", "7", "no develop branch"),
      L(T(1), "alpha:planner", "brief", "director", "scope grew", "#77"),
      L(T(2), "alpha:director", "fork", "review three PRs", "general-purpose"),
      L(T(3), "alpha:issuer", "issue", "Rate limiting is missing", "", "", "iss-1"),
      L(T(4), "alpha:api", "request", "7", "no develop branch"),
    ],
  },
  {
    name: "request-resolved empties the open request",
    lines: [
      L(T(1), "alpha:api", "request", "7", "no develop branch"),
      L(T(2), "alpha:director", "request-resolved", "7", ""),
    ],
  },
  {
    name: "commission then deliver stamps the artifact id",
    lines: [
      L(T(1), "alpha:designer", "commission", "librarian", "author a debounce impl", "file:src/x.ts"),
      L(T(2), "alpha:librarian", "deliver", "alpha:designer@" + Date.parse(T(1)), "debounce.ts"),
    ],
  },
  {
    name: "an unmatched deliver is a no-op",
    lines: [
      L(T(1), "alpha:designer", "commission", "librarian", "author a debounce impl", ""),
      L(T(2), "alpha:librarian", "deliver", "no-such-commission", "debounce.ts"),
    ],
  },
  {
    name: "a verdict moves no state",
    lines: [
      L(T(1), "alpha:juror", "verdict", "#42", "reject", "no test covers the null path", ""),
      L(T(2), "alpha:juror2", "verdict", "#42", "pass", "", "false"),
    ],
  },
  {
    name: "two refusals for the same pair at different times are BOTH reported",
    lines: [
      L(T(1), "alpha:api", "ask", "which pagination?", ""),
      L(T(2), "beta:director", "answer", "alpha:api", "cursor"),
      L(T(3), "beta:director", "answer", "alpha:api", "cursor, really"),
    ],
  },
  {
    name: "a mixed realistic log with unparseable lines interleaved",
    lines: [
      L(T(1), "alpha:api", "waiting", "needs a decision", "notes/cp.md"),
      "garbage",
      L(T(2), "alpha:issuer", "issue", "Rate limiting is missing", "body", "api", "iss-1"),
      L(T(3), "alpha:web", "blocked", "#42,predicate:tests-pass", "notes/web.md"),
      L(T(4), "alpha:director", "assign", "alpha:api", "start on it", "iss-1", "Rate limiting"),
      L(T(5), "alpha:api", "woke", ""),
      L(T(6), "alpha:svc", "landed", "#42", ""),
      L(T(7), "alpha:planner", "brief", "director", "scope grew", "#77"),
      L(T(8), "beta:director", "answer", "alpha:web", "not yours"),
      L(T(9), "alpha:svc", "landed", "predicate:tests-pass", ""),
      L(T(10), "alpha:svc", "maintain", "owned issues complete", ""),
    ],
  },
];

function build() {
  return {
    note: "GENERATED from the live TypeScript — see coordLog.fixtures.gen.test.ts",
    refs: REF_TOKENS.map((token) => {
      const ref = parseRef(token);
      return { token, ref, key: ref ? refKey(ref) : null };
    }),
    projects: PROJECT_PAIRS.map(([from, target]) => ({
      from,
      target,
      fromProject: coordProjectOf(from),
      targetProject: coordProjectOf(target),
      same: sameCoordProject(from, target),
    })),
    refusalKeys: (
      [
        { kind: "answer", from: "beta:director", target: "alpha:api", at: 1 },
        { kind: "assign", from: "beta:director", target: "alpha:api", at: 1 },
        { kind: "answer", from: "beta:director", target: "alpha:api", at: 2 },
      ] as CrossProjectRefusal[]
    ).map((refusal) => ({ refusal, key: refusalKey(refusal) })),
    lines: LINE_CASES.map(({ name, line }) => ({ name, line, event: parseCoordLine(line) ?? null })),
    logs: LOG_CASES.map(({ name, lines }) => ({ name, lines, result: ingestCoordLog(lines) })),
  };
}

describe("the coord.log ingest is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const built = build();
    const text = JSON.stringify(built, null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") {
      writeFileSync(FIXTURE, text);
    }
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("covers every event kind the union declares, so a new kind cannot slip past the port", () => {
    const built = build();
    const seen = new Set(built.lines.map((c) => c.event?.type).filter(Boolean));
    // Every `type` in CoordEvent. Kept as a literal list on purpose: a union is erased at runtime, so
    // this is the only place a NEW variant can be forced to show up as a failing test.
    const kinds = [
      "blocked", "landed", "merged", "closed", "failed", "woke", "waiting", "ask", "answer",
      "issue", "assign", "maintain", "fork", "request", "request-resolved", "brief",
      "commission", "deliver", "verdict",
    ];
    expect([...seen].sort()).toEqual([...kinds].sort());
  });

  it("covers the rejections too — a parser that never returns null is the easy half to port", () => {
    const built = build();
    expect(built.lines.filter((c) => c.event === null).length).toBeGreaterThanOrEqual(20);
    expect(built.refs.filter((r) => r.ref === null).length).toBeGreaterThanOrEqual(8);
  });

  it("exercises the cross-project refusal on BOTH answer and assign", () => {
    const built = build();
    const kinds = new Set(built.logs.flatMap((l) => l.result.refused.map((r) => r.kind)));
    expect([...kinds].sort()).toEqual(["answer", "assign"]);
  });
});
