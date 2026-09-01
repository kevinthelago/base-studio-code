//! The canonical **Data Model** — the target schema migration/collection load into.
//!
//! These types mirror the TypeScript `DataModel` authoring side (#780) so a model
//! round-trips as JSON between the planner / UI and this crate. The store (#781)
//! materializes a model as typed tables; the director reconciles by [`Entity::identity`]
//! (#785).

use serde::{Deserialize, Serialize};

use crate::error::{DataError, Result};

/// A named, versioned canonical schema: the single source of truth a project loads into.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DataModel {
    pub name: String,
    #[serde(default)]
    pub version: u32,
    pub entities: Vec<Entity>,
}

/// One entity (table) in the Data Model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    /// Stable key / table name (e.g. `account`).
    pub key: String,
    #[serde(default)]
    pub label: String,
    pub fields: Vec<Field>,
    /// Field keys that form the natural / merge identity — the fields that decide when
    /// two records describe the same real-world thing (used for reconciliation, #785).
    /// Empty ⇒ rows are identified positionally at load time.
    #[serde(default)]
    pub identity: Vec<String>,
}

/// A field's logical type. Drives the column type the store creates and how a raw
/// string cell is coerced at load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    String,
    Number,
    Bool,
    Date,
    Money,
    /// A reference to another entity (stored as that entity's identity value).
    Ref,
    Enum,
}

/// One field (column) on an [`Entity`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(rename = "type")]
    pub ty: FieldType,
    #[serde(default)]
    pub required: bool,
    /// For [`FieldType::Ref`]: the target entity key.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// For [`FieldType::Enum`]: the allowed values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<String>,
    /// Optional declarative validation rule id (read by the quality gate, #783).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validate: Option<String>,
}

/// Is `name` usable as a SQL identifier in the store?
///
/// `[A-Za-z_][A-Za-z0-9_]*`, and ASCII deliberately: `café` is a perfectly good name and a bad
/// column, so this rejects it rather than letting the store decide later. The TypeScript authoring
/// side spells the same rule as `SAFE_IDENT` and the two are pinned against each other by
/// `checkDataModel` parity (`identSamples` in dataModelCheck.fixtures.json).
///
/// This is the ONE definition: [`crate::ddl::quote_ident`] calls it, so the layer that admits a
/// model and the layer that quotes it cannot disagree.
pub fn is_safe_ident(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => chars.all(|c| c.is_ascii_alphanumeric() || c == '_'),
        _ => false,
    }
}

impl DataModel {
    /// Find an entity by key.
    pub fn entity(&self, key: &str) -> Option<&Entity> {
        self.entities.iter().find(|e| e.key == key)
    }

    /// Structural validation, independent of any data: SAFE IDENTIFIERS, unique entity/field keys,
    /// identity fields that actually exist, and `ref` fields that point at a real
    /// entity. Returns the list of problems (empty ⇒ valid) as a single error.
    ///
    /// The identifier rule is what makes this a real gate. Every create/insert path runs each key
    /// through [`crate::ddl::quote_ident`], which rejects anything outside `[A-Za-z_][A-Za-z0-9_]*`;
    /// until `the-data-model-check-rejects-what-the-store-will-reject` this method did not check it,
    /// so a model could pass validation and then fail at DDL time with the load half-done.
    ///
    /// The problems, their wording and their ORDER are parity-proved against the TypeScript
    /// `checkDataModel` over a generated corpus — see `data_model_check_matches_the_typescript`.
    pub fn check(&self) -> Result<()> {
        let problems = self.problems();
        if problems.is_empty() {
            Ok(())
        } else {
            Err(DataError::Schema(problems.join("; ")))
        }
    }

