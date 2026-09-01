// The pane-id GRAMMAR, captured from the LIVE TypeScript so Rust can be proved to match it.
//
// ## Why a fixture rather than two hand-written tables
//
// A pane id keys every backend-side map — the pty ledger, the worktree tree, the sandbox Linux user
// and its 700 home, the plan row, the coord.log project scope. The grammar that mints and reads it
// lives in `paneIdentity.ts`, in the renderer, and Rust re-states pieces of it in four places
// (`must_be_gated`, `director_project`, `worker_pane`, `coord_project_of`), none derived from the
// grammar. `epic-frontend-logic-over-backend-resources-belongs-in-rust` moves the derivation.
//
// THE MIRROR HAS ALREADY BROKEN ONCE, AND IT DEADLOCKED. `paneNeedsGate` exists because Rust and the
// frontend disagreed about which panes need a gate file: Rust refused a gated pane whose cwd had no
// gate, and the only writer of that file sat behind a frontend flag that is false for a restored pane,
// so the pane could never write the file that would let it launch — silently. Measured at 30 hubs with
// no gate file and 10 directors refused in one run.
//
// What guards it today is TWO HAND-COPIED TABLES: `paneNeedsGate.test.ts` says in a comment that it
// asserts "THE SAME TABLE" the Rust test does. Two tables that must agree, maintained by hand, are the
// arrangement this fixture replaces — one artifact, read by both sides, regenerated deliberately:
//
//     UPDATE_FIXTURES=1 npx vitest run src/app/console/paneIdentity.fixtures.gen.test.ts
//
// A regeneration that changes the file is a CHANGE OF GRAMMAR. Read the diff before committing it.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  positionalPaneId,
  manualPaneId,
  fleetPaneId,
  directorPaneId,
  triagePaneId,
  isManualPaneId,
  isPlanningPaneId,
  paneNeedsGate,
  parsePaneIdentity,
  sandboxUserIdentity,
  paneCwdRecovery,
  paneIdFor,
  paneBelongsToTab,
} from "@/app/console/lib/paneIdentity";
import {
  aggregateTabState,
  clearTabStatuses,
  paneCountForLayout,
  type PaneStatus,
  type StatusTab,
} from "@/app/console/lib/paneStatus";

const FIXTURE = join(process.cwd(), "src/app/console/paneIdentity.fixtures.json");

/**
 * ONE corpus, run through every classifier — so "Rust agrees about this id" is a single claim rather
 * than four lists that can drift apart. It deliberately includes the shapes the grammar's own doc
 * comment calls out as AMBIGUOUS, because those are what a tidier port would quietly change.
 */
const IDS = [
  // Minted, well-formed.
  "t0p0", "t12p3", "t10p20",
  "man:tab_abc:p2", "man:tab-with-dashes:p0", "man:tab_abc:p007",
  "studio-code:api", "studio-code:director", "studio-code:owner/name:triage",
  "alpha:web", "alpha:repo:triage",
  // The planner's deliberate exception to the <key>:<stream> scheme.
  "planning_studio-code", "planning_alpha",
  // DOCUMENTED AMBIGUITIES. A stream literally named `director`, and a two-part `<key>:triage`,
  // classify as director/worker respectively — real planner stream ids never collide with those
  // reserved tails, but a port must reproduce the collision rather than "fix" it.
  "studio-code:triage", "studio-code:director:extra", "studio-code:a:b:triage",
  // A tabId containing a colon — the manual regex is greedy, so it wins over the worker shape.
  "man:a:b:p3",
  // A `man:` prefix that does NOT match the manual regex falls through to the WORKER shape, with
  // "man" read as a project key. Ugly and real.
  "man:tab:p", "man:", "man:a:p1:p2",
  // `(.+)` needs at least one character, so an EMPTY tab id is not the manual shape either — it
  // falls through to the worker rule with "man" read as a project key.
  "man::p0",
  // Empty segments, in every position.
  "", ":director", "studio-code:", "studio-code::", ":triage", "::triage", ":",
  // An EMPTY repo segment still classifies as triage (repo ""), and the cwd recovery then declines
  // because it needs a repo — two rules reading one id and reaching different answers.
  "studio-code::triage",
  // Not the grammar at all.
  "scratch", "t0p", "tp0", "debug-studio:req-7",
];

