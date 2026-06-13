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

impl DataModel {
    /// Find an entity by key.
    pub fn entity(&self, key: &str) -> Option<&Entity> {
        self.entities.iter().find(|e| e.key == key)
    }

    /// Structural validation, independent of any data: unique entity/field keys,
    /// identity fields that actually exist, and `ref` fields that point at a real
    /// entity. Returns the list of problems (empty ⇒ valid) as a single error.
    pub fn check(&self) -> Result<()> {
        let mut problems = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for e in &self.entities {
            if !seen.insert(&e.key) {
                problems.push(format!("duplicate entity key `{}`", e.key));
            }
            let mut fseen = std::collections::HashSet::new();
            for f in &e.fields {
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
        if problems.is_empty() {
            Ok(())
        } else {
            Err(DataError::Schema(problems.join("; ")))
        }
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
