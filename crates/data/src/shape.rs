//! Schema → **data shape** inference (#2478) — derive each entity's ideal rendering shape from the
//! canonical [`DataModel`], so the planning session picks a layout mechanically instead of judging
//! the taxonomy by hand.
//!
//! The shape vocabulary is NOT invented here: it is the six-shape axis landed by #2475
//! (`list` · `linked-list` · `tree` · `graph` · `table` · `key-value`), mirrored from
//! `DATA_SHAPES` in `crates/bsc-component/src/cli.rs` and `DataShape` in
//! `src/features/designs/lib/model.ts`. This module is the OTHER half of that loop: #2475 answers
//! "which components render shape X" (`bsc ui shapes <shape>`), this answers "what shape IS my
//! data" (`bsc data shapes`). Together the planner never asks the user to know the vocabulary.
//!
//! **Relationships are real in the model.** The canonical Data Model carries foreign keys as
//! [`FieldType::Ref`] fields whose [`Field::reference`] names the target entity — it simply doesn't
//! use the words "foreign key". A *self-referencing* FK is therefore `ty == Ref && reference ==
//! Some(<own key>)`, which is the signal the tree/graph heuristics turn on.
//!
//! **Candidates, not a guess.** Several signals are genuinely ambiguous — a single self-referencing
//! FK is a `tree` if an item has one parent and a `graph` if it may have several, and the schema
//! alone cannot say which. So inference returns a RANKED list of [`ShapeCandidate`]s, each carrying
//! the reason it fired, and the planner presents them for the user to confirm. A confidently wrong
//! shape is worse than a ranked suggestion.
//!
//! Pure + Tauri-free + store-free (no `duckdb-store` gate): it reads a `DataModel` value, so it is
//! unit-testable without a DuckDB file.

use serde::{Deserialize, Serialize};

use crate::schema::{DataModel, Entity, Field, FieldType};

/// The six canonical data shapes (#2475). Serializes as the vocabulary slug (`linked-list`,
/// `key-value`, …) so `bsc data shapes` output feeds straight into `bsc ui shapes <shape>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataShape {
    List,
    LinkedList,
    Tree,
    Graph,
    Table,
    KeyValue,
}

impl DataShape {
    /// Every shape in vocabulary order — the same order `bsc ui shapes` prints.
    pub const ALL: [DataShape; 6] = [
        DataShape::List,
        DataShape::LinkedList,
        DataShape::Tree,
        DataShape::Graph,
        DataShape::Table,
        DataShape::KeyValue,
    ];

    /// The vocabulary slug — the exact token `bsc ui shapes <shape>` / `bsc ui list --shape` accept.
    pub fn slug(self) -> &'static str {
        match self {
            DataShape::List => "list",
            DataShape::LinkedList => "linked-list",
            DataShape::Tree => "tree",
            DataShape::Graph => "graph",
            DataShape::Table => "table",
            DataShape::KeyValue => "key-value",
        }
    }

    /// The one-line description, kept verbatim in step with `bsc ui shapes`.
    pub fn desc(self) -> &'static str {
        match self {
            DataShape::List => "a flat, ordered collection of homogeneous items",
            DataShape::LinkedList => "a sequence whose items chain by explicit next/prev links",
            DataShape::Tree => "a hierarchy — every item nests under a single parent",
            DataShape::Graph => "nodes joined by arbitrary edges (many-to-many)",
            DataShape::Table => "homogeneous records with fixed, aligned columns",
            DataShape::KeyValue => "one record's named fields — a label → value map",
        }
    }

    /// Parse a vocabulary slug.
    pub fn parse(s: &str) -> Option<DataShape> {
        DataShape::ALL.into_iter().find(|d| d.slug() == s)
    }
}

/// How strongly the schema implies a shape. Ranks the candidate list; never a probability — the
/// schema is evidence, the user confirms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    /// A fallback rendering that is always available, not something the schema argues for.
    Possible,
    /// A real structural signal fired, but a competing reading is plausible.
    Likely,
    /// An unambiguous structural signal (an explicit chain link, an attribute bag, a join table).
    Strong,
}