/** Minting is the inverse the parser is checked against; both directions are in the fixture. */
const MINTS = {
  positional: [[0, 0], [12, 3], [10, 20]] as [number, number][],
  manual: [["tab_abc", 2], ["tab-with-dashes", 0], ["a:b", 3]] as [string, number][],
  fleet: [["studio-code", "api"], ["alpha", "web"]] as [string, string][],
  director: ["studio-code", "alpha"],
  triage: [["studio-code", "owner/name"], ["alpha", "repo"]] as [string, string][],
};

/** The sandbox-user decision reads the grammar, and BOTH arguments matter. */
const SANDBOX: [string, string | undefined][] = [
  ["studio-code:api", "bsc-agent-sandbox"],
  ["studio-code:director", "bsc-agent-sandbox"],
  ["studio-code:owner/name:triage", "bsc-agent-sandbox"],
  ["man:tab_abc:p2", "bsc-agent-sandbox"],
  ["t0p0", "bsc-agent-sandbox"],
  ["planning_studio-code", "bsc-agent-sandbox"],
  ["scratch", "bsc-agent-sandbox"],
  // No distro ⇒ never a per-agent user, whatever the pane is.
  ["studio-code:api", undefined],
  // An EMPTY distro is falsy in the reducer, exactly like an absent one.
  ["studio-code:api", ""],
  ["studio-code:director", undefined],
];

/**
 * The tab shapes `paneIdFor` dispatches on, in the order its own doc comment lists them: a minted
 * `paneIds[idx]` wins, then a `kind`-bearing (fleet/triage) tab keeps the positional id, then a manual
 * tab with a stable `id` mints a `man:` id, then an id-less legacy tab falls back to positional.
 *
 * Each shape appears with a pane index that IS minted and one that is not, because the minted-wins
 * rule is per-INDEX: a fleet tab with two minted ids still falls through to positional for cell 2.
 */
const TABS: { label: string; tab: StatusTab }[] = [
  { label: "legacy id-less", tab: { layout: "2×1" } },
  { label: "manual with stable id", tab: { id: "tab_abc", layout: "2×2" } },
  { label: "build kind, no mints", tab: { kind: "build", id: "tab_fleet", layout: "2×1" } },
  {
    label: "build kind with mints",
    tab: { kind: "build", id: "tab_f2", layout: "2×2", paneIds: ["studio-code:director", "studio-code:api"] },
  },
  {
    label: "triage kind, sparse mints",
    // A HOLE in paneIds: index 0 is absent, so cell 0 falls through to positional while cell 1 is
    // minted. A port that treats paneIds as all-or-nothing passes every dense case and fails here.
    tab: { kind: "triage", id: "tab_t", layout: "2×1", paneIds: [undefined as unknown as string, "alpha:repo:triage"] },
  },
  {
    // THE SEPARATING TAB. Every other minted tab here also carries a `kind`, and for those the rule
    // after a hole is positional either way — so an all-or-nothing reading of `paneIds` is
    // indistinguishable. Only a tab with mints and NO kind can tell them apart: the hole must fall
    // through to the MANUAL rule (`man:tab_m2:p0`), not to positional. Added after a deliberate
    // all-or-nothing mutation failed to bite, which is the corpus answering rather than the code.
    label: "manual with sparse mints",
    tab: { id: "tab_m2", layout: "2×1", paneIds: [undefined as unknown as string, "studio-code:api"] },
  },
  // SENTINEL: a malformed layout is not a case of any grid — `paneCountForLayout` falls back to 1.
  { label: "malformed layout", tab: { id: "tab_bad", layout: "not-a-layout" } },
  { label: "one-cell layout", tab: { id: "tab_one", layout: "1×1" } },
];

