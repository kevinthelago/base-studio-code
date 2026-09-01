// The warden's decision layer, captured from the LIVE TypeScript so the Rust port can be proved equal.
//
// Every resource it reasons about is Rust's: the PTY sessions it quarantines, the worktrees it diffs,
// and the `bsc-audit` log the pure-shell helpers write. The quarantine is an enforcement action against
// a process Rust owns, decided in a renderer this project has watched get OOM-killed.
//
// `planWarden` calls `checkConformance`, whose file-lane arm needs the glob engine that
// `the-two-write-scope-glob-engines-disagree` has BLOCKED on a maintainer decision — so the fixture
// records the VERDICT the live conformance produced, and the Rust side takes it as an input. Same
// treatment as the file-glob matcher in `crates/logs/src/deadlock.rs`, for the same reason.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/fleet/warden.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  summarizeTrips,
  planWarden,
  parseAuditCommands,
  zipWorktreeChanges,
  wardenSweepTargets,
  livePaneIdsOf,
} from "@/shared/lib/fleet/warden";
import type { WardenSession } from "@/shared/lib/fleet/warden";
import { checkConformance, type StreamAnchor, type ConformanceTrip } from "@/shared/lib/fleet/conformance";
import { roleCapability } from "@/shared/lib/session/sessionRoles";
import type { WorktreeChanges } from "@/shared/lib/fleet/worktreeChanges";

const FIXTURE = join(process.cwd(), "src/shared/lib/fleet/warden.fixtures.json");

const anchor = (streamId: string, globs: string[]): StreamAnchor => ({
  streamId,
  ownedGlobs: globs,
  capability: roleCapability("worker", { writeGlobs: globs }),
});

// ── summarizeTrips ──────────────────────────────────────────────────────────────
const trip = (kind: ConformanceTrip["kind"], detail: string) => ({ kind, detail }) as ConformanceTrip;

const SUMMARIES: { label: string; trips: ConformanceTrip[] }[] = [
  { label: "nothing tripped", trips: [] },
  { label: "one out-of-glob", trips: [trip("out-of-glob", "src/web/app.tsx")] },
  { label: "one denied command", trips: [trip("denied-command", "gh pr merge 3")] },
  {
    label: "two trips — the head is named and the rest counted",
    trips: [trip("out-of-glob", "a.ts"), trip("denied-command", "gh repo delete x")],
  },
  {
    label: "three trips — the +N is a COUNT, not a re-listing",
    trips: [trip("denied-command", "gh pr merge 1"), trip("out-of-glob", "b.ts"), trip("out-of-glob", "c.ts")],
  },
  { label: "a detail containing a backtick", trips: [trip("denied-command", "echo `id`")] },
  { label: "an empty detail", trips: [trip("out-of-glob", "")] },
];

// ── planWarden ──────────────────────────────────────────────────────────────────
type PlanCase = { label: string; sessions: WardenSession[]; quarantined: string[] };