impl Confidence {
    /// The lowercase token — kept identical to the serde output so the CLI's lean TSV and its
    /// `--json` never disagree on the word.
    pub fn label(self) -> &'static str {
        match self {
            Confidence::Possible => "possible",
            Confidence::Likely => "likely",
            Confidence::Strong => "strong",
        }
    }
}

/// One suggested shape for an entity, with the evidence that produced it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShapeCandidate {
    pub shape: DataShape,
    pub confidence: Confidence,
    /// Why this shape fired, phrased for the planner to read aloud to the user.
    pub reason: String,
}

/// Every shape suggested for one entity, ranked strongest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityShapes {
    pub entity: String,
    pub label: String,
    pub candidates: Vec<ShapeCandidate>,
}

impl EntityShapes {
    /// The top-ranked shape — what the planner leads with. `None` only for an entity with no fields
    /// at all, which never happens for a checked model.
    pub fn best(&self) -> Option<&ShapeCandidate> {
        self.candidates.first()
    }
}

/* ───────────────────────────── naming signals ───────────────────────────── */

/// Field keys that name an explicit chain link — the `linked-list` signal (#2478: "next/prev").
const CHAIN_KEYS: &[&str] = &["next", "prev", "previous", "pred", "predecessor", "succ", "successor"];

/// Field keys that name a parent edge — raises a self-referencing FK from ambiguous to a confident
/// `tree` (a `parent` is single-valued by name in a way a bare self-ref is not).
const PARENT_KEYS: &[&str] = &["parent", "manager", "reports_to", "supervisor", "container", "belongs_to"];

/// Numeric ordering columns — the second `linked-list` signal (#2478: "or sequence column").
const SEQUENCE_KEYS: &[&str] =
    &["sequence", "seq", "order", "ordinal", "position", "pos", "rank", "step", "index", "sort_order"];

/// The name half of an attribute bag (EAV) — pairs with [`VALUE_KEYS`] for `key-value`.
const NAME_KEYS: &[&str] = &["key", "name", "attribute", "attr", "property", "prop", "label"];

/// The value half of an attribute bag.
const VALUE_KEYS: &[&str] = &["value", "val"];

/// Normalize a field key for name matching: drop a trailing FK suffix and lowercase, so `parentId`,
/// `parent_id`, `PARENT_ID` and `parent` all read as `parent`.
///
/// The suffix is stripped ONLY when it is delimited — `_id` / `_ID`, or a camelCase capital `Id`.
/// Chopping a bare lowercase `id` off any key would turn `valid` into `val` and make an ordinary
/// boolean flag masquerade as the value half of an attribute bag.
fn norm_key(key: &str) -> String {
    let k = key.trim();
    if let Some(stem) = k.strip_suffix("_id").or_else(|| k.strip_suffix("_ID")) {
        if !stem.is_empty() {
            return stem.to_ascii_lowercase();
        }
    }
    if let Some(stem) = k.strip_suffix("Id") {
        if !stem.is_empty() {
            return stem.to_ascii_lowercase();
        }
    }
    k.to_ascii_lowercase()
}

fn key_matches(field: &Field, set: &[&str]) -> bool {
    let n = norm_key(&field.key);
    set.contains(&n.as_str())
}

/// Is `entity` a JOIN TABLE — nearly all wiring, pointing at ≥2 distinct other entities? Such an
/// entity IS the edge set of a many-to-many relation rather than a record collection.
fn is_join_table(entity: &Entity) -> bool {
    foreign_targets(entity).len() >= 2 && payload_fields(entity).len() <= 2
}

/* ───────────────────────────── structural reads ───────────────────────────── */

/// The entity's self-referencing FKs — `ref` fields pointing back at its own key. THE tree/graph
/// signal (#2478).
fn self_refs(entity: &Entity) -> Vec<&Field> {
    entity
        .fields
        .iter()
        .filter(|f| f.ty == FieldType::Ref && f.reference.as_deref() == Some(entity.key.as_str()))
        .collect()
}

