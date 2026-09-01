// The turn-open GATE, captured from the live TypeScript so Rust can be proved to match it.
//
// ## Why a fixture
//
// Rust already RECORDS the turn boundaries — `bsc-activity run` on UserPromptSubmit, `idle` on Stop,
// `attn` when Claude Code is blocked on a person — and `logs::pane_activity` reads them back. What it
// does not do is decide what they MEAN: `logs_pane_activity` ships rows out and the renderer gates the
// status dot on them. `epic-frontend-logic-over-backend-resources-belongs-in-rust` moves that decision
// to the side that owns the events.
//
// ## The two rules a tidier port would get wrong
//
// Both are places where the CODE and its own doc comment differ, so reading either alone is not enough:
//
//   * The debounce says "a freshly-`idle` pane is still treated as open". The code is
//     `now - activity.at < graceMs` under a plain `state !== "run"`, so a fresh **`attn`** is held open
//     too. That is the shipping behaviour and the port reproduces it.
//   * `<` is exclusive: at EXACTLY `graceMs` elapsed the gate has already released. A corpus of
//     realistic ages never lands on the boundary and passes either version.
//
//     UPDATE_FIXTURES=1 npx vitest run src/app/console/paneActivity.fixtures.gen.test.ts
//
// A regeneration that changes the file is a CHANGE OF BEHAVIOUR. Read the diff before committing it.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  isTurnOpen,
  needsAttention,
  paneActivityFor,
  isTurnOpenDebounced,
  ACTIVITY_IDLE_GRACE_MS,
  type PaneActivity,
} from "@/app/console/lib/paneActivity";

const FIXTURE = join(process.cwd(), "src/app/console/paneActivity.fixtures.json");

const NOW = 1_760_000_000_000;
const G = ACTIVITY_IDLE_GRACE_MS;

/** One row per (state × age), including the ages a realistic corpus never produces. */
const ROWS: { label: string; activity: PaneActivity | undefined; graceMs?: number }[] = [
  { label: "absent — no activity ever recorded", activity: undefined },
  { label: "run, fresh", activity: { pane: "p", state: "run", at: NOW } },
  // A `run` is open however OLD it is: the gate is about the last event, not its age.
  { label: "run, ancient", activity: { pane: "p", state: "run", at: NOW - 10 * 60 * 1000 } },
  { label: "idle, just now", activity: { pane: "p", state: "idle", at: NOW } },
  { label: "idle, inside the grace", activity: { pane: "p", state: "idle", at: NOW - (G - 1) } },
  // THE BOUNDARY. `<` is exclusive, so exactly the grace has already released the gate.
  { label: "idle, exactly at the grace", activity: { pane: "p", state: "idle", at: NOW - G } },
  { label: "idle, past the grace", activity: { pane: "p", state: "idle", at: NOW - (G + 1) } },
  // THE DOC/CODE DIVERGENCE. The comment says the grace is for a freshly-IDLE pane; the code gates on
  // `state !== "run"`, so a fresh `attn` is held open too.
  { label: "attn, fresh — held open despite the doc saying idle", activity: { pane: "p", state: "attn", at: NOW } },
  { label: "attn, past the grace", activity: { pane: "p", state: "attn", at: NOW - (G + 1) } },
  // A FUTURE timestamp (clock skew, or a row written by another machine): `now - at` is negative, which
  // is less than any positive grace, so the gate is open. Not a case any realistic corpus contains.
  { label: "idle, timestamped in the future", activity: { pane: "p", state: "idle", at: NOW + 5000 } },
  // A ZERO grace is a sentinel, not a small number: it disables the debounce entirely, so even a
  // same-millisecond idle is closed.
  { label: "idle, just now, with a zero grace", activity: { pane: "p", state: "idle", at: NOW }, graceMs: 0 },
  { label: "run, with a zero grace", activity: { pane: "p", state: "run", at: NOW - 999_999 }, graceMs: 0 },
  { label: "idle, with a huge grace", activity: { pane: "p", state: "idle", at: NOW - 60_000 }, graceMs: 120_000 },
];

/** The lookup, which is where a wrong pane id silently becomes "no activity". */
const LOOKUPS: { label: string; rows: PaneActivity[] | undefined; paneId: string }[] = [
  { label: "absent list", rows: undefined, paneId: "p" },
  { label: "empty list", rows: [], paneId: "p" },
  {
    label: "first match wins",
    rows: [
      { pane: "a", state: "idle", at: 1 },
      { pane: "p", state: "run", at: 2 },
      { pane: "p", state: "idle", at: 3 },
    ],
    paneId: "p",
  },
  { label: "no match", rows: [{ pane: "a", state: "run", at: 1 }], paneId: "p" },
  { label: "empty pane id matches an empty pane", rows: [{ pane: "", state: "attn", at: 7 }], paneId: "" },
];

function build() {
  return {
    note: "GENERATED from the live TypeScript — see paneActivity.fixtures.gen.test.ts",
    graceMs: ACTIVITY_IDLE_GRACE_MS,
    now: NOW,
    gates: ROWS.map(({ label, activity, graceMs }) => ({
      label,
      activity: activity ?? null,
      graceMs: graceMs ?? null,
      turnOpen: isTurnOpen(activity),
      needsAttention: needsAttention(activity),
      turnOpenDebounced:
        graceMs === undefined ? isTurnOpenDebounced(activity, NOW) : isTurnOpenDebounced(activity, NOW, graceMs),
    })),
    lookups: LOOKUPS.map(({ label, rows, paneId }) => ({
      label,
      rows: rows ?? null,
      paneId,
      // WHOLE RECORD, not just whether one was found — a lookup that returns the wrong row and one that
      // returns none are different bugs and a boolean cannot tell them apart.
      found: paneActivityFor(rows, paneId) ?? null,
    })),
  };
}

describe("the turn-open gate is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const text = JSON.stringify(build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  /** Every state must appear, or the port can hardcode one and pass. */
  it("exercises all three recorded states", () => {
    const seen = new Set(build().gates.map((g) => g.activity?.state).filter(Boolean));
    expect([...seen].sort()).toEqual(["attn", "idle", "run"]);
  });

  /** THE BOUNDARY CASE, asserted as a pair so `<` cannot become `<=` unnoticed. */
  it("pins the grace boundary as exclusive", () => {
    const g = build().gates;
    expect(g.find((x) => x.label === "idle, inside the grace")?.turnOpenDebounced).toBe(true);
    expect(g.find((x) => x.label === "idle, exactly at the grace")?.turnOpenDebounced).toBe(false);
  });

  /** THE DOC/CODE DIVERGENCE, pinned so a port cannot "fix" it into matching the comment. */
  it("holds a fresh attn open, which the doc comment does not say", () => {
    const g = build().gates;
    const fresh = g.find((x) => x.label.startsWith("attn, fresh"));
    expect(fresh?.turnOpenDebounced).toBe(true);
    expect(fresh?.turnOpen).toBe(false); // …while the UNdebounced gate correctly says the agent is not working
    expect(fresh?.needsAttention).toBe(true);
  });

  /** The three predicates must disagree somewhere, or one of them is redundant in the corpus. */
  it("contains a row where each predicate gives a different answer", () => {
    const g = build().gates;
    expect(g.some((x) => x.turnOpen !== x.turnOpenDebounced)).toBe(true);
    expect(g.some((x) => x.needsAttention && !x.turnOpen)).toBe(true);
  });
});