/** Layout strings, including the ones that are NOT grids. */
const LAYOUTS = ["1×1", "2×1", "2×2", "3×2", "4×4", "not-a-layout", "", "2", "×", "0×3", "2×0"];

/**
 * Status maps to roll up. The vocabulary is three values, so the interesting cases are the
 * PRECEDENCE ones (a run beside an idle) and the ones where a pane is excluded rather than counted.
 */
const ROLLUPS: { label: string; tabIdx: number; tab: StatusTab; statuses: Record<string, PaneStatus>; disabled: Record<string, boolean> }[] = [
  { label: "empty map is idle", tabIdx: 0, tab: TABS[0].tab, statuses: {}, disabled: {} },
  { label: "any run dominates", tabIdx: 0, tab: TABS[0].tab, statuses: { t0p0: "idle", t0p1: "run" }, disabled: {} },
  { label: "on without run", tabIdx: 0, tab: TABS[0].tab, statuses: { t0p0: "on", t0p1: "idle" }, disabled: {} },
  // A run in a DISABLED cell must not pull the tab into "run" — the exclusion is the rule.
  { label: "disabled run is excluded", tabIdx: 0, tab: TABS[0].tab, statuses: { t0p0: "run", t0p1: "on" }, disabled: { t0p0: true } },
  { label: "all disabled is idle", tabIdx: 0, tab: TABS[0].tab, statuses: { t0p0: "run", t0p1: "run" }, disabled: { t0p0: true, t0p1: true } },
  // A status keyed by a pane OUTSIDE the current layout is ignored: shrinking the grid drops it.
  { label: "out-of-grid status ignored", tabIdx: 0, tab: TABS[6].tab, statuses: { t0p0: "idle", t0p1: "run", t0p5: "run" }, disabled: {} },
  { label: "manual tab rolls up by man: id", tabIdx: 3, tab: TABS[1].tab, statuses: { "man:tab_abc:p0": "on", "man:tab_abc:p3": "run" }, disabled: {} },
  { label: "minted build ids roll up", tabIdx: 1, tab: TABS[3].tab, statuses: { "studio-code:director": "on", "studio-code:api": "run" }, disabled: {} },
  { label: "minted id disabled", tabIdx: 1, tab: TABS[3].tab, statuses: { "studio-code:api": "run" }, disabled: { "studio-code:api": true } },
  { label: "sparse mints: hole falls through to positional", tabIdx: 2, tab: TABS[4].tab, statuses: { t2p0: "run", "alpha:repo:triage": "idle" }, disabled: {} },
];

/**
 * `clearTabStatuses` gets its OWN corpus, because reusing the rollup one proved nothing.
 *
 * MEASURED while writing this: every rollup case is keyed entirely by ids the tab owns, so the clear
 * emptied the map every time — and a port that ignored membership and returned `{}` would have passed
 * all ten. That is the separating input the method warns about: the interesting case is a map holding
 * BOTH a pane this tab owns and a pane it does not, where the second must survive.
 */