/// The entity's outbound FKs to OTHER entities, deduped by target — the join-heaviness signal.
fn foreign_targets(entity: &Entity) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for f in &entity.fields {
        if f.ty != FieldType::Ref {
            continue;
        }
        let Some(target) = f.reference.as_deref() else { continue };
        if target == entity.key || out.contains(&target) {
            continue;
        }
        out.push(target);
    }
    out
}

/// Fields that carry payload rather than wiring — everything that is not a `ref` and not part of
/// the identity. Drives the join-table read (a junction is nearly all wiring) and the list/table
/// density split.
fn payload_fields(entity: &Entity) -> Vec<&Field> {
    entity
        .fields
        .iter()
        .filter(|f| f.ty != FieldType::Ref && !entity.identity.contains(&f.key))
        .collect()
}

/* ───────────────────────────── inference ───────────────────────────── */

/// Collects candidates, keeping the strongest reason per shape.
#[derive(Default)]
struct Bag(Vec<ShapeCandidate>);

impl Bag {
    fn add(&mut self, shape: DataShape, confidence: Confidence, reason: impl Into<String>) {
        match self.0.iter_mut().find(|c| c.shape == shape) {
            // A stronger signal for the same shape replaces the weaker one's reasoning.
            Some(existing) if confidence > existing.confidence => {
                existing.confidence = confidence;
                existing.reason = reason.into();
            }
            Some(_) => {}
            None => self.0.push(ShapeCandidate { shape, confidence, reason: reason.into() }),
        }
    }

    /// Rank strongest first; ties break by vocabulary order so output is deterministic.
    fn ranked(mut self) -> Vec<ShapeCandidate> {
        self.0.sort_by(|a, b| b.confidence.cmp(&a.confidence).then(a.shape.cmp(&b.shape)));
        self.0
    }
}