const PLANS: PlanCase[] = [
  { label: "nothing running", sessions: [], quarantined: [] },
  {
    label: "one worker, on plan",
    sessions: [{ paneId: "p:api", anchor: anchor("api", ["src/api/**"]), activity: { changedFiles: ["src/api/r.ts"], commands: ["git status"] } }],
    quarantined: [],
  },
  {
    label: "one worker out of lane",
    sessions: [{ paneId: "p:api", anchor: anchor("api", ["src/api/**"]), activity: { changedFiles: ["src/web/app.tsx"], commands: [] } }],
    quarantined: [],
  },
  {
    label: "a denied command trips",
    sessions: [{ paneId: "p:api", anchor: anchor("api", ["src/api/**"]), activity: { changedFiles: [], commands: ["gh pr merge 12 --squash"] } }],
    quarantined: [],
  },
  {
    label: "ALREADY quarantined — a trip is one-shot, never a repeating alert",
    sessions: [{ paneId: "p:api", anchor: anchor("api", ["src/api/**"]), activity: { changedFiles: ["src/web/app.tsx"], commands: [] } }],
    quarantined: ["p:api"],
  },
  {
    label: "two drifting, one clean — order follows the input",
    sessions: [
      { paneId: "p:web", anchor: anchor("web", ["src/web/**"]), activity: { changedFiles: ["src/api/x.ts"], commands: [] } },
      { paneId: "p:api", anchor: anchor("api", ["src/api/**"]), activity: { changedFiles: ["src/api/ok.ts"], commands: [] } },
      { paneId: "p:db", anchor: anchor("db", ["src/db/**"]), activity: { changedFiles: [], commands: ["gh repo delete acme/x --yes"] } },
    ],
    quarantined: [],
  },
  {
    label: "one of two already quarantined — the skip is per pane",
    sessions: [
      { paneId: "p:web", anchor: anchor("web", ["src/web/**"]), activity: { changedFiles: ["src/api/x.ts"], commands: [] } },
      { paneId: "p:db", anchor: anchor("db", ["src/db/**"]), activity: { changedFiles: ["src/api/y.ts"], commands: [] } },
    ],
    quarantined: ["p:web"],
  },
  {
    label: "a lane-less stream imposes no file constraint",
    sessions: [{ paneId: "p:free", anchor: anchor("free", []), activity: { changedFiles: ["anywhere/x.ts"], commands: [] } }],
    quarantined: [],
  },
  {
    label: "an app-authored file is NOT drift (#3980 — 18 of 22 quarantines were this one file)",
    sessions: [{ paneId: "p:auth", anchor: anchor("auth", ["src/auth/**"]), activity: { changedFiles: ["CLAUDE.local.md"], commands: [] } }],
    quarantined: [],
  },
  {
    label: "the app file rides along with a real stray — only the stray is reported",
    sessions: [{ paneId: "p:auth", anchor: anchor("auth", ["src/auth/**"]), activity: { changedFiles: ["CLAUDE.local.md", "src/billing/charge.ts"], commands: [] } }],
    quarantined: [],
  },
  {
    label: "multiple trips on ONE worker — the summary counts them",
    sessions: [{ paneId: "p:api", anchor: anchor("api", ["src/api/**"]), activity: { changedFiles: ["a.ts", "b.ts"], commands: ["gh pr merge 3"] } }],
    quarantined: [],
  },
];

// ── parseAuditCommands ──────────────────────────────────────────────────────────
const T = "2026-09-01T12:00:00Z";
const LATER = "2026-09-01T13:00:00Z";
const SINCE = Date.parse("2026-09-01T12:30:00Z");

type AuditCase = { label: string; lines: string[]; paneId: string; since?: number };

const AUDITS: AuditCase[] = [
  { label: "no lines", lines: [], paneId: "p:api" },
  { label: "one bash row", lines: [`${T}\tp:api\tBash\tgit status`], paneId: "p:api" },
  { label: "a row for ANOTHER pane is not this pane's evidence", lines: [`${T}\tp:web\tBash\tgit push`], paneId: "p:api" },
  {
    // The pane match must be EQUALITY. A prefix match would let `p:api` absorb `p:api-2`'s commands
    // and quarantine it for a neighbour's behaviour — the same misattribution `zipWorktreeChanges`
    // guards against on the file side, on the command side where nothing was watching.
    label: "a pane id that is a strict PREFIX of another is a different worker",
    lines: [`${T}\tp:api-2\tBash\tgh repo delete acme/x`, `${T}\tp:api\tBash\tgit status`],
    paneId: "p:api",
  },
  {
    label: "and the longer id does not collect the shorter one's rows either",
    lines: [`${T}\tp:api\tBash\tgit status`, `${T}\tp:api-2\tBash\tgit log`],
    paneId: "p:api-2",
  },
  { label: "a non-Bash tool is not a command", lines: [`${T}\tp:api\tWrite\tsrc/x.ts`, `${T}\tp:api\tRead\ta.ts`], paneId: "p:api" },
  { label: "the tool match is case- and space-insensitive", lines: [`${T}\tp:api\t BASH \tgit log`], paneId: "p:api" },
  { label: "a blank target is dropped", lines: [`${T}\tp:api\tBash\t   `], paneId: "p:api" },
  { label: "a short row is dropped", lines: [`${T}\tp:api\tBash`, "garbage"], paneId: "p:api" },
  { label: "the target is trimmed", lines: [`${T}\tp:api\tBash\t   git fetch  `], paneId: "p:api" },
  { label: "order is preserved", lines: [`${T}\tp:api\tBash\tone`, `${T}\tp:api\tBash\ttwo`, `${T}\tp:api\tBash\tthree`], paneId: "p:api" },
  {
    label: "since=0 keeps everything, however old",
    lines: [`2020-01-01T00:00:00Z\tp:api\tBash\tancient`], paneId: "p:api", since: 0,
  },
  {
    label: "a PRE-RELAUNCH denied command is dropped by the since floor",
    lines: [`${T}\tp:api\tBash\tgh repo delete acme/x`, `${LATER}\tp:api\tBash\tgit status`],
    paneId: "p:api", since: SINCE,
  },
  {
    label: "every row predates the floor — a relaunched worker starts with NO command history",
    lines: [`${T}\tp:api\tBash\tgh repo delete acme/x`, `${T}\tp:api\tBash\tgh pr merge 1`],
    paneId: "p:api", since: SINCE,
  },
  {
    label: "a row exactly AT the floor is kept — the comparison is strictly before",
    lines: [`2026-09-01T12:30:00Z\tp:api\tBash\tgit status`],
    paneId: "p:api", since: SINCE,
  },
  {
    label: "FAIL-OPEN: an UNPARSEABLE timestamp is KEPT despite the floor",
    lines: [`not-a-date\tp:api\tBash\tgh repo delete acme/x`],
    paneId: "p:api", since: SINCE,
  },
  {
    label: "an empty timestamp is also kept",
    lines: [`\tp:api\tBash\tgh pr merge 1`], paneId: "p:api", since: SINCE,
  },
  {
    label: "a command containing a TAB is split — only the prefix survives",
    lines: [`${LATER}\tp:api\tBash\tgit commit -m a\tb`], paneId: "p:api",
  },
];

