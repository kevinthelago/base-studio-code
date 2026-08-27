//! `requiredBy` — the USAGE edge, materialized on a library record.
//!
//! Shared by both graphs (`bsc ui` components and `bsc graph` implementations) so the two can never
//! disagree about what an entry means or which ones are valid.
//!
//! ## The relation, and why it is stored on both sides
//!
//! A plan feature declares what it needs: `requires` on `bsc plan feature`, a per-project list of
//! library ids. That is the authored intent and it stays the source of truth.
//!
//! This is the inverse, on the record: which features — in which projects — need this one. It is
//! many-to-many in both directions, because several features across several projects legitimately
//! need the same sort, the same button. Materializing it here is what makes "who needs this?"
//! answerable from the record instead of by scanning every project's plan store.
//!
//! ## Why entries are PROJECT-QUALIFIED
//!
//! A bare feature slug is ambiguous the moment two projects both have one — and nothing prevents that;
//! `settings` is a plausible feature name in any application. An entry is therefore
//! `<projectKey>:<feature>`, the same shape the fleet already uses for pane ids (`<key>:<stream>`), so
//! the reference resolves to exactly one feature in exactly one project.
//!
//! That qualification is also what keeps this honest against #3973 — "the library never learns about
//! projects". This does reverse that for the usage edge, deliberately and on the maintainer's call,
//! because the inverse read is worth the cost. What it must not do is store *bare* per-project slugs
//! that silently mean different things in different projects. So an unqualified entry is REFUSED
//! rather than stored: the ambiguity this exists to remove cannot creep back in through a write.
//!
//! ## Why not `usedBy`
//!
//! Both words were taken. `used` is already a stored integer on a component record — its composer
//! count — and `usedBy` is already the output key of `bsc ui used-by` / `bsc graph used-by`, meaning
//! *which records compose this*. A stored `usedBy` naming features would make the verb and the field
//! disagree about one word, which is exactly the collision that made `domain` the wrong name for the
//! ownership axis. `requiredBy` is the precise inverse of `requires` and collides with nothing.

/// One parsed entry: which project, and which feature or stream within it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RequiredBy {
    pub project: String,
    pub feature: String,
}

impl RequiredBy {
    /// The stored form, `<project>:<feature>`.
    pub fn to_entry(&self) -> String {
        format!("{}:{}", self.project, self.feature)
    }
}

/// Parse one stored entry, or say why it cannot be one.
///
/// REFUSES rather than guessing, on every shape that would store an ambiguous reference: a bare slug
/// with no project, an empty half, or more than one separator. The whole point of the field is that an
/// entry resolves to one feature in one project, and a lenient parser would quietly re-admit exactly
/// the ambiguity the qualification exists to remove.
pub fn parse_required_by(entry: &str) -> Result<RequiredBy, String> {
    let e = entry.trim();
    if e.is_empty() {
        return Err("an empty `requiredBy` entry".to_string());
    }
    let parts: Vec<&str> = e.split(':').collect();
    if parts.len() != 2 {
        return Err(format!(
            "`requiredBy` entry '{e}' must be <projectKey>:<feature> — a bare feature slug is \
             ambiguous across projects (two projects can both have a `settings` feature)"
        ));
    }
    let (project, feature) = (parts[0].trim(), parts[1].trim());
    if project.is_empty() || feature.is_empty() {
        return Err(format!("`requiredBy` entry '{e}' has an empty project or feature half"));
    }
    Ok(RequiredBy { project: project.to_string(), feature: feature.to_string() })
}

/// Normalize a whole list: parse every entry, drop duplicates, and sort.
///
/// Sorted and deduped so the field is ORDER-STABLE — re-deriving it from the same plan stores must
/// produce a byte-identical list, or every re-derivation rewrites every record and the store churns
/// for no reason. One bad entry fails the WHOLE list rather than being skipped: a silently dropped
/// reference is the failure mode this field exists to prevent.
pub fn normalize_required_by(entries: &[String]) -> Result<Vec<String>, String> {
    let mut parsed: Vec<RequiredBy> =
        entries.iter().map(|e| parse_required_by(e)).collect::<Result<_, _>>()?;
    parsed.sort();
    parsed.dedup();
    Ok(parsed.iter().map(RequiredBy::to_entry).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_qualified_entry_parses_into_its_two_halves() {
        let r = parse_required_by("studio-code:glance").unwrap();
        assert_eq!(r.project, "studio-code");
        assert_eq!(r.feature, "glance");
        assert_eq!(r.to_entry(), "studio-code:glance");
    }

    #[test]
    fn a_bare_slug_is_refused_because_it_is_ambiguous_across_projects() {
        // THE REASON THE FIELD IS QUALIFIED. Nothing stops two projects both having `settings`, so a
        // bare slug names no one record's user. Refusing at the write is what keeps that true.
        let err = parse_required_by("settings").unwrap_err();
        assert!(err.contains("<projectKey>:<feature>"), "{err}");
        assert!(err.contains("ambiguous"), "the error says WHY, not just that it failed: {err}");
    }

    #[test]
    fn an_empty_half_is_refused() {
        for bad in [":glance", "studio-code:", " : "] {
            assert!(parse_required_by(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn more_than_one_separator_is_refused_rather_than_split_arbitrarily() {
        // `a:b:c` could be read three ways. Guessing one would store a reference that resolves
        // somewhere nobody intended.
        assert!(parse_required_by("proj:feat:extra").is_err());
    }

    #[test]
    fn whitespace_around_an_entry_is_tolerated_but_not_inside_it() {
        assert_eq!(parse_required_by("  studio-code:glance  ").unwrap().feature, "glance");
        assert_eq!(parse_required_by("studio-code : glance").unwrap().project, "studio-code");
    }

    #[test]
    fn the_list_is_sorted_and_deduped_so_re_deriving_does_not_churn_the_store() {
        // Order-stability is not cosmetic: without it every re-derivation rewrites every record.
        let out = normalize_required_by(&[
            "b-proj:zeta".into(),
            "a-proj:alpha".into(),
            "b-proj:zeta".into(),
        ])
        .unwrap();
        assert_eq!(out, vec!["a-proj:alpha", "b-proj:zeta"]);
        assert_eq!(normalize_required_by(&out).unwrap(), out, "idempotent");
    }

    #[test]
    fn one_bad_entry_fails_the_whole_list_rather_than_being_dropped() {
        // A silently skipped reference is the exact failure this field exists to prevent — the record
        // would then under-report who needs it, which reads as "nobody does".
        let err = normalize_required_by(&["studio-code:glance".into(), "oops".into()]).unwrap_err();
        assert!(err.contains("oops"), "the error names the offending entry: {err}");
    }

    #[test]
    fn an_empty_list_is_valid_and_stays_empty() {
        assert_eq!(normalize_required_by(&[]).unwrap(), Vec::<String>::new());
    }
}