    /// The same validation as [`DataModel::check`], as the ORDERED list an editor surfaces — the
    /// shape the TypeScript `checkDataModel` returns, and the shape parity is asserted on.
    ///
    /// `check` joins these with `"; "`, and a key may legitimately CONTAIN that separator
    /// (`droptable; --` is in the corpus), so the joined string cannot be split back into the list.
    /// Anything comparing problems one by one must come through here.
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for e in &self.entities {
            // Ordered exactly as the TypeScript emits them: the key's own problem precedes the
            // duplicate problem, and blankness is tested on the TRIMMED key while safety is tested
            // on the untrimmed one — so "   " is empty and " account" is unsafe. They are different
            // answers and the corpus keeps them apart.
            if e.key.trim().is_empty() {
                problems.push("an entity has an empty key".to_string());
            } else if !is_safe_ident(&e.key) {
                problems.push(format!("entity key `{}` is not a safe identifier", e.key));
            }
            if !seen.insert(&e.key) {
                problems.push(format!("duplicate entity key `{}`", e.key));
            }
            let mut fseen = std::collections::HashSet::new();
            for f in &e.fields {
                if f.key.trim().is_empty() {
                    problems.push(format!("{}: a field has an empty key", e.key));
                } else if !is_safe_ident(&f.key) {
                    problems.push(format!("{}.{}: not a safe identifier", e.key, f.key));
                }
                if !fseen.insert(&f.key) {
                    problems.push(format!("{}: duplicate field key `{}`", e.key, f.key));
                }
                if f.ty == FieldType::Ref {
                    match &f.reference {
                        Some(target) if self.entities.iter().any(|x| &x.key == target) => {}
                        Some(target) => problems
                            .push(format!("{}.{}: ref to unknown entity `{}`", e.key, f.key, target)),
                        None => problems
                            .push(format!("{}.{}: ref field has no target entity", e.key, f.key)),
                    }
                }
            }
            for id in &e.identity {
                if !e.fields.iter().any(|f| &f.key == id) {
                    problems.push(format!("{}: identity field `{}` is not a field", e.key, id));
                }
            }
        }
        problems
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(key: &str, ty: FieldType) -> Field {
        Field { key: key.into(), label: String::new(), ty, required: false, reference: None, enum_values: vec![], validate: None }
    }

    fn crm() -> DataModel {
        DataModel {
            name: "CRM".into(),
            version: 1,
            entities: vec![
                Entity { key: "account".into(), label: "Account".into(),
                    fields: vec![field("id", FieldType::String), field("name", FieldType::String)],
                    identity: vec!["id".into()] },
                Entity { key: "contact".into(), label: "Contact".into(),
                    fields: vec![field("id", FieldType::String), {
                        let mut f = field("account", FieldType::Ref); f.reference = Some("account".into()); f
                    }],
                    identity: vec!["id".into()] },
            ],
        }
    }

    #[test]
    fn finds_entities_and_validates_a_good_model() {
        let m = crm();
        assert!(m.entity("account").is_some());
        assert!(m.entity("nope").is_none());
        assert!(m.check().is_ok());
    }

    #[test]
    fn flags_dangling_ref_unknown_identity_and_dupes() {
        let mut m = crm();
        // dangling ref
        m.entities[1].fields[1].reference = Some("ghost".into());
        // identity field that doesn't exist
        m.entities[0].identity = vec!["missing".into()];
        // duplicate entity key
        m.entities.push(m.entities[0].clone());
        let err = m.check().unwrap_err().to_string();
        assert!(err.contains("unknown entity `ghost`"), "{err}");
        assert!(err.contains("identity field `missing`"), "{err}");
        assert!(err.contains("duplicate entity key `account`"), "{err}");
    }

