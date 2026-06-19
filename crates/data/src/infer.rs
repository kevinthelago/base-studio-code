//! Derive a canonical [`DataModel`] from sampled [`SourceObject`] metadata and [`RowSet`] data.
//!
//! Pure functions — no I/O.

use std::collections::{HashMap, HashSet};

use crate::connector::{RowSet, SourceObject};
use crate::schema::{DataModel, Entity, Field, FieldType};

// ── Named thresholds ──────────────────────────────────────────────────────────

/// Maximum distinct values for a column to be treated as a picklist (Enum).
/// Salesforce picklists rarely exceed 50 active values; 20 is a safe ceiling
/// for auto-detection while avoiding false-positives on low-cardinality free text.
const PICKLIST_CARDINALITY_MAX: usize = 20;

/// Minimum fraction of rows that must be non-empty for a field to be marked
/// `required`. 0.98 tolerates up to 2 % null/blank in otherwise-mandatory fields
/// (import gaps, legacy records) without false negatives.
const REQUIRED_POPULATION_MIN: f64 = 0.98;

/// Minimum population ratio (non-empty / total rows) for a field to be an identity
/// candidate. A field blank in more than 10 % of records is too unreliable as a merge key.
const IDENTITY_POPULATION_MIN: f64 = 0.90;

/// Minimum uniqueness ratio (distinct / populated) for an identity candidate.
/// Allows up to 5 % duplicate values; filters out low-cardinality fields that
/// happen to have an id-like name ("status_id", "type_id", …).
const IDENTITY_UNIQUENESS_MIN: f64 = 0.95;

/// Minimum rows in the sample before cardinality statistics are trusted.
/// Below this threshold only name-based heuristics apply.
const MIN_SAMPLE_ROWS: usize = 3;

// ── Public output types ───────────────────────────────────────────────────────

/// Why a field's type and `required` flag were chosen.
///
/// Carried alongside [`DataModel`] so callers can surface decisions to users
/// without adding provenance metadata to the [`Field`] struct itself.
#[derive(Debug, Clone)]
pub struct FieldProvenance {
    /// Matches [`Field::key`] on the parent entity.
    pub field_key: String,
    /// Fraction of sampled rows with a non-empty value (0.0–1.0).
    pub population_ratio: f64,
    /// Fraction of populated values that are distinct (1.0 = perfectly unique).
    pub uniqueness_ratio: f64,
    /// Human-readable explanation of the type assignment.
    pub type_reason: String,
    /// Human-readable explanation of the `required` assignment.
    pub required_reason: String,
}

/// Inferred entity together with per-field provenance.
#[derive(Debug, Clone)]
pub struct EntityInference {
    pub entity: Entity,
    pub provenances: Vec<FieldProvenance>,
}

