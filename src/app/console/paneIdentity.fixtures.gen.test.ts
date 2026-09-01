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
} from "@/app/console/lib/paneIdentity";

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
});