const CLEARS: { label: string; tabIdx: number; tab: StatusTab; statuses: Record<string, PaneStatus> }[] = [
  {
    label: "drops own positional, keeps another tab's",
    tabIdx: 0,
    tab: TABS[0].tab,
    statuses: { t0p0: "run", t0p1: "on", t1p0: "run", t2p3: "on" },
  },
  {
    label: "drops own manual, keeps a different manual tab's",
    tabIdx: 3,
    tab: TABS[1].tab,
    statuses: { "man:tab_abc:p0": "run", "man:tab_other:p0": "on", t3p0: "run" },
  },
  {
    label: "drops minted ids it owns, keeps a minted id it does not",
    tabIdx: 1,
    tab: TABS[3].tab,
    statuses: { "studio-code:director": "run", "studio-code:api": "on", "alpha:web": "run" },
  },
  {
    label: "keeps everything when nothing belongs",
    tabIdx: 5,
    tab: TABS[1].tab,
    statuses: { "man:tab_other:p1": "run", "alpha:web": "on" },
  },
  { label: "empty map stays empty", tabIdx: 0, tab: TABS[0].tab, statuses: {} },
  {
    label: "an unparseable id is never anyone's, so it survives",
    tabIdx: 0,
    tab: TABS[0].tab,
    statuses: { t0p0: "run", scratch: "on", "": "idle" },
  },
];

/** Membership, which is what a stale-status clear is built on. */
const MEMBERSHIP: { paneId: string; tabIdx: number; tabLabel: string }[] = [];
for (const { label } of TABS) {
  for (const paneId of ["t0p0", "t2p1", "man:tab_abc:p2", "studio-code:api", "studio-code:director", "alpha:repo:triage", "planning_alpha", "", "scratch"]) {
    MEMBERSHIP.push({ paneId, tabIdx: 0, tabLabel: label });
    MEMBERSHIP.push({ paneId, tabIdx: 2, tabLabel: label });
  }
}

function build() {
  return {
    note: "GENERATED from the live TypeScript — see paneIdentity.fixtures.gen.test.ts",
    mints: {
      positional: MINTS.positional.map(([t, p]) => ({ tabIdx: t, paneIdx: p, id: positionalPaneId(t, p) })),
      manual: MINTS.manual.map(([t, p]) => ({ tabId: t, paneIdx: p, id: manualPaneId(t, p) })),
      fleet: MINTS.fleet.map(([k, s]) => ({ projectKey: k, streamId: s, id: fleetPaneId(k, s) })),
      director: MINTS.director.map((k) => ({ projectKey: k, id: directorPaneId(k) })),
      triage: MINTS.triage.map(([k, r]) => ({ projectKey: k, repo: r, id: triagePaneId(k, r) })),
    },
    ids: IDS.map((id) => ({
      id,
      isManual: isManualPaneId(id),
      isPlanning: isPlanningPaneId(id),
      needsGate: paneNeedsGate(id),
      parsed: parsePaneIdentity(id),
      cwdRecovery: paneCwdRecovery(id),
    })),
    sandbox: SANDBOX.map(([id, distro]) => ({
      id,
      distro: distro ?? null,
      user: sandboxUserIdentity(id, distro),
    })),
    // ── the rollup half (`the-pane-status-rollup-is-derived-in-rust-at-parity`) ──
    layouts: LAYOUTS.map((layout) => ({ layout, count: paneCountForLayout(layout) })),
    idFor: TABS.flatMap(({ label, tab }) =>
      [0, 1, 2, 3].flatMap((paneIdx) =>
        [0, 2].map((tabIdx) => ({ tabLabel: label, tabIdx, paneIdx, id: paneIdFor(tab, tabIdx, paneIdx) })),
      ),
    ),
    // `paneIdFor` takes an OPTIONAL tab and falls back to positional — its own separate case, since a
    // corpus of real tabs never exercises the undefined arm.
    idForNoTab: [0, 3].flatMap((tabIdx) => [0, 2].map((paneIdx) => ({ tabIdx, paneIdx, id: paneIdFor(undefined, tabIdx, paneIdx) }))),
    membership: MEMBERSHIP.map(({ paneId, tabIdx, tabLabel }) => ({
      paneId,
      tabIdx,
      tabLabel,
      belongs: paneBelongsToTab(paneId, TABS.find((t) => t.label === tabLabel)!.tab, tabIdx),
    })),
    rollups: ROLLUPS.map(({ label, tabIdx, tab, statuses, disabled }) => ({
      label,
      tabIdx,
      layout: tab.layout,
      statuses,
      disabled,
      state: aggregateTabState(tab, tabIdx, statuses, disabled),
    })),
    clears: CLEARS.map(({ label, tabIdx, tab: clearTab, statuses }) => ({
      label,
      tabIdx,
      statuses,
      // WHOLE MAP recorded, not a count — a port that clears too much and one that clears too little
      // both survive a length check (trap 5: a lossy artifact looks exactly like a passing test).
      remaining: clearTabStatuses(statuses, clearTab, tabIdx),
    })),
  };
}

