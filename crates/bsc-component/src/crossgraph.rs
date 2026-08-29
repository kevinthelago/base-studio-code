//! The cross-pillar reference METER (`store-the-three-cross-pillar-edges`) — how many nodes in one
//! graph reference a node in another, DERIVED from record source rather than stored.
//!
//! # Why this is a derivation and not a stored edge set
//!
//! `epic-one-record-core-across-the-graphs` rejected one record type across the pillars on the strength
//! of a measurement: **three** cross-pillar references in the whole library, against ~39,000 LOC of
//! pillar-specific readers. A decision resting on a number needs that number to stay checkable, which
//! is what this module is for — and it is also the trigger to REOPEN that decision if the count climbs.
//!
//! The issue originally asked for the references to be persisted as `CrossGraphEdge` rows. They are not,
//! and the reason is the epic's own argument applied one level down: an `@bsc/<segment>/<name>` import
//! is already stated by the record's source, so a stored edge is a SECOND COPY of it. When the source
//! changes and the copy does not, the copy is wrong and nothing says so — the shape of
//! `nothing-keeps-a-graph-hosted-page-in-sync-with-its-file`, where 16 of 16 records had drifted. A
//! derivation cannot drift: it is recomputed from the thing it describes.
//!
//! Two facts made the choice easy rather than close:
//!   * `CrossGraphEdge` (`shared/lib/graph/crossGraph`) is **entirely unused** — nothing writes it and
//!     no record carries `requires` — so nothing is being migrated away from.
//!   * the algorithms store's `edges` array is the INTEGRATION-TEST tier (`{id, members}` of bare ids
//!     within one store, `set_edge` refusing fewer than two members). It is evidence about a test
//!     spanning records, not a cross-pillar reference, so reusing it would overload one shape with two
//!     meanings.
//!
//! # What counts as a reference
//!
//! A `@bsc/<segment>/<name>` import — the reserved cross-graph root (#3116), the THIRD
//! import-resolution class, which resolves against a library store rather than the preview import map.
//! Scanned out of every component record's `srcText` and every algorithm record's `code` with the same
//! [`crate::graph_health::import_specifiers`] the health checks use, so the meter and the checker agree
//! about what an import is.
//!
//! **The machinery that IMPLEMENTS the grammar is excluded**, and this is the one subtlety worth
//! knowing. `node-urn.ts`, `cross-graph.ts`, the two adapters and the preview shims all *mention*
//! `@bsc/…` — in prose, in doc comments, in string literals — without importing anything. Counting them
//! would report 19 references where there are 3 and quietly destroy the measurement. Reading imports
//! rather than grepping for the token is what keeps them out.

use serde_json::Value;
use std::collections::BTreeMap;

/// The pillar a node lives in — the URN's leading token (`algo` | `ui` | `sound`), mirroring
/// `NodeGraph` in `shared/lib/graph/nodeUrn`. Deliberately NOT an enum over every store: `data` has no
/// URN segment (`the-data-pillar-has-no-urn-segment`, withdrawn with evidence), so inventing one here
/// would claim a grammar the resolver does not implement.
pub const SEGMENT_TO_PILLAR: [(&str, &str); 3] =
    [("algorithms", "algo"), ("ui", "ui"), ("sounds", "sound")];

/// One cross-pillar reference: a node in `from_pillar` importing a node in `to_pillar`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrossRef {
    /// The referencing record's id.
    pub from_id: String,
    /// The referencing record's pillar (`ui` for a component, `algo` for an implementation).
    pub from_pillar: String,
    /// The referenced pillar, from the specifier's `<segment>`.
    pub to_pillar: String,
    /// The referenced node's name — the specifier's `<name>`, kit-less by design.
    pub to_name: String,
    /// The specifier as written.
    pub spec: String,
}

/// The `<segment>` → pillar mapping, or `None` for a segment the URN grammar does not define.
fn pillar_for_segment(segment: &str) -> Option<&'static str> {
    SEGMENT_TO_PILLAR.iter().find(|(s, _)| *s == segment).map(|(_, p)| *p)
}

/// Split a `@bsc/<segment>/<name>` specifier into its pillar + name, or `None` when it is not one.
///
/// A name containing `/` is kept whole: the grammar's `<name>` is the in-kit id and the resolver takes
/// it verbatim, so splitting further would invent structure the URN does not have.
pub fn parse_library_spec(spec: &str) -> Option<(&'static str, String)> {
    let rest = spec.strip_prefix("@bsc/")?;
    let (segment, name) = rest.split_once('/')?;
    if name.is_empty() {
        return None;
    }
    Some((pillar_for_segment(segment)?, name.to_string()))
}

/// Every cross-pillar reference in one record's source, attributed to `from_id`/`from_pillar`.
///
/// Deduped per record: a module importing the same library node twice is ONE reference between those
/// two nodes, and counting it twice would make the meter depend on how the source happens to be written.
pub fn refs_in_source(from_id: &str, from_pillar: &str, source: &str) -> Vec<CrossRef> {
    let mut out: Vec<CrossRef> = Vec::new();
    for spec in crate::graph_health::import_specifiers(source) {
        let Some((to_pillar, to_name)) = parse_library_spec(&spec) else { continue };
        if out.iter().any(|r| r.spec == spec) {
            continue;
        }
        out.push(CrossRef {
            from_id: from_id.to_string(),
            from_pillar: from_pillar.to_string(),
            to_pillar: to_pillar.to_string(),
            to_name,
            spec,
        });
    }
    out
}

