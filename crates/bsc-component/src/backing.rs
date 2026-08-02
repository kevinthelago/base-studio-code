//! Which component record backs a given file (#4193) — the lookup behind `bsc ui backing` and the gate.
//!
//! The graph is the source of truth and a component's file is the emitted artifact, so a fix belongs in
//! the RECORD. That only works if a worker can find out, cheaply, that a file it is about to edit HAS a
//! record. Nothing answered that before: the pairing lived in the frontend shadow catalogue
//! (`src/app/runtime/shadowPages.ts`, DEV-only and Vite-glob bound), which a `bsc` session cannot read.
//!
//! This answers it from the store's own `src` provenance instead, so it covers **every** component rather
//! than only the pages the migration has catalogued.
//!
//! SCOPE — components only. An algorithm record is a function LIFTED OUT of a file and several share one
//! `src` (#4192 measured 34 of 63), so "this file is backed" cannot imply "this edit belonged in a
//! record" for them. A component record owns its file, which is what makes the question answerable here.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// One record that backs a path.
#[derive(Debug, PartialEq, Eq)]
pub struct Backing {
    pub id: String,
    pub kit_id: String,
    /// The record's stored `src`, verbatim — what the caller should recognise.
    pub src: String,
}

/// Normalize a path for comparison: backslashes to `/`, collapse `//`, drop a leading `./`.
///
/// Deliberately NOT case-folded and NOT canonicalized against the filesystem: the record's `src` is a
/// repo-relative string that may name a file the caller does not have, and touching the disk would make
/// a pure lookup fail differently on every machine.
pub fn normalize(path: &str) -> String {
    let s = path.replace('\\', "/");
    let s = s.trim_start_matches("./");
    let mut out = String::with_capacity(s.len());
    let mut prev_slash = false;
    for c in s.chars() {
        if c == '/' && prev_slash {
            continue;
        }
        prev_slash = c == '/';
        out.push(c);
    }
    out.trim_end_matches('/').to_string()
}

/// Does `path` refer to the file `src` names?
///
/// A worker's path may be absolute, repo-relative, or worktree-relative, so the match is a SUFFIX at a
/// path boundary — `…/src/features/x/Y.tsx` matches the record's `src/features/x/Y.tsx`, while a bare
/// `Y.tsx` does not match anything (a filename alone would collide across the tree and turn a gate into
/// noise). Equality is the other accepted form.
pub fn same_file(path: &str, src: &str) -> bool {
    let (p, s) = (normalize(path), normalize(src));
    if s.is_empty() || !s.contains('/') {
        // A provenance string with no directory cannot be matched safely — one filename backs many trees.
        return false;
    }
    p == s || p.ends_with(&format!("/{s}"))
}

/// Every record whose `src` names `path`. Empty ⇒ the file is not record-backed and the gate ignores it.
///
/// Returns ALL matches rather than the first: two records claiming one file is a real (and reportable)
/// state, and silently picking one would hide it.
pub fn backing_for(records: &[Value], path: &str) -> Vec<Backing> {
    let field = |v: &Value, k: &str| {
        v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).unwrap_or("").to_string()
    };
    records
        .iter()
        .filter(|r| {
            let src = field(r, "src");
            !src.is_empty() && same_file(path, &src)
        })
        .map(|r| Backing { id: field(r, "id"), kit_id: field(r, "kitId"), src: field(r, "src") })
        .collect()
}

/// Every record whose `src` names a file that does NOT exist under `root` (#4223).
///
/// This is the gate's blind spot made visible. `backing_for` matches a path against each record's `src`;
/// if that `src` is stale, the record backs a file the lookup can never find, and the gate answers
/// "not component-backed" — a green light to edit the artifact directly, which is the exact outcome the
/// gate exists to prevent. A false NEGATIVE here is far worse than a false positive.
///
/// Only meaningful when `root` is the repo the records describe; a caller running elsewhere would see
/// every record as unresolvable, which is why the audit states its root and the gate only WARNS on it.
pub fn unresolvable_src(records: &[Value], root: &std::path::Path) -> Vec<Backing> {
    let field = |v: &Value, k: &str| {
        v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).unwrap_or("").to_string()
    };
    records
        .iter()
        .filter_map(|r| {
            let src = field(r, "src");
            if src.is_empty() || root.join(&src).exists() {
                return None;
            }
            Some(Backing { id: field(r, "id"), kit_id: field(r, "kitId"), src })
        })
        .collect()
}

