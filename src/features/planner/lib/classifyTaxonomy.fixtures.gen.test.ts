// The classification TAXONOMY, captured from the live TypeScript so Rust can be held to it.
//
// ## This is not a port — both copies already exist
//
// `APP_TYPES`, `LIFECYCLES` and `SYSTEM_SOURCES` are declared twice: here, and as `pub const` arrays
// in the record `plandb--validate.rs` (plandb compiles from the graph — there is no
// `crates/plandb/src/validate.rs` file), where `validate_classify_config` REJECTS any value outside
// them. So the Rust copy is a GATE, not documentation. They are byte-identical today and nothing
// checks that they stay so.
//
// The failure is silent and asymmetric, which is why it is worth a fixture rather than a comment:
// the app offers an `appType` the CLI refuses, or the planner writes a `lifecycle` the app cannot
// read, and the first symptom is a rejected `bsc plan classify` write nobody expected — or an
// accepted one the app then renders as unknown. Same shape as the two hand-copied gate tables behind
// `a-directors-pane-can-never-write-the-gate-that-lets-it-launch`, where the tables agreed until they
// did not and a director could never launch.
//
//     UPDATE_FIXTURES=1 npx vitest run src/features/planner/lib/classifyTaxonomy.fixtures.gen.test.ts
//
// ## Both drift directions are covered, which is the point
//
//   * a token added to the TYPESCRIPT  → this test goes red, because the committed fixture is stale;
//   * a token added to RUST            → the Rust test goes red, because the fixture does not have it;
//   * a regeneration after a TS change → the Rust test goes red until Rust is brought level.
//
// So neither side can move alone. Nothing is re-homed: the constants stay exactly where they are.
//
// ## Named after the CONCERN, not the module — deliberately
//
// The convention is one fixture per module. `classify-config.ts` carries three separable concerns
// (this vocabulary, a `coerce` that overlaps but does not equal the Rust validator, and derived
// predicates that exist only here), and `triage-the-planner-records-before-any-of-them-is-ported`
// found that the concern — not the record — is the unit of work in this lane. So this file is named
// for the vocabulary, leaving `classifyPredicates.fixtures.json` free for the item that follows.
//
// ## One vocabulary is deliberately ABSENT, and that is recorded rather than hidden
//
// `uiMode` (`"custom" | "external"`) is duplicated the same way — as a TYPE union here and as an
// inline `matches!` in `validate_classify_config`. A type union erases at runtime, so a fixture
// generated from live code CANNOT capture it; writing it by hand would be the very thing this file
// exists to avoid. Binding it needs a `UI_MODES` const exported first. See the change record.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APP_TYPES, LIFECYCLES, SYSTEM_SOURCES } from "@/features/planner/lib/classifyConfig";

const FIXTURE = join(process.cwd(), "src/features/planner/lib/classifyTaxonomy.fixtures.json");

function build() {
  return {
    note: "GENERATED from the live TypeScript — see classifyTaxonomy.fixtures.gen.test.ts",
    // ORDER IS PART OF THE CONTRACT, not incidental: `validate_classify_config` renders the list back
    // to the planner verbatim in its rejection message ("must be one of: …"), so a reordering changes
    // what an agent is told to correct itself with.
    appTypes: [...APP_TYPES],
    lifecycles: [...LIFECYCLES],
    systemSources: [...SYSTEM_SOURCES],
  };
}

describe("the classification taxonomy is captured so both sides are held to it", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const built = build();
    const text = JSON.stringify(built, null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  /** The committed fixture is what Rust reads, so it must be non-empty and the right size. */
  it("carries every axis at its known arity", () => {
    const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(fx.appTypes).toHaveLength(9);
    expect(fx.lifecycles).toHaveLength(5);
    expect(fx.systemSources).toHaveLength(2);
    for (const k of ["appTypes", "lifecycles", "systemSources"]) {
      expect(new Set(fx[k]).size, `${k} must have no duplicates`).toBe(fx[k].length);
      for (const t of fx[k]) expect(typeof t, `${k} tokens are strings`).toBe("string");
    }
  });
});
