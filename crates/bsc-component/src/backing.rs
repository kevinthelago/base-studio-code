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
}