/// The caveat a `gate` run prints when part of the store cannot be checked.
///
/// A lookup that cannot see some records must not answer with confidence. Stated as a caveat rather than
/// a failure because the gate's own verdict on the paths it CAN resolve is still correct and still worth
/// enforcing — the unresolvable set is a separate problem, and blocking every commit on it would be
/// punishing the wrong person.
pub fn blind_spot_caveat(unresolvable: usize) -> String {
    format!(
        "note: {unresolvable} record(s) name a `src` that does not exist here, so this check cannot see          the files they back — a \"not backed\" answer is not conclusive for those.          List them with `bsc ui backing audit` (#4223)."
    )
}

/// What a relink would do to one record (#4223) — the component twin of `bsc graph relink`'s outcomes.
///
/// The difference that matters: `graph relink` RECOVERS a missing `src` (its `AlreadyLinked` arm skips
/// anything that has one). These records all HAVE an `src`; it is simply wrong. Overwriting a value is a
/// different risk from filling a blank, so the safety rule is inverted — a record whose `src` RESOLVES is
/// never touched, no matter what a harvest suggests. The harvest is evidence, not authority.
#[derive(Debug, PartialEq, Eq)]
pub enum RelinkOutcome {
    /// `src` does not resolve and exactly one harvested component of that name does — re-point it.
    Relink { id: String, from: String, to: String },
    /// `src` does not resolve and SEVERAL harvested files carry that name. Never guessed: picking one
    /// would silently bind the record to whichever the walk happened to reach first.
    Ambiguous { id: String, from: String, candidates: Vec<String> },
    /// `src` does not resolve and nothing harvested matches — the component may be gone, renamed beyond
    /// recognition, or outside the scanned dir. Reported so it is a decision rather than a silence.
    Unmatched { id: String, from: String },
    /// `src` resolves. Left alone — a resolving pointer is the one thing this must never overwrite.
    Resolves { id: String },
}

/// Plan the re-pointing of stale `src` values by matching records to a fresh harvest (#4223). Pure —
/// APPLYING it (writing the store) is the caller's job, so a dry run and a real run share one planner.
///
/// `by_name` maps a component NAME to the distinct paths harvested under it. Name, not id, because the
/// component graph composes by name and a record's `name` is the stable thing across a file rename —
/// which is the exact event that produced these stale pointers.
pub fn relink_plan(records: &[Value], by_name: &BTreeMap<String, BTreeSet<String>>, root: &std::path::Path) -> Vec<RelinkOutcome> {
    let field = |v: &Value, k: &str| {
        v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).unwrap_or("").to_string()
    };
    let mut out = Vec::new();
    for r in records {
        let id = field(r, "id");
        if id.is_empty() {
            continue;
        }
        let from = field(r, "src");
        // A record with no `src` at all is not this verb's business — `backing`/`audit` report it, and
        // inventing provenance for it is the harvest-promotion decision, not a repair.
        if from.is_empty() {
            continue;
        }
        if root.join(&from).exists() {
            out.push(RelinkOutcome::Resolves { id });
            continue;
        }
        let name = field(r, "name");
        match by_name.get(&name).map(|s| s.iter().cloned().collect::<Vec<_>>()) {
            Some(paths) if paths.len() == 1 => {
                let to = paths[0].clone();
                // A harvest that proposes the SAME broken path tells us nothing — treat it as unmatched
                // rather than reporting a no-op "relink" that would read as a fix.
                //
                // And the guard that makes this verb safe BY CONSTRUCTION: a proposed `to` must itself
                // RESOLVE. The whole defect being repaired is a pointer that names no file, so swapping
                // in a second unresolvable path would be the same bug wearing a fix's clothes. It caught
                // a real one: the harvest reports paths relative to the SCANNED DIR, so a scan of `src`
                // yields `features/x/Y.tsx` where records use `src/features/x/Y.tsx`.
                if to == from || !root.join(&to).exists() {
                    out.push(RelinkOutcome::Unmatched { id, from });
                } else {
                    out.push(RelinkOutcome::Relink { id, from, to });
                }
            }
            Some(paths) => out.push(RelinkOutcome::Ambiguous { id, from, candidates: paths }),
            None => out.push(RelinkOutcome::Unmatched { id, from }),
        }
    }
    out
}