/// The meter over both stores: every cross-pillar reference held by a component record (`srcText`) or an
/// algorithm record (`code`), sorted by (from_id, spec) so two runs over an unchanged library produce
/// byte-identical output and a diff means something moved.
///
/// `components` and `implementations` are passed in rather than read here, so the derivation is pure and
/// testable without either store on disk.
pub fn meter(components: &[Value], implementations: &[Value]) -> Vec<CrossRef> {
    let mut out = Vec::new();
    for (records, pillar, content) in
        [(components, "ui", "srcText"), (implementations, "algo", "code")]
    {
        for rec in records {
            let Some(id) = rec.get("id").and_then(Value::as_str) else { continue };
            let Some(src) = rec.get(content).and_then(Value::as_str) else { continue };
            out.extend(refs_in_source(id, pillar, src));
        }
    }
    out.sort_by(|a, b| (&a.from_id, &a.spec).cmp(&(&b.from_id, &b.spec)));
    out
}

/// `from_pillar -> to_pillar` counts, the one-line summary of [`meter`].
pub fn by_direction(refs: &[CrossRef]) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for r in refs {
        *m.entry(format!("{}->{}", r.from_pillar, r.to_pillar)).or_insert(0) += 1;
    }
    m
}

/// The meter as JSON — what the CLI prints.
pub fn report(components: &[Value], implementations: &[Value]) -> Value {
    let refs = meter(components, implementations);
    serde_json::json!({
        "count": refs.len(),
        "byDirection": by_direction(&refs),
        "references": refs.iter().map(|r| serde_json::json!({
            "from": r.from_id, "fromPillar": r.from_pillar,
            "toPillar": r.to_pillar, "to": r.to_name, "spec": r.spec,
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_library_spec_and_declines_everything_else() {
        assert_eq!(parse_library_spec("@bsc/algorithms/fibonacci"), Some(("algo", "fibonacci".into())));
        assert_eq!(parse_library_spec("@bsc/sounds/click"), Some(("sound", "click".into())));
        assert_eq!(parse_library_spec("@bsc/ui/Sparkline"), Some(("ui", "Sparkline".into())));
        // `data` has no URN segment — the grammar does not define it, so neither does this.
        assert_eq!(parse_library_spec("@bsc/data/app-store"), None);
        assert_eq!(parse_library_spec("@/features/designs/lib/seed"), None);
        assert_eq!(parse_library_spec("react"), None);
        assert_eq!(parse_library_spec("@bsc/algorithms"), None, "no name");
        assert_eq!(parse_library_spec("@bsc/algorithms/"), None, "empty name");
    }

    #[test]
    fn a_scoped_name_is_kept_whole() {
        // The grammar's `<name>` is the in-kit id and the resolver takes it verbatim.
        assert_eq!(parse_library_spec("@bsc/sounds/neon/zap"), Some(("sound", "neon/zap".into())));
    }

    #[test]
    fn counts_imports_and_ignores_the_machinery_that_merely_mentions_the_grammar() {
        // THE MEASUREMENT THIS PROTECTS. 16 algorithm records name `@bsc/…` in prose and string
        // literals because they IMPLEMENT the grammar — node-urn.ts, cross-graph.ts, the adapters,
        // the preview shims. A grep would report 19 references where there are 3.
        let machinery = json!({
            "id": "node-urn.ts",
            "code": "// Resolve a `@bsc/<segment>/<name>` LIBRARY import (#3116)\n\
                     export const LIBRARY_SEGMENT = { algo: \"algorithms\", sound: \"sounds\" };\n\
                     const example = \"@bsc/algorithms/fibonacci\";",
        });
        let real = json!({
            "id": "sparkline",
            "srcText": "import { fib } from \"@bsc/algorithms/fibonacci\";\nexport const S = () => null;",
        });
        let refs = meter(&[real], &[machinery]);
        assert_eq!(refs.len(), 1, "only the real IMPORT counts: {refs:?}");
        assert_eq!(refs[0].from_id, "sparkline");
        assert_eq!(refs[0].from_pillar, "ui");
        assert_eq!(refs[0].to_pillar, "algo");
    }

    #[test]
    fn a_record_importing_the_same_node_twice_is_one_reference() {
        let c = json!({
            "id": "twice",
            "srcText": "import { a } from \"@bsc/algorithms/fibonacci\";\n\
                        import { b } from \"@bsc/algorithms/fibonacci\";",
        });
        assert_eq!(meter(&[c], &[]).len(), 1, "the meter counts node pairs, not import statements");
    }

    #[test]
    fn direction_counts_separate_the_pillars() {
        let a = json!({ "id": "x", "srcText": "import \"@bsc/algorithms/fibonacci\";" });
        let b = json!({ "id": "y", "srcText": "import \"@bsc/sounds/click\";" });
        let refs = meter(&[a, b], &[]);
        let d = by_direction(&refs);
        assert_eq!(d.get("ui->algo"), Some(&1));
        assert_eq!(d.get("ui->sound"), Some(&1));
    }

    #[test]
    fn output_is_stable_so_a_diff_means_something_moved() {
        let a = json!({ "id": "b-rec", "srcText": "import \"@bsc/sounds/click\";" });
        let b = json!({ "id": "a-rec", "srcText": "import \"@bsc/algorithms/fibonacci\";" });
        let one = meter(&[a.clone(), b.clone()], &[]);
        let two = meter(&[b, a], &[]);
        assert_eq!(one, two, "input order must not change the report");
        assert_eq!(one[0].from_id, "a-rec", "sorted by from_id");
    }

    #[test]
    fn an_empty_library_meters_zero_rather_than_erroring() {
        let refs = meter(&[], &[]);
        assert!(refs.is_empty());
        assert_eq!(report(&[], &[])["count"], 0);
    }
}
