//! The packaged corpus — one JSON file per record under `corpus/procedures/` and `corpus/remedies/`,
//! embedded at compile time with `include_dir!` (#1614, the same pattern `crates/compliance` uses).
//!
//! Keeping the field knowledge as DATA rather than Rust literals is what makes it reviewable by
//! somebody who knows the subject and not the language, and it is what lets a correction ship as a
//! diff to one file rather than a patch to a source module.
//!
//! Pure data — no runtime I/O — so [`baseline`] is unit-testable and the store layer just persists it.

use crate::types::{Procedure, Remedy};
use include_dir::{include_dir, Dir};

/// The corpus version stamp written alongside the seed. Bump it when the packaged set changes, so a
/// re-seed can tell whether it is behind. Distinct from the app's version.
pub const CORPUS_VERSION: u32 = 1;

/// The standing note the compiled manual opens with. It is a const rather than prose in a template
/// because it is rendered in more than one place and must not drift between them.
pub const PREAMBLE: &str = "\
This is reference documentation, not medical advice, and it does not replace getting to care.

Two things it is honest about, and you should read them the same way:

  * Every procedure carries LIMITS — what it does not do. The improvised filter clears mud; it does
    not make water safe. Read the limits before you rely on the method.
  * Every remedy carries CAUTIONS and, where one exists, a LOOK-ALIKE with the tell that separates
    them. Misidentification is how this material actually hurts people. If the tell does not check
    out, you have the wrong plant.";

/// The packaged procedures, one JSON file per record.
static PROCEDURES_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/corpus/procedures");
/// The packaged remedies, one JSON file per record.
static REMEDIES_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/corpus/remedies");

/// Deserialize every `*.json` in `dir`, sorted by id for a deterministic order.
///
/// A file that does not parse is a HARD ERROR rather than a skip. `crates/compliance` silently drops
/// one (`filter_map(… .ok())`) and that is the wrong trade for this corpus: a dropped standard is a
/// missing obligation, while a dropped procedure is a person looking up how to stop a bleed and being
/// told there is no such record.
fn load<T: serde::de::DeserializeOwned>(dir: &Dir, kind: &str) -> Vec<T> {
    let mut out: Vec<(String, T)> = dir
        .files()
        .filter(|f| f.path().extension().is_some_and(|e| e == "json"))
        .map(|f| {
            let name = f.path().display().to_string();
            let v: T = serde_json::from_slice(f.contents())
                .unwrap_or_else(|e| panic!("packaged {kind} corpus file {name} does not parse: {e}"));
            (name, v)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, v)| v).collect()
}

/// Every packaged procedure, ordered by file name (which is the id).
pub fn procedures() -> Vec<Procedure> {
    load(&PROCEDURES_DIR, "procedure")
}