/// The rejection a worker sees when it edited a record-backed file (#4193).
///
/// It names the file, the record, and BOTH commands — because the failure mode this gate exists for is
/// not "the worker disagreed", it is "the worker did not know a record existed". A message that only says
/// no teaches nothing and gets routed around.
pub fn rejection(path: &str, b: &Backing) -> String {
    format!(
        "blocked: `{}` is the emitted artifact of component `{}` (kit `{}`), so editing the file loses the \
         change — the record is the source of truth and the file is regenerated from it (#4193).\n\
         Edit the record, then re-emit:\n\
         \x20 bsc ui get {id}                    # read it first\n\
         \x20 bsc ui set …                       # the authoritative change\n\
         \x20 bsc ui emit component {id} <dir>   # the file follows",
        normalize(path),
        b.id,
        b.kit_id,
        id = b.id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recs() -> Vec<Value> {
        vec![
            json!({ "id": "skillspage", "kitId": "base-studio-code", "src": "src/features/skills/SkillsWorkspace.tsx" }),
            json!({ "id": "button", "kitId": "react-ui", "src": "src/shared/ui/controls/Button.tsx" }),
            // A record with no provenance backs nothing — it must never make a path look gated.
            json!({ "id": "floating", "kitId": "harvested" }),
        ]
    }

    #[test]
    fn a_worktree_or_absolute_path_still_resolves_to_its_record() {
        // A worker's path is rarely the record's exact string: it is absolute, or worktree-relative.
        for p in [
            "src/features/skills/SkillsWorkspace.tsx",
            "./src/features/skills/SkillsWorkspace.tsx",
            "C:/Users/k/worktrees/proj/src/features/skills/SkillsWorkspace.tsx",
            r"C:\Users\k\worktrees\proj\src\features\skills\SkillsWorkspace.tsx",
        ] {
            let got = backing_for(&recs(), p);
            assert_eq!(got.len(), 1, "expected a match for {p}: {got:?}");
            assert_eq!(got[0].id, "skillspage");
        }
    }

    #[test]
    fn an_unrecorded_file_is_not_backed() {
        assert!(backing_for(&recs(), "src/features/skills/lessons.ts").is_empty());
        assert!(backing_for(&recs(), "README.md").is_empty());
    }

    /// A bare filename would collide across the tree — gating on it turns the gate into noise, which is
    /// how a rejecting gate gets routed around.
    #[test]
    fn a_bare_filename_never_matches() {
        assert!(backing_for(&recs(), "Button.tsx").is_empty());
        assert!(!same_file("Button.tsx", "src/shared/ui/controls/Button.tsx"));
        // …and a record whose own provenance is a bare filename cannot back anything either.
        assert!(!same_file("src/shared/ui/controls/Button.tsx", "Button.tsx"));
    }

    /// A partial segment must not match: `…/MyButton.tsx` is not `…/Button.tsx`.
    #[test]
    fn the_suffix_match_respects_path_boundaries() {
        assert!(!same_file("src/shared/ui/controls/MyButton.tsx", "src/shared/ui/controls/Button.tsx"));
        assert!(!same_file("other/controls/Button.tsx", "src/shared/ui/controls/Button.tsx"));
        assert!(same_file("wt/src/shared/ui/controls/Button.tsx", "src/shared/ui/controls/Button.tsx"));
    }

    #[test]
    fn two_records_claiming_one_file_are_both_reported() {
        let mut rs = recs();
        rs.push(json!({ "id": "skillspage-dupe", "kitId": "harvested", "src": "src/features/skills/SkillsWorkspace.tsx" }));
        let got = backing_for(&rs, "src/features/skills/SkillsWorkspace.tsx");
        assert_eq!(got.len(), 2, "both are surfaced rather than one silently winning: {got:?}");
    }

    #[test]
    fn the_rejection_names_the_record_and_both_fix_commands() {
        let b = &backing_for(&recs(), "src/shared/ui/controls/Button.tsx")[0];
        let msg = rejection("src/shared/ui/controls/Button.tsx", b);
        assert!(msg.contains("component `button`"), "{msg}");
        assert!(msg.contains("kit `react-ui`"), "{msg}");
        assert!(msg.contains("bsc ui set"), "the authoritative change: {msg}");
        assert!(msg.contains("bsc ui emit component button"), "the re-emit: {msg}");
        // It explains WHY, because the worker's failure was not knowing a record existed.
        assert!(msg.contains("source of truth"), "{msg}");
    }

    #[test]
    fn unresolvable_src_finds_the_records_the_gate_cannot_see() {
        // #4223: the gate answers from `src`. A record whose `src` names a missing file backs a path the
        // lookup can never match, so the gate says "not backed" — a green light to edit the artifact.
        let dir = std::env::temp_dir().join(format!("bsc-backing-{}", std::process::id()));
        let real = dir.join("src/features/automations");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("History.tsx"), "export const X = 1;
").unwrap();

        let recs = vec![
            // Stale: the file was renamed to History.tsx and the record never re-pointed.
            json!({ "id": "automations-history", "kitId": "bsc", "src": "src/features/automations/AutomationsHistory.tsx" }),
            // Fine: resolves.
            json!({ "id": "ok", "kitId": "bsc", "src": "src/features/automations/History.tsx" }),
            // No provenance at all — not this check's business.
            json!({ "id": "floating", "kitId": "bsc" }),
        ];
        let bad = unresolvable_src(&recs, &dir);
        assert_eq!(bad.len(), 1, "only the stale pointer: {bad:?}");
        assert_eq!(bad[0].id, "automations-history");

        // The consequence, pinned: the gate is blind for exactly that file.
        assert!(backing_for(&recs, "src/features/automations/History.tsx").iter().any(|b| b.id == "ok"));
        // …and nothing claims the path the stale record MEANT to name.
        assert!(backing_for(&recs, "src/features/automations/AutomationsHistory.tsx")
            .iter()
            .all(|b| b.id == "automations-history"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_caveat_states_the_uncertainty_rather_than_failing_the_run() {
        let msg = blind_spot_caveat(54);
        assert!(msg.contains("54 record"), "{msg}");
        assert!(msg.contains("not conclusive"), "says the answer cannot be trusted for those: {msg}");
        assert!(msg.contains("bsc ui backing audit"), "names how to see them: {msg}");
    }

    fn names(pairs: &[(&str, &[&str])]) -> BTreeMap<String, BTreeSet<String>> {
        pairs.iter().map(|(n, ps)| ((*n).to_string(), ps.iter().map(|p| (*p).to_string()).collect())).collect()
    }

    /// The safety rule that separates this from `bsc graph relink`: those records have NO `src` and the
    /// harvest fills it; these have a WRONG one. A resolving pointer is never overwritten, however
    /// confident the harvest is — the harvest is evidence, not authority.
    #[test]
    fn a_resolving_src_is_never_overwritten_even_when_the_harvest_disagrees() {
        let dir = std::env::temp_dir().join(format!("bsc-relink-a-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src/x")).unwrap();
        std::fs::write(dir.join("src/x/Good.tsx"), "x").unwrap();

        let recs = vec![json!({ "id": "good", "name": "Good", "src": "src/x/Good.tsx" })];
        // The harvest found the same component somewhere else entirely.
        let plan = relink_plan(&recs, &names(&[("Good", &["src/elsewhere/Good.tsx"])]), &dir);
        assert_eq!(plan, vec![RelinkOutcome::Resolves { id: "good".into() }]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_src_with_one_harvested_match_is_repointed() {
        let dir = std::env::temp_dir().join(format!("bsc-relink-b-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The real-world case: the file was renamed and the record kept the old path.
        std::fs::create_dir_all(dir.join("src/features/automations")).unwrap();
        std::fs::write(dir.join("src/features/automations/History.tsx"), "x").unwrap();
        let recs = vec![json!({
            "id": "automations-history",
            "name": "AutomationsHistory",
            "src": "src/features/automations/AutomationsHistory.tsx",
        })];
        let plan = relink_plan(
            &recs,
            &names(&[("AutomationsHistory", &["src/features/automations/History.tsx"])]),
            &dir,
        );
        assert_eq!(
            plan,
            vec![RelinkOutcome::Relink {
                id: "automations-history".into(),
                from: "src/features/automations/AutomationsHistory.tsx".into(),
                to: "src/features/automations/History.tsx".into(),
            }],
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The guard that makes the verb safe by construction — and it is not hypothetical. The first live
    /// dry run proposed 32 re-points whose targets were harvest-relative (`features/x/Y.tsx`) against
    /// records holding repo-root paths (`src/features/x/Y.tsx`): every one would have swapped an
    /// unresolvable pointer for a *different* unresolvable pointer, and read as 32 repairs.
    #[test]
    fn a_proposal_that_does_not_resolve_is_not_a_repair() {
        let dir = std::env::temp_dir().join(format!("bsc-relink-f-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let recs = vec![json!({
            "id": "automations-history",
            "name": "AutomationsHistory",
            "src": "src/features/automations/AutomationsHistory.tsx",
        })];
        // Harvest-relative, so it names no file from the root — the shape of the real near-miss.
        let plan = relink_plan(
            &recs,
            &names(&[("AutomationsHistory", &["features/automations/History.tsx"])]),
            &dir,
        );
        assert_eq!(
            plan,
            vec![RelinkOutcome::Unmatched {
                id: "automations-history".into(),
                from: "src/features/automations/AutomationsHistory.tsx".into(),
            }],
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn several_matches_are_reported_not_picked() {
        // Picking one would silently bind the record to whichever the walk reached first — the failure
        // mode `graph relink` also refuses, for the same reason.
        let dir = std::env::temp_dir().join(format!("bsc-relink-c-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let recs = vec![json!({ "id": "card", "name": "Card", "src": "src/gone/Card.tsx" })];
        let plan = relink_plan(&recs, &names(&[("Card", &["src/a/Card.tsx", "src/b/Card.tsx"])]), &dir);
        match &plan[0] {
            RelinkOutcome::Ambiguous { id, candidates, .. } => {
                assert_eq!(id, "card");
                assert_eq!(candidates.len(), 2, "both are offered: {candidates:?}");
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_harvested_is_unmatched_and_a_same_path_suggestion_is_not_a_fix() {
        let dir = std::env::temp_dir().join(format!("bsc-relink-d-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let recs = vec![
            json!({ "id": "ghost", "name": "Ghost", "src": "src/gone/Ghost.tsx" }),
            // The harvest proposes the SAME broken path — reporting that as a relink would read as a fix.
            json!({ "id": "same", "name": "Same", "src": "src/gone/Same.tsx" }),
        ];
        let plan = relink_plan(&recs, &names(&[("Same", &["src/gone/Same.tsx"])]), &dir);
        assert!(matches!(&plan[0], RelinkOutcome::Unmatched { id, .. } if id == "ghost"));
        assert!(matches!(&plan[1], RelinkOutcome::Unmatched { id, .. } if id == "same"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_with_no_src_is_left_to_the_audit() {
        // Inventing provenance for a record that never had any is a promotion decision, not a repair.
        let dir = std::env::temp_dir().join(format!("bsc-relink-e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let recs = vec![json!({ "id": "floating", "name": "Floating" })];
        assert!(relink_plan(&recs, &names(&[("Floating", &["src/x/Floating.tsx"])]), &dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