describe("the pane-id grammar is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const built = build();
    const text = JSON.stringify(built, null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") {
      writeFileSync(FIXTURE, text);
    }
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("covers every kind the parser can return, so a new one cannot slip past the port", () => {
    const built = build();
    const kinds = new Set(built.ids.map((c) => c.parsed?.kind).filter(Boolean));
    expect([...kinds].sort()).toEqual(["director", "manual", "positional", "triage", "worker"]);
  });

  it("covers the REJECTIONS, which are the half a port drops", () => {
    const built = build();
    expect(built.ids.filter((c) => c.parsed === null).length).toBeGreaterThanOrEqual(7);
  });

  /** The two must be able to disagree in the fixture, or it cannot prove they are separate rules. */
  it("contains an id that PARSES as a worker yet needs no gate", () => {
    const built = build();
    const odd = built.ids.filter((c) => c.parsed?.kind === "worker" && !c.needsGate);
    expect(odd.map((c) => c.id)).toContain("studio-code::");
  });

  /** All three rollup values must appear, or the port can hardcode one and pass. */
  it("exercises every status the rollup can produce", () => {
    const built = build();
    expect([...new Set(built.rollups.map((r) => r.state))].sort()).toEqual(["idle", "on", "run"]);
  });

  /** The minted-wins rule is per-INDEX. Without a tab whose paneIds have a HOLE, a port that treats
   *  them as all-or-nothing passes every case here. */
  it("has a tab whose minted ids are sparse, so the fallback is per-cell", () => {
    const built = build();
    const sparse = built.idFor.filter((c) => c.tabLabel === "triage kind, sparse mints");
    expect(sparse.some((c) => c.id.startsWith("t"))).toBe(true); // cell 0 fell through
    expect(sparse.some((c) => c.id === "alpha:repo:triage")).toBe(true); // cell 1 was minted
  });

  /** A disabled RUN must be able to change the answer, or the exclusion rule is untested. */
  it("has a rollup where disabling a pane changes the tab state", () => {
    const built = build();
    const c = built.rollups.find((r) => r.label === "disabled run is excluded");
    expect(c?.state).toBe("on"); // "run" if the disabled cell were counted
  });

  /** `clearTabStatuses` must both KEEP and DROP, and do BOTH in a single case.
   *
   *  The last part is the one that matters: a case that only drops is satisfied by returning `{}`, and
   *  a case that only keeps is satisfied by returning the input unchanged. Only a map where some
   *  entries go and others stay can tell a membership test from either constant. */
  it("has a clear that drops some entries and keeps others in the SAME map", () => {
    const built = build();
    const mixed = built.clears.filter(
      (c) => Object.keys(c.remaining).length > 0 && Object.keys(c.remaining).length < Object.keys(c.statuses).length,
    );
    expect(mixed.map((c) => c.label)).toContain("drops own positional, keeps another tab's");
    expect(mixed.length).toBeGreaterThanOrEqual(3);
    // …and the two degenerate ends are present too, so neither is what the mixed cases rest on.
    expect(built.clears.some((c) => Object.keys(c.remaining).length === Object.keys(c.statuses).length && Object.keys(c.statuses).length > 0)).toBe(true);
    expect(built.clears.some((c) => Object.keys(c.remaining).length === 0 && Object.keys(c.statuses).length === 0)).toBe(true);
  });
});