/// Derive the ranked shape candidates for ONE entity of `model`.
///
/// The heuristics, in the order #2478 specifies them:
/// - a **self-referencing FK** → `tree`, or `graph` when several self-refs / a many-to-many join
///   admit multiple parents. A lone self-ref keeps BOTH (the schema cannot tell a hierarchy from a
///   DAG) — `tree` leads, `graph` follows with the question to ask.
/// - an **explicit chain link** (`next`/`prev`, by name) → `linked-list`; a numeric **sequence
///   column** is the weaker form of the same signal.
/// - a **join table** (nearly all wiring, ≥2 distinct FK targets) or **join-heavy** entity (≥3
///   distinct FK targets) → `graph`.
/// - an **attribute bag** (a name column + a value column) → `key-value`.
/// - otherwise a **plain collection** → `table` when column-dense, `list` when lean; the other
///   stays as the alternative.
///
/// `key-value` is always offered last as the entity's single-record DETAIL view — every entity has
/// one, so it is a `Possible` fallback rather than a signal.
pub fn infer_entity_shapes(model: &DataModel, entity: &Entity) -> EntityShapes {
    let mut bag = Bag::default();

    let selves = self_refs(entity);
    let targets = foreign_targets(entity);
    let field_count = entity.fields.len();

    // ── chain links: the least ambiguous signal there is ──
    let chain: Vec<&&Field> = selves.iter().filter(|f| key_matches(f, CHAIN_KEYS)).collect();
    if let Some(f) = chain.first() {
        bag.add(
            DataShape::LinkedList,
            Confidence::Strong,
            format!(
                "`{}.{}` is a self-referencing link named for a chain step — items are threaded next/prev, not nested",
                entity.key, f.key
            ),
        );
    }

    // ── self-referencing FK → tree, with graph as the standing alternative ──
    let hierarchy: Vec<&&Field> = selves.iter().filter(|f| !key_matches(f, CHAIN_KEYS)).collect();
    match hierarchy.len() {
        0 => {}
        1 => {
            let f = hierarchy[0];
            let named_parent = key_matches(f, PARENT_KEYS);
            bag.add(
                DataShape::Tree,
                if named_parent { Confidence::Strong } else { Confidence::Likely },
                format!(
                    "`{}.{}` references `{}` itself — a single-parent hierarchy{}",
                    entity.key,
                    f.key,
                    entity.key,
                    if named_parent { ", and the field is named as the parent edge" } else { "" }
                ),
            );
            // The genuine ambiguity: one self-ref is a tree ONLY if an item has at most one parent.
            bag.add(
                DataShape::Graph,
                Confidence::Likely,
                format!(
                    "the same self-reference `{}.{}` is a graph rather than a tree if an item may have MORE than one parent (or the links form a cycle) — confirm with the user",
                    entity.key, f.key
                ),
            );
        }
        n => {
            // Several self-refs cannot be a single-parent hierarchy.
            bag.add(
                DataShape::Graph,
                Confidence::Strong,
                format!(
                    "`{}` has {n} self-references — items link to their own kind along several edges, which no single-parent hierarchy can express",
                    entity.key
                ),
            );
            bag.add(
                DataShape::Tree,
                Confidence::Possible,
                format!(
                    "one of `{}`'s self-references may still be the dominant parent edge — a tree view over that ONE edge stays valid",
                    entity.key
                ),
            );
        }
    }

    // ── sequence column: the weaker linked-list form ──
    if chain.is_empty() {
        if let Some(f) =
            entity.fields.iter().find(|f| f.ty == FieldType::Number && key_matches(f, SEQUENCE_KEYS))
        {
            bag.add(
                DataShape::LinkedList,
                Confidence::Likely,
                format!(
                    "`{}.{}` is a numeric ordering column — the records form a sequence, renderable as a chain of steps",
                    entity.key, f.key
                ),
            );
        }
    }

    // ── join table / join-heavy → graph ──
    if is_join_table(entity) {
        bag.add(
            DataShape::Graph,
            Confidence::Strong,
            format!(
                "`{}` is a join table — it references {} ({}) and carries almost no payload of its own, so it IS the edge set of a many-to-many relation",
                entity.key,
                targets.len(),
                targets.join(", ")
            ),
        );
    } else if targets.len() >= 3 {
        bag.add(
            DataShape::Graph,
            Confidence::Likely,
            format!(
                "`{}` references {} other entities ({}) — join-heavy enough that its neighbourhood reads as a graph",
                entity.key,
                targets.len(),
                targets.join(", ")
            ),
        );
    }

    // ── pulled into a many-to-many by a join table ELSEWHERE in the model ──
    // The one signal an entity's own fields cannot carry: `student` has no FK at all, yet
    // `enrollment` makes its relationship to `course` a graph. This is why inference takes the whole
    // model, not just the entity.
    let joined_by: Vec<&str> = model
        .entities
        .iter()
        .filter(|other| other.key != entity.key)
        .filter(|other| is_join_table(other) && foreign_targets(other).contains(&entity.key.as_str()))
        .map(|other| other.key.as_str())
        .collect();
    if !joined_by.is_empty() {
        bag.add(
            DataShape::Graph,
            Confidence::Likely,
            format!(
                "`{}` is pulled into a many-to-many by the join table{} {} — its RELATED records form a graph, even though `{}`'s own fields carry no reference",
                entity.key,
                if joined_by.len() > 1 { "s" } else { "" },
                joined_by.join(", "),
                entity.key
            ),
        );
    }

    // ── attribute bag → key-value ──
    let has_name = entity.fields.iter().any(|f| f.ty != FieldType::Ref && key_matches(f, NAME_KEYS));
    let has_value = entity.fields.iter().any(|f| f.ty != FieldType::Ref && key_matches(f, VALUE_KEYS));
    if has_name && has_value {
        bag.add(
            DataShape::KeyValue,
            Confidence::Strong,
            format!(
                "`{}` pairs a name column with a value column — an attribute bag, read as a label → value map rather than a row of columns",
                entity.key
            ),
        );
    }

    // ── plain collection: list vs table by column density ──
    // Always offered — every entity collection renders one way or the other; the density decides
    // which leads.
    let dense = field_count >= 5;
    bag.add(
        DataShape::Table,
        if dense { Confidence::Likely } else { Confidence::Possible },
        format!(
            "`{}` is a homogeneous collection with {field_count} columns — {}",
            entity.key,
            if dense { "column-dense enough to read as an aligned table" } else { "few enough columns that a table is the sparser of the two readings" }
        ),
    );
    bag.add(
        DataShape::List,
        if dense { Confidence::Possible } else { Confidence::Likely },
        format!(
            "`{}` is a homogeneous collection with {field_count} columns — {}",
            entity.key,
            if dense {
                "lean enough to summarize per item if only a few columns are surfaced"
            } else {
                "lean enough that one line per item carries the whole record"
            }
        ),
    );

    // ── every entity has a single-record detail view ──
    bag.add(
        DataShape::KeyValue,
        Confidence::Possible,
        format!("a single `{}` record's fields are a label → value map — the detail view behind any of the collection shapes", entity.key),
    );

    EntityShapes {
        entity: entity.key.clone(),
        label: if entity.label.is_empty() { entity.key.clone() } else { entity.label.clone() },
        candidates: bag.ranked(),
    }
}