/// Every packaged remedy, ordered by file name (which is the id).
pub fn remedies() -> Vec<Remedy> {
    load(&REMEDIES_DIR, "remedy")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Category, Function};

    /// THE COUNT + KNOWN-VALUE PIN. A corpus edit that drops a record, or quietly renames a field so
    /// serde defaults it away, passes every behavioural test in this crate — the query still runs, it
    /// just returns less. This is the guard that notices.
    #[test]
    fn the_packaged_corpus_is_the_one_we_shipped() {
        let procs = procedures();
        let rems = remedies();
        assert_eq!(procs.len(), 16, "16 packaged procedures");
        assert_eq!(rems.len(), 16, "16 packaged remedies");

        let p = |id: &str| procs.iter().find(|p| p.id == id).unwrap_or_else(|| panic!("{id} present"));
        let r = |id: &str| rems.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("{id} present"));

        // The record the whole safety argument rests on: the filter must say it is not a treatment.
        let filter = p("water-improvised-filter");
        assert_eq!(filter.category, Category::Water);
        assert!(
            filter.limits.iter().any(|l| l.contains("DOES NOT MAKE WATER SAFE")),
            "the improvised filter still says, in its limits, that it does not make water safe",
        );
        assert!(filter.materials.iter().any(|m| m.item.contains("charcoal")));

        // Bleeding control is the medical entry point and names the tourniquet escalation.
        let bleed = p("bleeding-direct-pressure");
        assert_eq!(bleed.category, Category::Medical);
        assert!(bleed.steps.len() >= 5);
        assert!(bleed.haystack().contains("tourniquet"));

        // Yarrow is the hemostatic worth having and carries the hemlock tell.
        let yarrow = r("yarrow");
        assert!(yarrow.functions.contains(&Function::Hemostatic));
        let hemlock = yarrow
            .lookalikes
            .iter()
            .find(|l| l.name.contains("Poison hemlock"))
            .expect("yarrow still names poison hemlock");
        assert!(hemlock.tell.contains("HOLLOW") && hemlock.tell.contains("PURPLE"));

        // Honey is the best-evidenced antiseptic here and must keep its infant-botulism caution.
        assert!(r("honey").cautions.iter().any(|c| c.contains("infant")));
    }

    /// The two safety fields are only load-bearing if they are actually populated. A record with an
    /// empty `limits` reads, to every consumer, as "this has no limits".
    #[test]
    fn every_record_states_its_limits_and_its_cautions() {
        for p in procedures() {
            assert!(!p.limits.is_empty(), "procedure {} states what it does NOT do", p.id);
            assert!(!p.summary.trim().is_empty(), "procedure {} has a summary", p.id);
            assert!(!p.steps.is_empty(), "procedure {} has steps", p.id);
        }
        for r in remedies() {
            assert!(!r.cautions.is_empty(), "remedy {} states its cautions", r.id);
            assert!(!r.functions.is_empty(), "remedy {} is for something", r.id);
        }
    }

    /// A look-alike names a danger AND the observable difference. A warning with no exit leaves the
    /// reader worse off than no warning: it says "this might kill you" and not "here is how to tell".
    #[test]
    fn every_lookalike_carries_the_tell_that_separates_it() {
        for r in remedies() {
            for l in &r.lookalikes {
                assert!(!l.danger.trim().is_empty(), "{} / {} says what the danger is", r.id, l.name);
                assert!(
                    l.tell.trim().len() > 20,
                    "{} / {} gives a usable tell, not a gesture at one",
                    r.id,
                    l.name
                );
            }
        }
        // The four that can kill you must each name their lethal confusion by name.
        let rems = remedies();
        for (id, lookalike) in [
            ("yarrow", "Poison hemlock"),
            ("pine-resin", "Yew"),
            ("garlic", "Lily of the valley"),
            ("cattail", "Yellow flag iris"),
        ] {
            let r = rems.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("{id} present"));
            assert!(
                r.lookalikes.iter().any(|l| l.name.contains(lookalike)),
                "{id} still names {lookalike}",
            );
        }
    }

    /// Ids are the store key, so a collision would silently overwrite one record with another.
    #[test]
    fn ids_are_unique_within_each_kind() {
        for ids in [
            procedures().iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
            remedies().iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        ] {
            let mut sorted = ids.clone();
            sorted.sort();
            sorted.dedup();
            assert_eq!(sorted.len(), ids.len(), "ids are unique: {ids:?}");
        }
    }

    /// Every category and every function is reachable — a filter token that matches nothing in the
    /// packaged corpus is a promise the CLI cannot keep.
    #[test]
    fn every_category_and_function_has_at_least_one_record() {
        let procs = procedures();
        for c in Category::all() {
            assert!(procs.iter().any(|p| p.category == c), "a procedure exists for {}", c.as_str());
        }
        let rems = remedies();
        for f in Function::all() {
            assert!(
                rems.iter().any(|r| r.functions.contains(&f)),
                "a remedy exists for {}",
                f.as_str()
            );
        }
    }
}
