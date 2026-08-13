//! The DATA GRAPH — the GLOBAL store of our own data entities (the-data-graph-a-global-third-pillar).
//!
//! The third pillar beside `bsc ui` (components) and `bsc graph` (algorithms). Those two are global
//! stores of OUR library; the rest of this crate is the canonical Data Model scoped PER PROJECT (it
//! needs `--db`/`$BSC_DATA_DB` and describes the app being built). This is the same data concept at
//! the other scope — one concept, two scopes, exactly as a project's plan sits beside the global
//! skills library.
//!
//! It is deliberately NOT DuckDB. An entity here is a description — a name, its fields, the shape it
//! presents, how many live instances there may be — not a table of rows, so it rides the same
//! verbatim-JSON-per-id store the component and kit libraries use and reaches no database at all.
//! `connector` already set that precedent in this crate: a global store dispatched before `resolve_db`.
//!
//! WHY IT EXISTS RATHER THAN FOLDING INTO THE ALGORITHMS GRAPH. The app's own state schema
//! (`store/types/*.ts`) is TYPE-ONLY — erased at runtime — so as algorithm impls those modules would
//! be code records containing no code. And the thing that blocked the store migration entirely,
//! `store/index.ts`'s single `create()`, stops being an exception here: [`Entity::instances`] records
//! that there is exactly ONE of it. A singleton becomes a modelled property instead of a boundary.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// How many live instances of an entity may exist at once.
///
/// The reason the data graph can hold the app store at all. `store/index.ts` calls Zustand's
/// `create()` once, and everything importing `@/store` shares that instance because the bundler gives
/// them one module. A record that VENDORS its source would build a second one — its own state, its own
/// subscribers, its own `persist` writing the same key — so the fact "there is exactly one of these"
/// has to be part of the model rather than a rule someone remembers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Instances {
    /// Exactly one live instance, app-wide. Never vendor it — resolve to the running one.
    Single,
    /// Any number; each holder may have its own.
    #[default]
    Many,
}

/// One entity in the data graph.
///
/// Additive by design, like every other record in these stores: an absent optional field means "not
/// stated", never "empty", so a store written before a field existed keeps working.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The DataShape this entity presents (`list`, `table`, …) — the EXISTING components↔data edge.
    /// `bsc ui shapes` maps a shape to the components ideal for it, so setting this is what connects
    /// an entity to the UI that can render it, with no new mechanism.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    /// Field names, in declaration order. A description of the schema, not its storage.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
    /// How many may be live at once — see [`Instances`].
    #[serde(default, skip_serializing_if = "is_many")]
    pub instances: Instances,
    /// PROVENANCE — the repo-relative file this was lifted from, matching `src` on the other two
    /// stores so a record can be traced back and re-derived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    /// The `@/…` specifier this entity's module satisfies, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provides: Option<String>,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde's skip_serializing_if hands us a reference
fn is_many(i: &Instances) -> bool {
    matches!(i, Instances::Many)
}

impl Entity {
    /// Reject what a store must never hold. Kept tiny on purpose — the point is that an entity with no
    /// id cannot be addressed and an entity with no name cannot be shown, not to police the schema.
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("an entity needs a non-empty id".into());
        }
        if self.name.trim().is_empty() {
            return Err(format!("entity '{}' needs a non-empty name", self.id));
        }
        Ok(())
    }
}

/// The global store directory — `$BSC_ENTITY_DIR`, else `~/.base-studio-code/entities/`. Mirrors how
/// the component and kit stores resolve, so one convention covers all three pillars.
pub fn store_dir(flag: Option<&str>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(&flag.map(str::to_string), "BSC_ENTITY_DIR", || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join("entities"))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })
}

/// Open the entity store.
pub fn open(flag: Option<&str>) -> Result<bsc_json_store::Store, String> {
    Ok(bsc_json_store::Store::new(store_dir(flag)?, "entity"))
}

/// Every entity, id-sorted so output is stable.
pub fn list(store: &bsc_json_store::Store) -> Vec<Entity> {
    let mut out: Vec<Entity> = store
        .list()
        .iter()
        .filter_map(|raw| serde_json::from_str::<Entity>(raw).ok())
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(id: &str) -> Entity {
        Entity {
            id: id.into(),
            name: "Thing".into(),
            summary: None,
            shape: None,
            fields: vec![],
            instances: Instances::Many,
            src: None,
            provides: None,
        }
    }

    #[test]
    fn an_entity_needs_an_id_and_a_name() {
        assert!(entity("a").validate().is_ok());
        let mut e = entity("");
        assert!(e.validate().is_err(), "no id — nothing can address it");
        e = entity("a");
        e.name = "  ".into();
        assert!(e.validate().is_err(), "no name — nothing can show it");
    }

    /// `many` is the default and is OMITTED, so a store written before `instances` existed reads back
    /// identically — the additive contract every one of these stores keeps.
    #[test]
    fn the_default_cardinality_is_omitted_and_single_is_not() {
        let many = serde_json::to_string(&entity("a")).unwrap();
        assert!(!many.contains("instances"), "the default is not written: {many}");

        let mut one = entity("b");
        one.instances = Instances::Single;
        let s = serde_json::to_string(&one).unwrap();
        assert!(s.contains("\"instances\":\"single\""), "single IS written: {s}");
        assert_eq!(serde_json::from_str::<Entity>(&s).unwrap().instances, Instances::Single);

        // …and a record that predates the field still parses, defaulting to `many`.
        let old: Entity = serde_json::from_str(r#"{"id":"c","name":"C"}"#).unwrap();
        assert_eq!(old.instances, Instances::Many);
    }

    #[test]
    fn absent_optionals_stay_absent_rather_than_null() {
        let s = serde_json::to_string(&entity("a")).unwrap();
        for k in ["summary", "shape", "fields", "src", "provides"] {
            assert!(!s.contains(k), "{k} must be omitted, not null: {s}");
        }
    }
}
