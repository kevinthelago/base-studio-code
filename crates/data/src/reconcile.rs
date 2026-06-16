//! Multi-source reconciliation (#785) — the director's merge.
//!
//! When several sources load the same entity, records describing the same real-world
//! thing (same `Entity::identity`) are merged into ONE canonical record: each field takes
//! the value from the highest-**precedence** source that has a non-empty value, and
//! per-field lineage records which source won. A field where two sources disagree (two
//! different non-empty values) is counted as a conflict.
//!
//! Pure (no DuckDB) so the merge logic is fully unit-testable; the store persists the
//! result via `DataStore::load_reconciled`.

use std::collections::{BTreeMap, BTreeSet};

use crate::connector::RowSet;
use crate::schema::Entity;

/// One source's contribution to an entity — its lineage id + the rows it read.
pub struct SourceLoad {
    pub source: String,
    pub rows: RowSet,
}

/// Source precedence: sources earlier in the list win conflicts. A source not listed
/// ranks last; ties break by the order rows were encountered.
pub struct Precedence(pub Vec<String>);

impl Precedence {
    fn rank(&self, source: &str) -> usize {
        self.0.iter().position(|s| s == source).unwrap_or(self.0.len())
    }
}

/// One reconciled (canonical) record.
#[derive(Debug, Clone, PartialEq)]
pub struct MergedRecord {
    /// The identity key value (identity fields joined by `|`), or a unique synthetic key
    /// when the entity has no identity (then nothing merges).
    pub identity: String,
    /// field → the winning, non-empty value.
    pub values: BTreeMap<String, String>,
    /// field → the source that supplied the winning value.
    pub lineage: BTreeMap<String, String>,
}

/// The result of reconciling several sources for one entity.
#[derive(Debug, Clone, PartialEq)]
pub struct Reconciled {
    pub entity: String,
    /// One record per distinct identity, in first-seen order.
    pub records: Vec<MergedRecord>,
    /// Count of (record, field) pairs where ≥2 sources supplied DIFFERENT non-empty values.
    pub conflicts: usize,
}

struct Candidate {
    rank: usize,
    seq: usize,
    source: String,
    value: String,
}