// ── zipWorktreeChanges — the index-alignment cases ──────────────────────────────
const wc = (tracked: string[], untracked: string[] = []): WorktreeChanges => ({ tracked, untracked });

/** A hole is `null`, never `undefined`: `JSON.stringify` writes an array's `undefined` element as
 *  `null`, so an `undefined` corpus cannot round-trip through its own fixture — and the hole is the
 *  case that matters most here. Converted back at the call site. */
type ZipCase = { label: string; panes: string[]; changes: (WorktreeChanges | null)[] };

const ZIPS: ZipCase[] = [
  { label: "empty", panes: [], changes: [] },
  { label: "aligned, one pane", panes: ["p:a"], changes: [wc(["a.ts"])] },
  { label: "aligned, three panes", panes: ["p:a", "p:b", "p:c"], changes: [wc(["a.ts"]), wc(["b.ts"]), wc(["c.ts"])] },
  {
    label: "UNTRACKED is ignored — #3983, the regression that killed four workers with zero tracked changes",
    panes: ["p:a"], changes: [wc([], [".agentscratch.txt"])],
  },
  { label: "tracked and untracked together — only tracked is evidence", panes: ["p:a"], changes: [wc(["real.ts"], ["scratch.txt"])] },
  {
    label: "SHORT batch — the missing pane degrades to no signal, never to a neighbour's files",
    panes: ["p:a", "p:b", "p:c"], changes: [wc(["a.ts"])],
  },
  {
    label: "a HOLE in the batch — undefined is no signal, not the next entry",
    panes: ["p:a", "p:b", "p:c"], changes: [wc(["a.ts"]), null, wc(["c.ts"])],
  },
  {
    label: "LONG batch — the extra entry is dropped, not attributed to anyone",
    panes: ["p:a"], changes: [wc(["a.ts"]), wc(["b.ts"])],
  },
  { label: "every entry missing", panes: ["p:a", "p:b"], changes: [] },
  { label: "a duplicate pane id — the last write wins", panes: ["p:a", "p:a"], changes: [wc(["first.ts"]), wc(["second.ts"])] },
];

// ── sweep targets + live panes ─────────────────────────────────────────────────
type SweepCase = { label: string; panes: string[]; live: string[]; completed: string[] };

const SWEEPS: SweepCase[] = [
  { label: "nothing", panes: [], live: [], completed: [] },
  { label: "all live, none complete", panes: ["p:a", "p:b"], live: ["p:a", "p:b"], completed: [] },
  { label: "a planned pane with no session is not swept (#3954)", panes: ["p:a", "p:b"], live: ["p:a"], completed: [] },
  { label: "a completed stream is not swept", panes: ["p:a", "p:b"], live: ["p:a", "p:b"], completed: ["p:b"] },
  { label: "live AND completed — completion wins", panes: ["p:a"], live: ["p:a"], completed: ["p:a"] },
  { label: "live names a pane not in the roster — the roster bounds it", panes: ["p:a"], live: ["p:a", "p:ghost"], completed: [] },
  { label: "order follows the roster", panes: ["p:c", "p:a", "p:b"], live: ["p:a", "p:b", "p:c"], completed: [] },
];