/// Derive ranked shape candidates for every entity in the model, in model order.
pub fn infer_shapes(model: &DataModel) -> Vec<EntityShapes> {
    model.entities.iter().map(|e| infer_entity_shapes(model, e)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(key: &str, ty: FieldType) -> Field {
        Field {
            key: key.into(),
            label: String::new(),
            ty,
            required: false,
            reference: None,
            enum_values: Vec::new(),
            validate: None,
        }
    }

    fn fref(key: &str, target: &str) -> Field {
        Field { reference: Some(target.into()), ..f(key, FieldType::Ref) }
    }

    fn entity(key: &str, fields: Vec<Field>) -> Entity {
        Entity { key: key.into(), label: String::new(), fields, identity: vec!["id".into()] }
    }

    fn model(entities: Vec<Entity>) -> DataModel {
        DataModel { name: "m".into(), version: 1, entities }
    }

    fn shapes_of(m: &DataModel, key: &str) -> EntityShapes {
        infer_entity_shapes(m, m.entity(key).unwrap())
    }

    fn conf(es: &EntityShapes, shape: DataShape) -> Option<Confidence> {
        es.candidates.iter().find(|c| c.shape == shape).map(|c| c.confidence)
    }

    #[test]
    fn vocabulary_matches_the_2475_shape_axis() {
        // The slugs MUST stay byte-identical to `bsc ui shapes` / DATA_SHAPES, or the mechanical
        // hand-off `bsc data shapes` → `bsc ui shapes <shape>` breaks.
        let slugs: Vec<&str> = DataShape::ALL.iter().map(|s| s.slug()).collect();
        assert_eq!(slugs, vec!["list", "linked-list", "tree", "graph", "table", "key-value"]);
        for s in DataShape::ALL {
            assert_eq!(DataShape::parse(s.slug()), Some(s));
            assert!(!s.desc().is_empty());
        }
        assert_eq!(DataShape::parse("blob"), None);
    }

    #[test]
    fn shape_serializes_as_its_vocabulary_slug() {
        // The CLI's JSON feeds straight into `bsc ui shapes <shape>` — serde must emit the slug.
        let json = serde_json::to_string(&DataShape::LinkedList).unwrap();
        assert_eq!(json, "\"linked-list\"");
        assert_eq!(serde_json::to_string(&DataShape::KeyValue).unwrap(), "\"key-value\"");
    }

    #[test]
    fn confidence_label_matches_its_serde_token() {
        // The CLI prints `label()` in lean mode and serde's token in --json; a drift between them
        // would make the same row read differently in the two formats.
        for c in [Confidence::Possible, Confidence::Likely, Confidence::Strong] {
            assert_eq!(serde_json::to_string(&c).unwrap(), format!("\"{}\"", c.label()));
        }
        assert!(Confidence::Strong > Confidence::Likely && Confidence::Likely > Confidence::Possible);
    }

    #[test]
    fn self_referencing_fk_suggests_tree_and_keeps_graph_as_the_open_question() {
        // THE #2478 heuristic: a self-ref is a tree — but only if an item has one parent, which the
        // schema cannot say. Both must be offered, tree leading.
        let m = model(vec![entity(
            "category",
            vec![f("id", FieldType::String), f("name", FieldType::String), fref("parent_id", "category")],
        )]);
        let es = shapes_of(&m, "category");
        // `parent` is named as the parent edge → strong.
        assert_eq!(conf(&es, DataShape::Tree), Some(Confidence::Strong));
        assert_eq!(es.best().unwrap().shape, DataShape::Tree);
        // ...and the ambiguity is surfaced, not silently resolved.
        assert_eq!(conf(&es, DataShape::Graph), Some(Confidence::Likely));
        let graph = es.candidates.iter().find(|c| c.shape == DataShape::Graph).unwrap();
        assert!(graph.reason.contains("more than one parent") || graph.reason.contains("MORE than one parent"));
    }

    #[test]
    fn unnamed_self_ref_is_only_likely_a_tree() {
        // No `parent`-ish name → the hierarchy reading is weaker, and graph ties with it.
        let m = model(vec![entity("node", vec![f("id", FieldType::String), fref("origin", "node")])]);
        let es = shapes_of(&m, "node");
        assert_eq!(conf(&es, DataShape::Tree), Some(Confidence::Likely));
        assert_eq!(conf(&es, DataShape::Graph), Some(Confidence::Likely));
    }

    #[test]
    fn multiple_self_refs_flip_the_lead_to_graph() {
        // Two self-refs cannot be a single-parent hierarchy — graph leads, tree survives as a view.
        let m = model(vec![entity(
            "person",
            vec![f("id", FieldType::String), fref("mother_id", "person"), fref("father_id", "person")],
        )]);
        let es = shapes_of(&m, "person");
        assert_eq!(es.best().unwrap().shape, DataShape::Graph);
        assert_eq!(conf(&es, DataShape::Graph), Some(Confidence::Strong));
        assert_eq!(conf(&es, DataShape::Tree), Some(Confidence::Possible));
    }

    #[test]
    fn next_prev_self_ref_is_a_linked_list_not_a_tree() {
        // A chain link is a self-ref too — but it threads, it does not nest. It must NOT be read
        // as a hierarchy.
        let m = model(vec![entity(
            "step",
            vec![f("id", FieldType::String), f("title", FieldType::String), fref("next_id", "step")],
        )]);
        let es = shapes_of(&m, "step");
        assert_eq!(es.best().unwrap().shape, DataShape::LinkedList);
        assert_eq!(conf(&es, DataShape::LinkedList), Some(Confidence::Strong));
        assert_eq!(conf(&es, DataShape::Tree), None, "a chain link is not a parent edge");
    }

    #[test]
    fn numeric_sequence_column_is_the_weaker_linked_list_signal() {
        let m = model(vec![entity(
            "stage",
            vec![f("id", FieldType::String), f("position", FieldType::Number)],
        )]);
        let es = shapes_of(&m, "stage");
        assert_eq!(conf(&es, DataShape::LinkedList), Some(Confidence::Likely));
        // A non-numeric column of the same name is NOT an ordering column.
        let m2 = model(vec![entity(
            "stage",
            vec![f("id", FieldType::String), f("position", FieldType::String)],
        )]);
        assert_eq!(conf(&shapes_of(&m2, "stage"), DataShape::LinkedList), None);
    }

    #[test]
    fn join_table_is_a_graph() {
        // Nearly-all-wiring + ≥2 distinct targets = the edge set of a many-to-many.
        let m = model(vec![
            entity("student", vec![f("id", FieldType::String)]),
            entity("course", vec![f("id", FieldType::String)]),
            entity(
                "enrollment",
                vec![f("id", FieldType::String), fref("student_id", "student"), fref("course_id", "course")],
            ),
        ]);
        let es = shapes_of(&m, "enrollment");
        assert_eq!(es.best().unwrap().shape, DataShape::Graph);
        assert_eq!(conf(&es, DataShape::Graph), Some(Confidence::Strong));
        assert!(es.best().unwrap().reason.contains("join table"));
    }

    #[test]
    fn a_payload_carrying_entity_with_two_refs_is_not_a_join_table() {
        // Two FKs but real payload → an ordinary record, not an edge set.
        let m = model(vec![
            entity("customer", vec![f("id", FieldType::String)]),
            entity("product", vec![f("id", FieldType::String)]),
            entity(
                "order",
                vec![
                    f("id", FieldType::String),
                    fref("customer_id", "customer"),
                    fref("product_id", "product"),
                    f("total", FieldType::Money),
                    f("placed_at", FieldType::Date),
                    f("notes", FieldType::String),
                ],
            ),
        ]);
        let es = shapes_of(&m, "order");
        assert_ne!(conf(&es, DataShape::Graph), Some(Confidence::Strong));
        assert_eq!(es.best().unwrap().shape, DataShape::Table, "6 columns → column-dense");
    }

    #[test]
    fn join_heavy_entity_is_likely_a_graph() {
        let m = model(vec![
            entity("a", vec![f("id", FieldType::String)]),
            entity("b", vec![f("id", FieldType::String)]),
            entity("c", vec![f("id", FieldType::String)]),
            entity(
                "hub",
                vec![
                    f("id", FieldType::String),
                    fref("a_id", "a"),
                    fref("b_id", "b"),
                    fref("c_id", "c"),
                    f("t1", FieldType::String),
                    f("t2", FieldType::String),
                    f("t3", FieldType::String),
                ],
            ),
        ]);
        assert_eq!(conf(&shapes_of(&m, "hub"), DataShape::Graph), Some(Confidence::Likely));
    }

    #[test]
    fn duplicate_refs_to_one_target_are_not_join_heavy() {
        // Two FKs to the SAME entity is one relation, not two — targets dedupe.
        let m = model(vec![
            entity("user", vec![f("id", FieldType::String)]),
            entity(
                "message",
                vec![
                    f("id", FieldType::String),
                    fref("sender_id", "user"),
                    fref("recipient_id", "user"),
                    f("body", FieldType::String),
                    f("sent_at", FieldType::Date),
                    f("subject", FieldType::String),
                ],
            ),
        ]);
        assert_eq!(conf(&shapes_of(&m, "message"), DataShape::Graph), None);
    }

    #[test]
    fn attribute_bag_is_key_value() {
        let m = model(vec![entity(
            "setting",
            vec![f("id", FieldType::String), f("key", FieldType::String), f("value", FieldType::String)],
        )]);
        let es = shapes_of(&m, "setting");
        assert_eq!(es.best().unwrap().shape, DataShape::KeyValue);
        assert_eq!(conf(&es, DataShape::KeyValue), Some(Confidence::Strong));
        assert!(es.best().unwrap().reason.contains("attribute bag"));
    }

    #[test]
    fn column_density_decides_list_versus_table() {
        let lean = model(vec![entity(
            "tag",
            vec![f("id", FieldType::String), f("title", FieldType::String)],
        )]);
        let es = shapes_of(&lean, "tag");
        assert_eq!(es.best().unwrap().shape, DataShape::List);
        assert_eq!(conf(&es, DataShape::Table), Some(Confidence::Possible));

        let dense = model(vec![entity(
            "invoice",
            vec![
                f("id", FieldType::String),
                f("number", FieldType::String),
                f("issued", FieldType::Date),
                f("due", FieldType::Date),
                f("total", FieldType::Money),
                f("status", FieldType::Enum),
            ],
        )]);
        let es = shapes_of(&dense, "invoice");
        assert_eq!(es.best().unwrap().shape, DataShape::Table);
        assert_eq!(conf(&es, DataShape::List), Some(Confidence::Possible));
    }

    #[test]
    fn every_entity_offers_a_key_value_detail_view() {
        // The collection shapes answer "how do I list these"; key-value always answers "how do I
        // show ONE" — so it is never absent.
        let m = model(vec![entity("thing", vec![f("id", FieldType::String)])]);
        let es = shapes_of(&m, "thing");
        assert_eq!(conf(&es, DataShape::KeyValue), Some(Confidence::Possible));
        assert!(es.candidates.iter().any(|c| c.shape == DataShape::List));
    }

    #[test]
    fn candidates_rank_strongest_first_and_are_deterministic() {
        let m = model(vec![entity(
            "category",
            vec![f("id", FieldType::String), f("name", FieldType::String), fref("parent_id", "category")],
        )]);
        let es = shapes_of(&m, "category");
        for w in es.candidates.windows(2) {
            assert!(w[0].confidence >= w[1].confidence, "ranked strongest first");
        }
        // No shape appears twice — the bag keeps the strongest reason per shape.
        let mut seen: Vec<DataShape> = es.candidates.iter().map(|c| c.shape).collect();
        let before = seen.len();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), before);
        // Stable across runs.
        assert_eq!(shapes_of(&m, "category"), es);
    }

    #[test]
    fn every_candidate_carries_a_reason() {
        let m = model(vec![
            entity("student", vec![f("id", FieldType::String)]),
            entity("course", vec![f("id", FieldType::String), fref("prereq", "course")]),
            entity(
                "enrollment",
                vec![f("id", FieldType::String), fref("student_id", "student"), fref("course_id", "course")],
            ),
        ]);
        let all = infer_shapes(&m);
        assert_eq!(all.len(), 3, "one entry per entity, in model order");
        assert_eq!(all[0].entity, "student");
        for es in &all {
            assert!(!es.candidates.is_empty());
            for c in &es.candidates {
                assert!(!c.reason.trim().is_empty(), "{} / {:?} has no reason", es.entity, c.shape);
            }
        }
    }

    #[test]
    fn label_falls_back_to_the_entity_key() {
        let m = model(vec![Entity {
            label: "Sales Account".into(),
            ..entity("account", vec![f("id", FieldType::String)])
        }]);
        assert_eq!(shapes_of(&m, "account").label, "Sales Account");
        let m2 = model(vec![entity("account", vec![f("id", FieldType::String)])]);
        assert_eq!(shapes_of(&m2, "account").label, "account");
    }

    #[test]
    fn norm_key_strips_only_a_delimited_id_suffix() {
        assert_eq!(norm_key("parent_id"), "parent");
        assert_eq!(norm_key("PARENT_ID"), "parent");
        assert_eq!(norm_key("parentId"), "parent");
        assert_eq!(norm_key("PARENT"), "parent");
        assert_eq!(norm_key("  next_id  "), "next");
        assert_eq!(norm_key("id"), "id", "the identity column is not a `<thing>id` reference");
        assert_eq!(norm_key("next"), "next");
        // REGRESSION: chopping a bare lowercase `id` off any key turns `valid` into `val`, which
        // would let an ordinary boolean flag pose as the value half of an attribute bag.
        assert_eq!(norm_key("valid"), "valid");
        assert_eq!(norm_key("_id"), "_id", "a suffix-only key keeps its text rather than emptying");
    }

    #[test]
    fn a_valid_flag_does_not_fake_an_attribute_bag() {
        // The `norm_key` regression, end to end: `name` + `valid` is NOT a key/value pair.
        let m = model(vec![entity(
            "rule",
            vec![f("id", FieldType::String), f("name", FieldType::String), f("valid", FieldType::Bool)],
        )]);
        assert_ne!(conf(&shapes_of(&m, "rule"), DataShape::KeyValue), Some(Confidence::Strong));
    }

    #[test]
    fn an_entity_joined_by_a_join_table_elsewhere_is_a_graph() {
        // THE reason inference takes the whole model: `student` has no ref of its own, yet
        // `enrollment` makes its relationship to `course` a many-to-many.
        let m = model(vec![
            entity("student", vec![f("id", FieldType::String), f("name", FieldType::String)]),
            entity("course", vec![f("id", FieldType::String), f("title", FieldType::String)]),
            entity(
                "enrollment",
                vec![f("id", FieldType::String), fref("student_id", "student"), fref("course_id", "course")],
            ),
        ]);
        let es = shapes_of(&m, "student");
        assert_eq!(conf(&es, DataShape::Graph), Some(Confidence::Likely));
        let why = &es.candidates.iter().find(|c| c.shape == DataShape::Graph).unwrap().reason;
        assert!(why.contains("enrollment"), "the reason names the join table: {why}");

        // ...and an entity NO join table points at gets no such candidate.
        let solo = model(vec![entity("note", vec![f("id", FieldType::String), f("body", FieldType::String)])]);
        assert_eq!(conf(&shapes_of(&solo, "note"), DataShape::Graph), None);
    }
}