/// Merge `loads` for `entity` under `prec`.
pub fn reconcile(entity: &Entity, loads: &[SourceLoad], prec: &Precedence) -> Reconciled {
    // identity (first-seen order) → field → candidates
    let mut order: Vec<String> = Vec::new();
    let mut groups: BTreeMap<String, BTreeMap<String, Vec<Candidate>>> = BTreeMap::new();

    let mut seq = 0usize;
    for load in loads {
        let col_for: Vec<Option<usize>> = entity
            .fields
            .iter()
            .map(|f| load.rows.columns.iter().position(|c| c.eq_ignore_ascii_case(&f.key)))
            .collect();
        let id_for: Vec<Option<usize>> = entity
            .identity
            .iter()
            .map(|id| load.rows.columns.iter().position(|c| c.eq_ignore_ascii_case(id)))
            .collect();
        let rank = prec.rank(&load.source);

        for row in &load.rows.rows {
            let identity = if entity.identity.is_empty() {
                // no merge key — every row is its own record
                format!("_row#{seq}")
            } else {
                id_for
                    .iter()
                    .map(|ci| ci.and_then(|i| row.get(i)).cloned().unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("|")
            };
            if !groups.contains_key(&identity) {
                order.push(identity.clone());
            }
            let g = groups.entry(identity).or_default();
            for (fi, f) in entity.fields.iter().enumerate() {
                let val = col_for[fi].and_then(|ci| row.get(ci)).map(|s| s.trim()).unwrap_or("");
                if val.is_empty() {
                    continue;
                }
                g.entry(f.key.clone()).or_default().push(Candidate {
                    rank,
                    seq,
                    source: load.source.clone(),
                    value: val.to_string(),
                });
            }
            seq += 1;
        }
    }

    let mut conflicts = 0;
    let mut records = Vec::with_capacity(order.len());
    for id in &order {
        let g = &groups[id];
        let mut values = BTreeMap::new();
        let mut lineage = BTreeMap::new();
        for (field, cands) in g {
            // winner = best precedence, then earliest seen
            let winner = cands.iter().min_by_key(|c| (c.rank, c.seq)).unwrap();
            let distinct: BTreeSet<&str> = cands.iter().map(|c| c.value.as_str()).collect();
            if distinct.len() > 1 {
                conflicts += 1;
            }
            values.insert(field.clone(), winner.value.clone());
            lineage.insert(field.clone(), winner.source.clone());
        }
        records.push(MergedRecord { identity: id.clone(), values, lineage });
    }

    Reconciled { entity: entity.key.clone(), records, conflicts }
}

impl Reconciled {
    /// The canonical records as a [`RowSet`] aligned to the entity's fields (missing values
    /// blank) — ready to load into the store.
    pub fn to_rowset(&self, entity: &Entity) -> RowSet {
        let columns: Vec<String> = entity.fields.iter().map(|f| f.key.clone()).collect();
        let rows = self
            .records
            .iter()
            .map(|r| entity.fields.iter().map(|f| r.values.get(&f.key).cloned().unwrap_or_default()).collect())
            .collect();
        RowSet { columns, rows }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Field, FieldType};

    fn f(key: &str) -> Field {
        Field { key: key.into(), label: String::new(), ty: FieldType::String, required: false, reference: None, enum_values: vec![], validate: None }
    }

    fn account() -> Entity {
        Entity { key: "account".into(), label: String::new(), fields: vec![f("id"), f("name"), f("phone")], identity: vec!["id".into()] }
    }

    fn rs(cols: &[&str], rows: &[&[&str]]) -> RowSet {
        RowSet {
            columns: cols.iter().map(|s| s.to_string()).collect(),
            rows: rows.iter().map(|r| r.iter().map(|s| s.to_string()).collect()).collect(),
        }
    }

    #[test]
    fn merges_same_identity_across_sources_filling_complementary_fields() {
        let crm = SourceLoad { source: "crm".into(), rows: rs(&["id", "name"], &[&["1", "Acme"]]) };
        let dir = SourceLoad { source: "directory".into(), rows: rs(&["id", "phone"], &[&["1", "555-0100"]]) };
        let out = reconcile(&account(), &[crm, dir], &Precedence(vec!["crm".into(), "directory".into()]));

        assert_eq!(out.records.len(), 1);
        let r = &out.records[0];
        assert_eq!(r.values.get("name").map(String::as_str), Some("Acme"));
        assert_eq!(r.values.get("phone").map(String::as_str), Some("555-0100"));
        // lineage attributes each field to the source that supplied it
        assert_eq!(r.lineage.get("name").map(String::as_str), Some("crm"));
        assert_eq!(r.lineage.get("phone").map(String::as_str), Some("directory"));
        assert_eq!(out.conflicts, 0);
    }

    #[test]
    fn precedence_wins_conflicts_and_counts_them() {
        let crm = SourceLoad { source: "crm".into(), rows: rs(&["id", "name"], &[&["1", "Acme Inc"]]) };
        let scrape = SourceLoad { source: "scrape".into(), rows: rs(&["id", "name"], &[&["1", "ACME"]]) };
        // scrape listed first → higher precedence
        let out = reconcile(&account(), &[crm, scrape], &Precedence(vec!["scrape".into(), "crm".into()]));
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.records[0].values.get("name").map(String::as_str), Some("ACME"));
        assert_eq!(out.records[0].lineage.get("name").map(String::as_str), Some("scrape"));
        assert_eq!(out.conflicts, 1);
    }

    #[test]
    fn a_non_empty_value_is_not_overridden_by_an_empty_one() {
        let a = SourceLoad { source: "a".into(), rows: rs(&["id", "name"], &[&["1", "Acme"]]) };
        let b = SourceLoad { source: "b".into(), rows: rs(&["id", "name"], &[&["1", ""]]) };
        // b is higher precedence but has an empty name → a's value stands, no conflict
        let out = reconcile(&account(), &[a, b], &Precedence(vec!["b".into(), "a".into()]));
        assert_eq!(out.records[0].values.get("name").map(String::as_str), Some("Acme"));
        assert_eq!(out.conflicts, 0);
    }

    #[test]
    fn distinct_identities_stay_separate_and_to_rowset_aligns_fields() {
        let s = SourceLoad { source: "s".into(), rows: rs(&["id", "name"], &[&["1", "Acme"], &["2", "Globex"]]) };
        let out = reconcile(&account(), &[s], &Precedence(vec![]));
        assert_eq!(out.records.len(), 2);
        let rsout = out.to_rowset(&account());
        assert_eq!(rsout.columns, vec!["id", "name", "phone"]);
        assert_eq!(rsout.rows.len(), 2);
        // phone column present but blank
        assert_eq!(rsout.rows[0], vec!["1", "Acme", ""]);
    }

    #[test]
    fn an_entity_with_no_identity_does_not_merge_rows() {
        let e = Entity { key: "e".into(), label: String::new(), fields: vec![f("name")], identity: vec![] };
        let a = SourceLoad { source: "a".into(), rows: rs(&["name"], &[&["x"]]) };
        let b = SourceLoad { source: "b".into(), rows: rs(&["name"], &[&["y"]]) };
        let out = reconcile(&e, &[a, b], &Precedence(vec![]));
        assert_eq!(out.records.len(), 2); // not merged
    }
}