/// Full inference result: a ready-to-validate [`DataModel`] plus provenance for
/// every field in every entity.
#[derive(Debug, Clone)]
pub struct InferResult {
    pub model: DataModel,
    pub entities: Vec<EntityInference>,
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Derive a [`DataModel`] from a set of (object, sample) pairs.
///
/// `model_name` is the human name for the resulting [`DataModel`].
/// `objects` contains one entry per source object: its column metadata and a
/// sampled [`RowSet`]. Larger samples improve population / uniqueness statistics;
/// inference is still correct (if conservative) on samples as small as one row.
///
/// Ref fields whose target entity is not in `objects` are still recorded with
/// their best-guess target key; [`DataModel::check`] will flag them as dangling
/// only if the caller does not supply those entities separately.
pub fn infer(objects: &[(SourceObject, RowSet)], model_name: &str) -> InferResult {
    let known: HashSet<String> = objects
        .iter()
        .map(|(obj, _)| object_to_entity_key(&obj.name))
        .collect();

    let mut entity_inferences: Vec<EntityInference> = objects
        .iter()
        .map(|(obj, rows)| infer_entity(obj, rows, &known))
        .collect();

    entity_inferences.sort_by(|a, b| a.entity.key.cmp(&b.entity.key));

    let model = DataModel {
        name: model_name.to_string(),
        version: 1,
        entities: entity_inferences.iter().map(|ei| ei.entity.clone()).collect(),
    };

    InferResult { model, entities: entity_inferences }
}

// ── Entity inference ──────────────────────────────────────────────────────────

fn infer_entity(obj: &SourceObject, rows: &RowSet, known_entities: &HashSet<String>) -> EntityInference {
    let entity_key = object_to_entity_key(&obj.name);
    let total_rows = rows.rows.len();

    let col_index: HashMap<&str, usize> = rows
        .columns
        .iter()
        .enumerate()
        .map(|(i, c)| (c.as_str(), i))
        .collect();

    let mut fields = Vec::new();
    let mut provenances = Vec::new();

    for col_name in &obj.columns {
        let values: Vec<&str> = col_index
            .get(col_name.as_str())
            .map(|&idx| {
                rows.rows
                    .iter()
                    .map(|row| row.get(idx).map(String::as_str).unwrap_or(""))
                    .collect()
            })
            .unwrap_or_default();

        let (field, prov) = infer_field(col_name, &values, total_rows, known_entities);
        fields.push(field);
        provenances.push(prov);
    }

    let identity = propose_identity(&fields, &provenances);

    // Identity fields are merge keys and must round-trip as text — force String
    // regardless of what the value-type detector chose (e.g. "1"/"2" → Number).
    let identity_set: std::collections::HashSet<&str> =
        identity.iter().map(String::as_str).collect();
    for f in &mut fields {
        if identity_set.contains(f.key.as_str()) && !matches!(f.ty, FieldType::Ref) {
            f.ty = FieldType::String;
        }
    }

    EntityInference {
        entity: Entity {
            key: entity_key,
            label: label_from_name(&obj.name),
            fields,
            identity,
        },
        provenances,
    }
}

// ── Field inference ───────────────────────────────────────────────────────────

fn infer_field(
    col_name: &str,
    values: &[&str],
    total_rows: usize,
    known_entities: &HashSet<String>,
) -> (Field, FieldProvenance) {
    let key = column_to_field_key(col_name);
    let label = label_from_name(col_name);

    let populated: Vec<&str> = values.iter().copied().filter(|v| !v.is_empty()).collect();
    let pop_count = populated.len();
    let population_ratio = if total_rows > 0 { pop_count as f64 / total_rows as f64 } else { 0.0 };

    let distinct_count = populated.iter().copied().collect::<HashSet<_>>().len();
    let uniqueness_ratio = if pop_count > 0 { distinct_count as f64 / pop_count as f64 } else { 0.0 };

    let (required, required_reason) = compute_required(population_ratio, total_rows);

    // Priority order: Ref → Bool → Date → Money → Number → Enum → String.
    // Scalars are checked before Enum so that numeric/date/bool columns with low
    // cardinality are not misclassified as picklists.

    if let Some((target, type_reason)) = detect_ref(col_name, known_entities) {
        return make_result(key, label, FieldType::Ref, required, Some(target), vec![],
            type_reason, required_reason, population_ratio, uniqueness_ratio);
    }

    if !populated.is_empty() && populated.iter().all(|v| is_bool(v)) {
        return make_result(key, label, FieldType::Bool, required, None, vec![],
            "all sampled values are boolean (true/false/yes/no/1/0)".into(),
            required_reason, population_ratio, uniqueness_ratio);
    }

    if !populated.is_empty() && populated.iter().all(|v| is_date(v)) {
        return make_result(key, label, FieldType::Date, required, None, vec![],
            "all sampled values match ISO-8601 date pattern (YYYY-MM-DD)".into(),
            required_reason, population_ratio, uniqueness_ratio);
    }

    if !populated.is_empty() && populated.iter().all(|v| is_numeric(v)) {
        let (ty, type_reason) = if is_money_column(col_name) {
            (FieldType::Money, format!("all values numeric; column name '{col_name}' signals currency/amount"))
        } else {
            (FieldType::Number, "all sampled values parse as numeric".into())
        };
        return make_result(key, label, ty, required, None, vec![],
            type_reason, required_reason, population_ratio, uniqueness_ratio);
    }

    if let Some((enum_values, type_reason)) = detect_enum(col_name, &populated, total_rows) {
        return make_result(key, label, FieldType::Enum, required, None, enum_values,
            type_reason, required_reason, population_ratio, uniqueness_ratio);
    }

    make_result(key, label, FieldType::String, required, None, vec![],
        "no stronger type signal found — defaulting to string".into(),
        required_reason, population_ratio, uniqueness_ratio)
}

#[allow(clippy::too_many_arguments)]
fn make_result(
    key: String, label: String, ty: FieldType, required: bool,
    reference: Option<String>, enum_values: Vec<String>,
    type_reason: String, required_reason: String,
    population_ratio: f64, uniqueness_ratio: f64,
) -> (Field, FieldProvenance) {
    (
        Field { key: key.clone(), label, ty, required, reference, enum_values, validate: None },
        FieldProvenance { field_key: key, population_ratio, uniqueness_ratio, type_reason, required_reason },
    )
}

fn compute_required(population_ratio: f64, total_rows: usize) -> (bool, String) {
    if total_rows < MIN_SAMPLE_ROWS {
        return (false, format!("sample too small ({total_rows} rows < {MIN_SAMPLE_ROWS}) — required left false"));
    }
    if population_ratio >= REQUIRED_POPULATION_MIN {
        (true, format!("population {:.0}% ≥ {:.0}% threshold → required",
            population_ratio * 100.0, REQUIRED_POPULATION_MIN * 100.0))
    } else {
        (false, format!("population {:.0}% < {:.0}% threshold → optional",
            population_ratio * 100.0, REQUIRED_POPULATION_MIN * 100.0))
    }
}

// ── Type detectors ────────────────────────────────────────────────────────────

/// Returns `Some((target_entity_key, reason))` for standard Salesforce lookup / master-detail
/// fields: columns that end with `Id` but are not the bare `Id` primary-key column.
/// Custom fields (`__c` suffix) are excluded — they require Salesforce metadata to resolve.
fn detect_ref(col_name: &str, known_entities: &HashSet<String>) -> Option<(String, String)> {
    if col_name.ends_with("__c") || col_name == "Id" || !col_name.ends_with("Id") {
        return None;
    }
    let entity_part = &col_name[..col_name.len() - 2];
    let target = object_to_entity_key(entity_part);
    let reason = if known_entities.contains(&target) {
        format!("'{col_name}' ends with 'Id' → lookup ref to known entity '{target}'")
    } else {
        format!("'{col_name}' ends with 'Id' → ref to '{target}' (not in supplied objects; may be cross-system)")
    };
    Some((target, reason))
}

/// Returns `Some((sorted_values, reason))` when the column should be typed as Enum.
///
/// Fires when the column name contains a known picklist token (e.g. "type", "status",
/// "stage") or when the column is a Salesforce custom field (`__c`) whose name does
/// not look like an identifier and whose cardinality stays within the cap over a
/// trustworthy sample.
fn detect_enum(col_name: &str, populated: &[&str], total_rows: usize) -> Option<(Vec<String>, String)> {
    if populated.is_empty() {
        return None;
    }
    let name_lower = col_name.to_ascii_lowercase();
    let name_signal = PICKLIST_NAME_TOKENS.iter().any(|t| name_lower.contains(t));

    let distinct: HashSet<&str> = populated.iter().copied().collect();
    let cardinality = distinct.len();

    // Custom fields with id/key-like names are identifiers, not picklists.
    let is_id_like = name_lower.contains("id") || name_lower.contains("key");
    let custom_low_cardinality = col_name.ends_with("__c")
        && !is_id_like
        && total_rows >= MIN_SAMPLE_ROWS
        && cardinality <= PICKLIST_CARDINALITY_MAX;

    if !name_signal && !custom_low_cardinality {
        return None;
    }

    let mut values: Vec<String> = distinct.into_iter().map(|s| s.to_string()).collect();
    values.sort();
    let reason = if name_signal {
        format!("column name '{col_name}' contains picklist token; {cardinality} distinct value(s) observed")
    } else {
        format!("custom field '{col_name}' with {cardinality} distinct value(s) ≤ {PICKLIST_CARDINALITY_MAX} → inferred as enum")
    };
    Some((values, reason))
}

const PICKLIST_NAME_TOKENS: &[&str] = &[
    "type", "status", "stage", "phase", "category", "priority",
    "reason", "rating", "industry", "source", "salutation",
];

fn is_bool(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "true" | "false" | "yes" | "no" | "1" | "0")
}