type LiveCase = { label: string; tabs: { paneIds?: string[] }[]; ended: string[]; disabled: string[] };

const LIVES: LiveCase[] = [
  { label: "no tabs", tabs: [], ended: [], disabled: [] },
  { label: "one tab, two panes", tabs: [{ paneIds: ["p:a", "p:b"] }], ended: [], disabled: [] },
  { label: "a tab with NO paneIds at all", tabs: [{}], ended: [], disabled: [] },
  { label: "an ended pane is not live", tabs: [{ paneIds: ["p:a", "p:b"] }], ended: ["p:a"], disabled: [] },
  { label: "a disabled pane is not live", tabs: [{ paneIds: ["p:a", "p:b"] }], ended: [], disabled: ["p:b"] },
  { label: "several tabs union together", tabs: [{ paneIds: ["p:a"] }, { paneIds: ["p:b"] }], ended: [], disabled: [] },
  { label: "the same pane in two tabs is one entry", tabs: [{ paneIds: ["p:a"] }, { paneIds: ["p:a"] }], ended: [], disabled: [] },
  { label: "an EMPTY pane id is skipped", tabs: [{ paneIds: ["", "p:a"] }], ended: [], disabled: [] },
];

describe("warden fixtures", () => {
  it("captures the live decision layer", () => {
    const summaries = SUMMARIES.map((s) => ({ ...s, summary: summarizeTrips(s.trips) }));

    const plans = PLANS.map((p) => ({
      label: p.label,
      sessions: p.sessions.map((s) => ({
        paneId: s.paneId,
        streamId: s.anchor.streamId,
        ownedGlobs: s.anchor.ownedGlobs,
        activity: s.activity,
        // The conformance verdict, recorded WHOLE — the Rust side takes it as an input, because the
        // glob engine underneath is blocked on a maintainer decision.
        verdict: checkConformance(s.anchor, s.activity),
      })),
      quarantined: p.quarantined,
      trips: planWarden(p.sessions, new Set(p.quarantined)),
    }));

    const audits = AUDITS.map((a) => ({
      ...a,
      since: a.since ?? 0,
      commands: parseAuditCommands(a.lines, a.paneId, a.since),
    }));

    const zips = ZIPS.map((z) => ({
      ...z,
      // A Map is not JSON — record the entries IN ORDER, so a Rust map that reorders is visible.
      zipped: [...zipWorktreeChanges(z.panes, z.changes.map((c) => c ?? undefined)).entries()].map(([paneId, files]) => ({ paneId, files })),
    }));

    const sweeps = SWEEPS.map((s) => ({
      ...s,
      targets: wardenSweepTargets(s.panes, new Set(s.live), new Set(s.completed)),
    }));

    const lives = LIVES.map((l) => ({
      ...l,
      livePanes: [...livePaneIdsOf(
        l.tabs,
        Object.fromEntries(l.ended.map((p) => [p, true])),
        Object.fromEntries(l.disabled.map((p) => [p, true])),
      )],
    }));

    const doc = { summaries, plans, audits, zips, sweeps, lives };

    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(doc, null, 2) + "\n");
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(doc);
  });

  it("the corpus actually reaches the malformed-batch cases", () => {
    // A parity corpus of well-formed inputs cannot test index alignment at all.
    expect(ZIPS.some((z) => z.changes.length < z.panes.length)).toBe(true);
    expect(ZIPS.some((z) => z.changes.length > z.panes.length)).toBe(true);
    expect(ZIPS.some((z) => z.changes.includes(null))).toBe(true);
  });

  it("the corpus reaches BOTH sides of the since floor", () => {
    const floored = AUDITS.filter((a) => (a.since ?? 0) > 0);
    expect(floored.some((a) => parseAuditCommands(a.lines, a.paneId, a.since).length === 0)).toBe(true);
    expect(floored.some((a) => parseAuditCommands(a.lines, a.paneId, a.since).length > 0)).toBe(true);
  });
});
