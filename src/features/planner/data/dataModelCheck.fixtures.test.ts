// GENERATOR + parity guard for `dataModelCheck.fixtures.json`
// (`the-data-model-check-rejects-what-the-store-will-reject`, lane C7).
//
// `crates/data`'s `DataModel::check` is the gate a model passes before the DuckDB store materializes
// it — and it never checked that entity/field keys are safe SQL identifiers. `ddl::quote_ident` DOES,
// on every create/insert path, so a model could pass `check()` and then fail at DDL time: the gate
// failing to gate. The rule already existed on this side (`checkDataModel`), which is why the Rust
// port is parity-proved against THIS module rather than against a hand-written expectation.
//
// Every case records the WHOLE ordered problem list, because order is part of the contract: the TS
// emits the entity-key problem BEFORE the duplicate-entity problem, and the field-key problem BEFORE
// the duplicate-field problem. A set comparison would call a reordered list identical.
//
// Regenerate:  UPDATE_DATA_MODEL_FIXTURES=1 npx vitest run dataModelCheck.fixtures
// The write is env-gated so CI (which never sets it) can never self-heal a real drift.

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkDataModel, seedDataModels, emptyDataModel, SAFE_IDENT, type DataModel } from "@/features/planner/data/dataModel";

const FILE = join(process.cwd(), "src/features/planner/data/dataModelCheck.fixtures.json");

/** A one-entity model whose entity key is the parameter — the entity-key rules, isolated. */
const entityKeyed = (key: string): DataModel => ({
  id: "m", name: "M", version: 1,
  entities: [{ key, label: "", identity: [], fields: [{ key: "id", type: "string" }] }],
});

/** A one-entity model whose single FIELD key is the parameter — the field-key rules, isolated. */
const fieldKeyed = (key: string): DataModel => ({
  id: "m", name: "M", version: 1,
  entities: [{ key: "account", label: "", identity: [], fields: [{ key, type: "string" }] }],
});

// The corpus. Each entry is an INPUT model; the expectations below are computed by the live
// `checkDataModel`, never typed by hand.
const inputs: { name: string; model: DataModel }[] = [
  // ── clean ──────────────────────────────────────────────────────────────────
  { name: "seeded_crm_is_valid", model: seedDataModels()[0] },
  { name: "empty_model_is_valid", model: emptyDataModel("x") },
  { name: "leading_underscore_key_is_safe", model: entityKeyed("_x9") },

  // ── entity key: the empty/unsafe SENTINEL split ────────────────────────────
  // `.trim()` decides "empty", but SAFE_IDENT is tested against the UNTRIMMED key, so these
  // are genuinely different answers from inputs that all "look blank-ish".
  { name: "entity_key_empty", model: entityKeyed("") },
  { name: "entity_key_whitespace_only", model: entityKeyed("   ") },
  { name: "entity_key_whitespace_padded", model: entityKeyed(" account") },
  { name: "entity_key_trailing_space", model: entityKeyed("account ") },

  // ── entity key: unsafe shapes the store's quote_ident rejects ──────────────
  { name: "entity_key_hyphen", model: entityKeyed("a-b") },
  { name: "entity_key_leading_digit", model: entityKeyed("1abc") },
  { name: "entity_key_sql_injection", model: entityKeyed("droptable; --") },
  { name: "entity_key_non_ascii_letter", model: entityKeyed("café") },

  // ── field key: the same split, one level down ──────────────────────────────
  { name: "field_key_empty", model: fieldKeyed("") },
  { name: "field_key_whitespace_only", model: fieldKeyed("  ") },
  { name: "field_key_whitespace_padded", model: fieldKeyed(" id") },
  { name: "field_key_hyphen", model: fieldKeyed("ref-bad") },
  { name: "field_key_leading_digit", model: fieldKeyed("9lives") },

  // ── ORDER: a key problem must precede the duplicate problem, at both levels ─
  {
    name: "entity_unsafe_and_duplicate_orders_key_first",
    model: {
      id: "m", name: "M", version: 1,
      entities: [
        { key: "a-b", label: "", identity: [], fields: [] },
        { key: "a-b", label: "", identity: [], fields: [] },
      ],
    },
  },
  {
    name: "field_unsafe_and_duplicate_orders_key_first",
    model: {
      id: "m", name: "M", version: 1,
      entities: [{
        key: "account", label: "", identity: [],
        fields: [{ key: "a-b", type: "string" }, { key: "a-b", type: "string" }],
      }],
    },
  },
  {
    name: "empty_entity_key_prefixes_its_field_messages",
    model: {
      id: "m", name: "M", version: 1,
      entities: [{ key: "", label: "", identity: [], fields: [{ key: "", type: "string" }] }],
    },
  },

  // ── every rule at once: pins the full ordering across all six rule kinds ────
  {
    name: "all_rules_together",
    model: {
      id: "m", name: "bad", version: 1,
      entities: [
        {
          key: "a-b", label: "", identity: ["missing"],
          fields: [
            { key: "id", type: "string" },
            { key: "id", type: "string" },
            { key: "ref-bad", type: "ref", ref: "ghost" },
            { key: "owner", type: "ref" },
            { key: "", type: "string" },
          ],
        },
        { key: "a-b", label: "", identity: [], fields: [] },
        { key: "account", label: "", identity: [], fields: [{ key: "acct", type: "ref", ref: "account" }] },
      ],
    },
  },
];