fn is_date(v: &str) -> bool {
    // Matches YYYY-MM-DD (accepts trailing time component).
    let b = v.as_bytes();
    b.len() >= 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..10].iter().all(|c| c.is_ascii_digit())
}

fn is_numeric(v: &str) -> bool {
    // Strip an optional leading currency symbol, then remove thousands-separator commas
    // before parsing. Only letters in the value (e.g. "C1", "ACC001") must disqualify it.
    let stripped = v.trim_start_matches(|c: char| matches!(c, '$' | '€' | '£' | '¥' | ' '));
    let no_commas = stripped.replace(',', "");
    no_commas.parse::<f64>().is_ok()
}

fn is_money_column(col_name: &str) -> bool {
    let lower = col_name.to_ascii_lowercase();
    MONEY_NAME_TOKENS.iter().any(|t| lower.contains(t))
}

const MONEY_NAME_TOKENS: &[&str] = &[
    "amount", "price", "cost", "revenue", "salary", "total",
    "value", "fee", "rate", "budget", "balance",
];

// ── Identity proposal ─────────────────────────────────────────────────────────

/// Propose identity fields for an entity.
///
/// A candidate must clear both the population and uniqueness thresholds and have a
/// name that looks like a natural key. Among passing candidates the highest-priority
/// name wins: bare `id` (0) → external-id patterns (1) → other `*id` patterns (2)
/// → email (3) → name (4). The caller can extend to a composite key after reviewing
/// provenance if a single field is insufficient.
fn propose_identity(fields: &[Field], provenances: &[FieldProvenance]) -> Vec<String> {
    let prov_map: HashMap<&str, &FieldProvenance> = provenances
        .iter()
        .map(|p| (p.field_key.as_str(), p))
        .collect();

    let mut candidates: Vec<(&Field, &FieldProvenance)> = fields
        .iter()
        .filter_map(|f| {
            let p = prov_map.get(f.key.as_str())?;
            if p.population_ratio < IDENTITY_POPULATION_MIN { return None; }
            if p.uniqueness_ratio < IDENTITY_UNIQUENESS_MIN { return None; }
            if !is_identity_name(&f.key) { return None; }
            Some((f, *p))
        })
        .collect();

    candidates.sort_by(|(fa, pa), (fb, pb)| {
        identity_name_priority(&fa.key)
            .cmp(&identity_name_priority(&fb.key))
            .then_with(|| pb.population_ratio.partial_cmp(&pa.population_ratio)
                .unwrap_or(std::cmp::Ordering::Equal))
    });

    candidates.into_iter().take(1).map(|(f, _)| f.key.clone()).collect()
}