    // ── parity with the TypeScript `checkDataModel` ────────────────────────────────────────────
    //
    // The corpus is GENERATED from the live record by
    // `src/features/planner/data/dataModelCheck.fixtures.test.ts`; nothing here is hand-written.
    // Renaming that file means updating FIXTURE below, exactly as `find_fixture` callers must.

    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/features/planner/data/dataModelCheck.fixtures.json"
    );

    #[derive(serde::Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
        #[serde(rename = "identSamples")]
        ident_samples: Vec<IdentSample>,
    }
    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        model: DataModel,
        problems: Vec<String>,
    }
    #[derive(serde::Deserialize)]
    struct IdentSample {
        ident: String,
        safe: bool,
    }

    /// The ONE difference between the two sides' wording: this file quotes interpolated identifiers
    /// in backticks (the house style in `schema.rs`), the TypeScript in double quotes. Nothing else
    /// is normalized — a wording or ordering change on either side must fail.
    fn ts_to_rust_quotes(msg: &str) -> String {
        msg.replace('"', "`")
    }

    fn fixture() -> Fixture {
        let raw = std::fs::read_to_string(FIXTURE).unwrap_or_else(|e| {
            panic!("dataModelCheck.fixtures.json unreadable at {FIXTURE}: {e}\n\
                    Regenerate: UPDATE_DATA_MODEL_FIXTURES=1 npx vitest run dataModelCheck.fixtures")
        });
        serde_json::from_str(&raw).expect("dataModelCheck.fixtures.json is not the expected shape")
    }

    #[test]
    fn data_model_check_matches_the_typescript() {
        let fx = fixture();
        assert!(fx.cases.len() >= 20, "corpus shrank to {} cases", fx.cases.len());

        for c in &fx.cases {
            let expected: Vec<String> = c.problems.iter().map(|m| ts_to_rust_quotes(m)).collect();
            // WHOLE list, IN ORDER — a set comparison would call a reordered list identical, and the
            // ordering (key problem before duplicate problem) is precisely what this pins.
            assert_eq!(self_problems(&c.model), expected, "case `{}`", c.name);
            // ...and the two must agree on VALID too, or every empty expectation proves nothing.
            assert_eq!(c.model.check().is_ok(), expected.is_empty(), "case `{}` ok-ness", c.name);
        }
    }

    fn self_problems(m: &DataModel) -> Vec<String> {
        m.problems()
    }

    #[test]
    fn the_quote_normalization_is_not_inert() {
        // If `ts_to_rust_quotes` ever became a no-op the parity test above would still pass on every
        // message that carries no identifier — and silently stop checking the ones that do.
        let fx = fixture();
        let touched = fx
            .cases
            .iter()
            .flat_map(|c| c.problems.iter())
            .filter(|m| ts_to_rust_quotes(m) != **m)
            .count();
        assert!(touched >= 5, "only {touched} messages carry a quoted identifier — corpus too thin");
        assert_eq!(ts_to_rust_quotes(r#"a "b" c"#), "a `b` c");
    }

    #[test]
    fn the_identifier_predicate_matches_the_typescript_safe_ident() {
        let fx = fixture();
        assert!(fx.ident_samples.len() >= 20, "ident corpus shrank");
        for s in &fx.ident_samples {
            assert_eq!(is_safe_ident(&s.ident), s.safe, "ident {:?}", s.ident);
        }
        // both answers really occur, or this asserts nothing
        assert!(fx.ident_samples.iter().any(|s| s.safe));
        assert!(fx.ident_samples.iter().any(|s| !s.safe));
    }

    #[test]
    fn the_store_quotes_exactly_what_the_model_admits() {
        // The whole point of routing `quote_ident` through `is_safe_ident`: a model that passes
        // `check` can never fail at DDL time. Proved over the same corpus, on the real function.
        let fx = fixture();
        for s in &fx.ident_samples {
            assert_eq!(
                crate::ddl::quote_ident(&s.ident).is_ok(),
                s.safe,
                "quote_ident disagrees with the model on {:?}",
                s.ident
            );
        }
    }

    #[test]
    fn a_model_that_passes_check_survives_create_table() {
        // The end-to-end statement of the defect, on the path that actually broke: every key of a
        // model `check` accepted must quote. Before this change an unsafe key passed `check` and
        // blew up here.
        let mut m = crm();
        m.entities[0].key = "a-b".into();
        assert!(m.check().is_err(), "an unsafe entity key must not pass check");
        assert!(crate::ddl::quote_ident("a-b").is_err(), "...and would have failed at DDL time");

        let good = crm();
        assert!(good.check().is_ok());
        for e in &good.entities {
            assert!(crate::ddl::quote_ident(&e.key).is_ok(), "entity {}", e.key);
            for f in &e.fields {
                assert!(crate::ddl::quote_ident(&f.key).is_ok(), "field {}.{}", e.key, f.key);
            }
        }
    }

    #[test]
    fn round_trips_through_json_with_ts_field_names() {
        let m = crm();
        let json = serde_json::to_string(&m).unwrap();
        // the discriminator serializes as `type` (matching the TS shape), lowercased
        assert!(json.contains("\"type\":\"string\""));
        assert!(json.contains("\"type\":\"ref\""));
        let back: DataModel = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