const cases = inputs.map(({ name, model }) => ({ name, model, problems: checkDataModel(model) }));

// The identifier predicate, sampled over the boundary so the Rust side can prove its own predicate
// AGREES rather than merely resembling. These are the exact strings `ddl::quote_ident` is fed.
const IDENT_SAMPLES = [
  "account", "_x9", "A", "_", "a0", "z_9Z",
  "", " ", "  ", " a", "a ", "a-b", "1abc", "droptable; --", "café", "a.b", "a b", "0", "$x", "a\tb",
];
const identSamples = IDENT_SAMPLES.map((s) => ({ ident: s, safe: SAFE_IDENT.test(s) }));

const generated = {
  $comment:
    "GENERATED from the live `@/features/planner/data/dataModel` by dataModelCheck.fixtures.test.ts — " +
    "never hand-authored. Read by crates/data/src/schema.rs to prove DataModel::check reports the same " +
    "problems, in the same ORDER, as checkDataModel. `problems` is the WHOLE ordered list per case. " +
    "Rust renders interpolated identifiers in backticks where this side uses double quotes (the house " +
    "style in schema.rs); the Rust test normalizes that ONE character and asserts the normalization is " +
    "not inert. `identSamples` pins the SAFE_IDENT predicate against ddl::quote_ident's, which must " +
    "agree character-class for character-class. Regenerate: UPDATE_DATA_MODEL_FIXTURES=1 npx vitest run dataModelCheck.fixtures",
  cases,
  identSamples,
};

const serialised = JSON.stringify(generated, null, 2) + "\n";

describe("dataModelCheck.fixtures.json — checkDataModel parity corpus", () => {
  it("regenerates the committed fixture when UPDATE_DATA_MODEL_FIXTURES=1 (env-gated so CI can't self-heal)", () => {
    if (process.env.UPDATE_DATA_MODEL_FIXTURES) writeFileSync(FILE, serialised);
    expect(existsSync(FILE), "dataModelCheck.fixtures.json missing — run with UPDATE_DATA_MODEL_FIXTURES=1").toBe(true);
  });

  it("still matches the live checkDataModel output", () => {
    const onDisk = JSON.parse(readFileSync(FILE, "utf8").replace(/\r\n/g, "\n"));
    expect(onDisk.cases).toEqual(JSON.parse(JSON.stringify(cases)));
    expect(onDisk.identSamples).toEqual(identSamples);
  });

  it("the corpus SEPARATES the sentinels it exists to pin", () => {
    const p = (n: string) => cases.find((c) => c.name === n)!.problems;
    // whitespace-only trims to blank → "empty"; whitespace-padded does not → "not a safe identifier"
    expect(p("entity_key_whitespace_only")).toEqual(["an entity has an empty key"]);
    expect(p("entity_key_whitespace_padded")).toEqual(['entity key " account" is not a safe identifier']);
    expect(p("entity_key_whitespace_only")).not.toEqual(p("entity_key_whitespace_padded"));
    expect(p("field_key_whitespace_only")).not.toEqual(p("field_key_whitespace_padded"));
    // a clean model really is clean, or every "no problems" assertion below proves nothing
    expect(p("seeded_crm_is_valid")).toEqual([]);
    expect(p("leading_underscore_key_is_safe")).toEqual([]);
  });

  it("the ORDER cases really do put the key problem before the duplicate problem", () => {
    const e = cases.find((c) => c.name === "entity_unsafe_and_duplicate_orders_key_first")!.problems;
    expect(e.findIndex((x) => x.includes("not a safe identifier"))).toBeLessThan(
      e.findIndex((x) => x.includes("duplicate entity key")),
    );
    const f = cases.find((c) => c.name === "field_unsafe_and_duplicate_orders_key_first")!.problems;
    expect(f.findIndex((x) => x.includes("not a safe identifier"))).toBeLessThan(
      f.findIndex((x) => x.includes("duplicate field key")),
    );
  });

  it("the ident corpus straddles the boundary (both answers present, and the blank/padded split)", () => {
    expect(identSamples.some((s) => s.safe)).toBe(true);
    expect(identSamples.some((s) => !s.safe)).toBe(true);
    expect(identSamples.find((s) => s.ident === "_x9")!.safe).toBe(true);
    expect(identSamples.find((s) => s.ident === "café")!.safe).toBe(false);
    expect(identSamples.find((s) => s.ident === "")!.safe).toBe(false);
  });
});