fn is_identity_name(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower == "id"
        || lower == "email"
        || lower == "name"
        || lower.ends_with("_id")
        || lower.ends_with("id")
        || lower.contains("externalid")
        || lower.contains("external_id")
        || lower.ends_with("_email")
        || lower.ends_with("_name")
}

fn identity_name_priority(key: &str) -> u8 {
    let lower = key.to_ascii_lowercase();
    if lower == "id" { 0 }
    else if lower.contains("externalid") || lower.contains("external_id") { 1 }
    else if lower.ends_with("_id") || lower.ends_with("id") { 2 }
    else if lower == "email" || lower.ends_with("_email") { 3 }
    else { 4 }
}

// ── Key / label helpers ───────────────────────────────────────────────────────

fn object_to_entity_key(name: &str) -> String {
    name.strip_suffix("__c")
        .unwrap_or(name)
        .to_ascii_lowercase()
        .replace(' ', "_")
}

fn column_to_field_key(name: &str) -> String {
    name.strip_suffix("__c")
        .unwrap_or(name)
        .to_ascii_lowercase()
        .replace(' ', "_")
        .replace("__", "_")
}

fn label_from_name(name: &str) -> String {
    let base = name.strip_suffix("__c").unwrap_or(name);
    base.replace('_', " ")
        .split_whitespace()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(name: &str, columns: &[&str]) -> SourceObject {
        SourceObject { name: name.into(), columns: columns.iter().map(|s| s.to_string()).collect() }
    }

    fn rowset(columns: &[&str], rows: &[&[&str]]) -> RowSet {
        RowSet {
            columns: columns.iter().map(|s| s.to_string()).collect(),
            rows: rows.iter().map(|r| r.iter().map(|s| s.to_string()).collect()).collect(),
        }
    }

    fn field_ty<'a>(fields: &'a [Field], key: &str) -> Option<FieldType> {
        fields.iter().find(|f| f.key == key).map(|f| f.ty)
    }

    // ── Ref detection ─────────────────────────────────────────────────────────

    #[test]
    fn ref_detected_for_id_suffix_not_bare_id() {
        let objects = [
            (obj("Account", &["Id"]), rowset(&["Id"], &[&["A1"], &["A2"], &["A3"]])),
            (obj("Contact", &["Id", "AccountId", "OwnerId"]), rowset(
                &["Id", "AccountId", "OwnerId"],
                &[&["C1", "A1", "U1"], &["C2", "A2", "U1"], &["C3", "A1", "U2"]],
            )),
        ];
        let result = infer(&objects, "CRM");
        let contact = result.model.entity("contact").unwrap();

        assert_eq!(field_ty(&contact.fields, "id"), Some(FieldType::String), "bare Id → String not Ref");

        let acct_id = contact.fields.iter().find(|f| f.key == "accountid").unwrap();
        assert_eq!(acct_id.ty, FieldType::Ref);
        assert_eq!(acct_id.reference.as_deref(), Some("account"));

        let owner_id = contact.fields.iter().find(|f| f.key == "ownerid").unwrap();
        assert_eq!(owner_id.ty, FieldType::Ref);
        assert_eq!(owner_id.reference.as_deref(), Some("owner"));
    }

    #[test]
    fn custom_field_with_id_in_name_is_not_a_ref() {
        // ExternalId__c should not become Ref("external") — it's an identifier column.
        let objects = [(
            obj("Account", &["ExternalId__c"]),
            rowset(&["ExternalId__c"], &[&["EXT-001"], &["EXT-002"], &["EXT-003"]]),
        )];
        let result = infer(&objects, "CRM");
        let acc = result.model.entity("account").unwrap();
        assert_ne!(field_ty(&acc.fields, "externalid"), Some(FieldType::Ref));
    }

    // ── Scalar types ──────────────────────────────────────────────────────────

    #[test]
    fn scalar_types_inferred_from_values() {
        let objects = [(
            obj("Event", &["IsActive", "StartDate", "Budget__c", "Attendees", "Notes"]),
            rowset(
                &["IsActive", "StartDate", "Budget__c", "Attendees", "Notes"],
                &[
                    &["true",  "2024-01-15", "5000.00", "42", "First event"],
                    &["false", "2024-03-20", "8500.00", "18", ""],
                    &["true",  "2024-06-01", "1200.50", "75", "Outdoor"],
                ],
            ),
        )];
        let result = infer(&objects, "Events");
        let ev = result.model.entity("event").unwrap();

        assert_eq!(field_ty(&ev.fields, "isactive"),  Some(FieldType::Bool));
        assert_eq!(field_ty(&ev.fields, "startdate"), Some(FieldType::Date));
        assert_eq!(field_ty(&ev.fields, "budget"),    Some(FieldType::Money));
        assert_eq!(field_ty(&ev.fields, "attendees"), Some(FieldType::Number));
        assert_eq!(field_ty(&ev.fields, "notes"),     Some(FieldType::String));
    }

    // ── Picklist / enum ───────────────────────────────────────────────────────

    #[test]
    fn picklist_detected_by_name_token() {
        let objects = [(
            obj("Lead", &["LeadSource__c", "Status__c"]),
            rowset(
                &["LeadSource__c", "Status__c"],
                &[
                    &["Web",     "Open"],
                    &["Phone",   "Contacted"],
                    &["Web",     "Converted"],
                    &["Partner", "Open"],
                ],
            ),
        )];
        let result = infer(&objects, "CRM");
        let lead = result.model.entity("lead").unwrap();
        assert_eq!(field_ty(&lead.fields, "leadsource"), Some(FieldType::Enum));
        assert_eq!(field_ty(&lead.fields, "status"),     Some(FieldType::Enum));

        let src = lead.fields.iter().find(|f| f.key == "leadsource").unwrap();
        assert!(src.enum_values.contains(&"Web".to_string()));
        assert!(src.enum_values.contains(&"Partner".to_string()));
    }

    #[test]
    fn numeric_column_not_misclassified_as_enum() {
        // AnnualRevenue has 4 distinct values — cardinality ≤ 20 — but it is numeric,
        // so scalars take priority and it becomes Money.
        let objects = [(
            obj("Account", &["AnnualRevenue"]),
            rowset(
                &["AnnualRevenue"],
                &[&["1200000.00"], &["450000.00"], &["890000.00"], &["3100000.00"]],
            ),
        )];
        let result = infer(&objects, "CRM");
        let acc = result.model.entity("account").unwrap();
        assert_eq!(field_ty(&acc.fields, "annualrevenue"), Some(FieldType::Money));
    }

    // ── Population / required ─────────────────────────────────────────────────

    #[test]
    fn required_marked_above_threshold_sparse_left_optional() {
        let objects = [(
            obj("Account", &["Id", "Name", "Description"]),
            rowset(
                &["Id", "Name", "Description"],
                &[
                    &["A1", "Acme",     "Big corp"],
                    &["A2", "Globex",   ""],
                    &["A3", "Initech",  ""],
                    &["A4", "Umbrella", ""],
                    &["A5", "Vandelay", ""],
                ],
            ),
        )];
        let result = infer(&objects, "CRM");
        let acc = result.model.entity("account").unwrap();

        let id_f   = acc.fields.iter().find(|f| f.key == "id").unwrap();
        let name_f = acc.fields.iter().find(|f| f.key == "name").unwrap();
        let desc_f = acc.fields.iter().find(|f| f.key == "description").unwrap();

        assert!(id_f.required,    "Id 100% populated → required");
        assert!(name_f.required,  "Name 100% populated → required");
        assert!(!desc_f.required, "Description 20% populated → not required");
    }

    // ── Identity proposal ─────────────────────────────────────────────────────

    #[test]
    fn identity_chosen_from_fully_populated_unique_id() {
        let objects = [(
            obj("Account", &["Id", "Name", "Type__c"]),
            rowset(
                &["Id", "Name", "Type__c"],
                &[
                    &["A001", "Acme",     "Customer"],
                    &["A002", "Globex",   "Partner"],
                    &["A003", "Initech",  "Customer"],
                    &["A004", "Umbrella", "Partner"],
                ],
            ),
        )];
        let result = infer(&objects, "CRM");
        let acc = result.model.entity("account").unwrap();
        assert_eq!(acc.identity, vec!["id"]);
    }

    #[test]
    fn identity_skips_low_uniqueness_field() {
        // Status__c repeats values → uniqueness < threshold; Id is unique.
        let objects = [(
            obj("Lead", &["Id", "Email", "Status__c"]),
            rowset(
                &["Id", "Email", "Status__c"],
                &[
                    &["L1", "a@ex.com", "Open"],
                    &["L2", "",          "Contacted"],
                    &["L3", "",          "Open"],
                    &["L4", "b@ex.com",  "Converted"],
                ],
            ),
        )];
        let result = infer(&objects, "CRM");
        let lead = result.model.entity("lead").unwrap();
        // Email is only 50 % populated (< IDENTITY_POPULATION_MIN); Id wins.
        assert_eq!(lead.identity, vec!["id"]);
    }

    // ── Custom-field suffix stripping ─────────────────────────────────────────

    #[test]
    fn custom_field_suffix_stripped_from_key_and_label() {
        let objects = [(
            obj("Account__c", &["ExternalId__c", "Region__c"]),
            rowset(
                &["ExternalId__c", "Region__c"],
                &[
                    &["EXT-001", "EMEA"],
                    &["EXT-002", "AMER"],
                    &["EXT-003", "APAC"],
                ],
            ),
        )];
        let result = infer(&objects, "CRM");
        // Object "Account__c" → entity key "account", label "Account".
        let acc = result.model.entity("account").unwrap();
        assert_eq!(acc.label, "Account");
        // "ExternalId__c" → key "externalid", label "ExternalId".
        let ext = acc.fields.iter().find(|f| f.key == "externalid").unwrap();
        assert_eq!(ext.label, "ExternalId");
        // "Region__c" with 3 distinct string values → Enum (custom __c + low cardinality).
        assert_eq!(field_ty(&acc.fields, "region"), Some(FieldType::Enum));
    }

    // ── Full Salesforce fixture ───────────────────────────────────────────────

    #[test]
    fn salesforce_contact_fixture_produces_valid_model() {
        let account_obj = obj("Account", &["Id", "Name", "Type", "AnnualRevenue"]);
        let account_rows = rowset(
            &["Id", "Name", "Type", "AnnualRevenue"],
            &[
                &["ACC001", "Acme Corp",     "Customer", "1200000.00"],
                &["ACC002", "Globex",        "Partner",  "450000.00"],
                &["ACC003", "Initech",       "Customer", "890000.00"],
                &["ACC004", "Umbrella Corp", "Customer", "3100000.00"],
            ],
        );

        let contact_obj = obj("Contact", &[
            "Id", "LastName", "Email", "AccountId",
            "LeadSource__c", "AnnualSalary__c", "IsEmailOptOut", "Birthdate", "Description",
        ]);
        let contact_rows = rowset(
            &["Id", "LastName", "Email", "AccountId",
              "LeadSource__c", "AnnualSalary__c", "IsEmailOptOut", "Birthdate", "Description"],
            &[
                &["CON001", "Smith",  "smith@ex.com",  "ACC001", "Web",     "75000.00", "false", "1985-06-15", "VIP"],
                &["CON002", "Jones",  "jones@ex.com",  "ACC002", "Phone",   "82000.00", "true",  "1990-03-22", ""],
                &["CON003", "Lee",    "lee@ex.com",    "ACC001", "Web",     "91000.00", "false", "1978-11-08", ""],
                &["CON004", "Nguyen", "nguyen@ex.com", "ACC003", "Partner", "67000.00", "false", "1995-07-30", ""],
                &["CON005", "Patel",  "patel@ex.com",  "ACC004", "Web",     "88000.00", "true",  "1988-02-14", ""],
            ],
        );

        let result = infer(
            &[(account_obj, account_rows), (contact_obj, contact_rows)],
            "Salesforce CRM",
        );

        // The model must pass structural validation (identity fields exist, refs resolve).
        result.model.check().expect("model should be structurally valid");

        let contact = result.model.entity("contact").unwrap();
        let account = result.model.entity("account").unwrap();

        // Identity.
        assert_eq!(contact.identity, vec!["id"]);
        assert_eq!(account.identity, vec!["id"]);

        // AccountId → Ref("account") — target is known.
        let acct_id = contact.fields.iter().find(|f| f.key == "accountid").unwrap();
        assert_eq!(acct_id.ty, FieldType::Ref);
        assert_eq!(acct_id.reference.as_deref(), Some("account"));

        // LeadSource__c → Enum (name token "source").
        assert_eq!(field_ty(&contact.fields, "leadsource"), Some(FieldType::Enum));
        // AnnualSalary__c → Money (numeric + "salary" token).
        assert_eq!(field_ty(&contact.fields, "annualsalary"), Some(FieldType::Money));
        // IsEmailOptOut → Bool.
        assert_eq!(field_ty(&contact.fields, "isemailoptout"), Some(FieldType::Bool));
        // Birthdate → Date.
        assert_eq!(field_ty(&contact.fields, "birthdate"), Some(FieldType::Date));
        // Description → String, sparse → not required.
        let desc = contact.fields.iter().find(|f| f.key == "description").unwrap();
        assert_eq!(desc.ty, FieldType::String);
        assert!(!desc.required);

        // Account: Type → Enum (name token "type"); AnnualRevenue → Money.
        assert_eq!(field_ty(&account.fields, "type"), Some(FieldType::Enum));
        assert_eq!(field_ty(&account.fields, "annualrevenue"), Some(FieldType::Money));

        // Provenance is present for every field on every entity.
        for ei in &result.entities {
            assert_eq!(ei.entity.fields.len(), ei.provenances.len());
        }
    }
}
