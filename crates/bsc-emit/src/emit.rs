//! Reconcile the emitted tree to the plan: prune what is no longer intended, write only what differs.

use crate::plan::{plan_records, Plan};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// What a reconcile actually DID — the number that says whether an emit was a no-op.
///
/// A run reporting `0 written` against a non-zero `materialized` count is the healthy steady state,
/// not a failure: the tree already agreed with the seeds.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EmitReport {
    pub materialized: Vec<String>,
    pub tests: Vec<String>,
    pub edges: Vec<String>,
    pub shadowed: Vec<String>,
    pub unresolvable: Vec<String>,
    pub edge_shadowed: Vec<String>,
    pub edge_unresolvable: Vec<String>,
    pub written: usize,
    pub pruned: usize,
    pub intended: usize,
}

/// Write `content` at `path` only when the bytes already there differ. Returns whether it wrote.
///
/// THE POINT IS THE MTIME, NOT THE I/O. `.bsc-records/` sits inside the dev server's watched root, so
/// a blind rewrite of all ~1,350 files is a change storm at whatever vite has the tree open — which
/// is exactly what made a mid-session re-emit look unaffordable and left the self-heal gated behind a
/// resolve MISS, blind to an EDIT of a record already in the tree. Writing only what changed makes an
/// emit that changed one record touch one file, so HMR updates that module and nothing else.
///
/// Compares CONTENT, never mtimes. The seed is the source of truth and the emitted copy is derived,
/// so "same bytes" is the whole question; an mtime comparison would rewrite on every `git checkout`
/// that touched a seed without changing it.
pub fn write_if_changed(path: &Path, content: &str) -> std::io::Result<bool> {
    if std::fs::read_to_string(path).is_ok_and(|existing| existing == content) {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(true)
}

/// Every file under `dir` that `intended` does not name.
///
/// This is what deleting the whole tree was really for: a module that came BACK to `src/` leaves an
/// emitted copy which shadows nothing (src wins) but is dead weight the next reader has to explain,
/// and a retired module's carried test would keep RUNNING. Returned rather than deleted so the
/// decision can be tested without a filesystem to destroy.
pub fn stale_emitted(dir: &Path, intended: &BTreeMap<PathBuf, String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(p),
                Ok(_) if !intended.contains_key(&p) => out.push(p),
                _ => {}
            }
        }
    }
    out.sort();
    out
}

/// Remove directories left empty by a prune, depth first. Returns whether `dir` itself ended up
/// empty — `dir` is never removed, so calling it on the tree root cannot delete the root.
pub fn prune_empty_dirs(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    let mut remaining = 0usize;
    for e in entries.flatten() {
        let p = e.path();
        if e.file_type().is_ok_and(|t| t.is_dir()) && prune_empty_dirs(&p) {
            if std::fs::remove_dir_all(&p).is_err() {
                remaining += 1;
            }
        } else {
            remaining += 1;
        }
    }
    remaining == 0
}

/// The files the plan intends, keyed by absolute path.
///
/// PLAN THE WHOLE TREE FIRST, then reconcile the disk to it. This used to delete the tree and rewrite
/// every file, which is a change storm at any dev server watching `.bsc-records/` — and that cost is
/// why the mid-session re-emit was gated behind a resolve MISS, and so could never see an EDIT to a
/// record already in the tree.
fn intended_files(out_dir: &Path, plan: &Plan) -> BTreeMap<PathBuf, String> {
    let mut files = BTreeMap::new();

    for m in &plan.modules {
        let path = suffixed(&out_dir.join(&m.rel), crate::plan::ext_for(&m.code));
        files.insert(
            path,
            format!(
                "// GENERATED from the packaged seed for `{}` — do not edit, and do not commit.\n\
                 // The record is the source of truth; this file is a derived cache so tsc/vite/vitest can resolve\n\
                 // `{}` after the original module was retired. Regenerate with `npm run emit:records`.\n{}",
                m.id, m.spec, m.code
            ),
        );
    }

    // The records' TESTS, beside the module each one tests. This is what keeps a retired module's
    // coverage inside the default gate: `npm test` emits and THEN runs vitest, and `vitest.config.ts`
    // includes `.bsc-records/**`, so a carried test executes against the record that actually ships.
    // Without it, deleting a colocated test trades executed coverage for stored coverage behind a
    // green gate — exactly what cost 31 assertions before `retiredTests.test.ts` existed.
    for t in &plan.tests {
        files.insert(
            out_dir.join(&t.rel),
            format!(
                "// GENERATED from the packaged seed's carried test for `{}` — do not edit, do not commit.\n\
                 // It runs in the default gate against the emitted record, not against a file under `src/`.\n{}",
                t.spec, t.src
            ),
        );
    }

    // The EDGE tests, at the mirror of the file each was lifted from. Same writer as the node tests,
    // and deliberately so: an edge test that ran differently from a record test would be a second
    // execution model to keep in agreement with the first.
    for t in &plan.edge_tests {
        let count = if t.members.is_empty() { "several".to_string() } else { t.members.len().to_string() };
        let named = if t.members.is_empty() { String::new() } else { format!(" ({})", t.members.join(" × ")) };
        files.insert(
            out_dir.join(&t.rel),
            format!(
                "// GENERATED from the packaged seed's EDGE test `{}` — do not edit, do not commit.\n\
                 // It verifies the RELATIONSHIP between {} records{}, which is why it lives on the edge\n\
                 // rather than being forced onto one node that does not own it.\n{}",
                t.id, count, named, t.src
            ),
        );
    }

    // The tree ignores itself, wherever it is checked out.
    files.insert(out_dir.join(".gitignore"), "*\n".to_string());
    files
}

fn suffixed(base: &Path, suffix: &str) -> PathBuf {
    let mut s = base.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// Reconcile `<repo>/.bsc-records` to what the seeds say.
pub fn emit_records(repo: &Path) -> std::io::Result<EmitReport> {
    let out_dir = repo.join(".bsc-records");
    let plan = plan_records(repo);
    let files = intended_files(&out_dir, &plan);

    std::fs::create_dir_all(&out_dir)?;
    // Prune FIRST so a rename frees its old path, then write only the bytes that differ, then drop
    // the directories the prune emptied.
    let pruned = stale_emitted(&out_dir, &files);
    for p in &pruned {
        let _ = std::fs::remove_file(p);
    }
    let mut written = 0usize;
    for (path, content) in &files {
        if write_if_changed(path, content)? {
            written += 1;
        }
    }
    prune_empty_dirs(&out_dir);

    Ok(EmitReport {
        materialized: plan.modules.iter().map(|m| m.spec.clone()).collect(),
        tests: plan.tests.iter().map(|t| t.detail.clone()).collect(),
        edges: plan.edge_tests.iter().map(|t| t.detail.clone()).collect(),
        shadowed: plan.shadowed.clone(),
        unresolvable: plan.unresolvable.iter().map(|u| u.detail.clone()).collect(),
        edge_shadowed: plan.edge_shadowed.clone(),
        edge_unresolvable: plan.edge_unresolvable.iter().map(|(_, d)| d.clone()).collect(),
        written,
        pruned: pruned.len(),
        intended: files.len(),
    })
}

/// The human report, NEVER silent in either direction.
///
/// "This module has no test", "its test is shadowed by a file" and "its test is mispaired and cannot
/// run" are three different states that look identical from outside. The edge tier reports in the
/// SAME three states and reports 0 rather than staying silent: an unpopulated tier and a broken one
/// look identical from outside, and this one shipped unpopulated.
pub fn render(r: &EmitReport) -> String {
    let mut s = String::new();
    let section = |s: &mut String, head: String, rows: &[String]| {
        s.push_str(&head);
        s.push('\n');
        let mut sorted = rows.to_vec();
        sorted.sort();
        for row in sorted {
            s.push_str("   ");
            s.push_str(&row);
            s.push('\n');
        }
    };
    section(
        &mut s,
        format!("emit-records: {} retired specifier(s) materialized from seeds", r.materialized.len()),
        &r.materialized,
    );
    section(&mut s, format!("emit-records: {} carried test file(s) materialized", r.tests.len()), &r.tests);
    if !r.shadowed.is_empty() {
        section(
            &mut s,
            format!(
                "emit-records: {} record(s) carry tests that a colocated src/ file still shadows",
                r.shadowed.len()
            ),
            &r.shadowed,
        );
    }
    if !r.unresolvable.is_empty() {
        section(
            &mut s,
            format!("emit-records: {} carried test(s) NOT emitted — unresolvable", r.unresolvable.len()),
            &r.unresolvable,
        );
    }
    section(&mut s, format!("emit-records: {} EDGE test file(s) materialized", r.edges.len()), &r.edges);
    if !r.edge_shadowed.is_empty() {
        section(
            &mut s,
            format!("emit-records: {} edge(s) carry tests a src/ file still shadows", r.edge_shadowed.len()),
            &r.edge_shadowed,
        );
    }
    if !r.edge_unresolvable.is_empty() {
        section(
            &mut s,
            format!("emit-records: {} edge test(s) NOT emitted — unresolvable", r.edge_unresolvable.len()),
            &r.edge_unresolvable,
        );
    }
    s.push_str(&format!(
        "emit-records: {} file(s) written, {} pruned ({} intended)\n",
        r.written, r.pruned, r.intended
    ));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "bsc-emit-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("scratch");
        d
    }

    // ── carried from scripts/emit-reconcile.test.ts, assertion for assertion ─────────────────────

    #[test]
    fn write_if_changed_writes_a_file_that_is_absent() {
        let d = scratch("wic-absent");
        let p = d.join("a.ts");
        assert!(write_if_changed(&p, "hello\n").unwrap());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hello\n");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn write_if_changed_declines_identical_bytes() {
        // THE POINT IS THE MTIME: a no-op emit must touch zero files, or HMR sees a change storm.
        let d = scratch("wic-same");
        let p = d.join("a.ts");
        write_if_changed(&p, "same\n").unwrap();
        assert!(!write_if_changed(&p, "same\n").unwrap());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn write_if_changed_rewrites_when_the_bytes_differ() {
        let d = scratch("wic-diff");
        let p = d.join("a.ts");
        write_if_changed(&p, "before\n").unwrap();
        assert!(write_if_changed(&p, "after\n").unwrap());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "after\n");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn write_if_changed_creates_missing_parent_directories() {
        let d = scratch("wic-mkdir");
        let p = d.join("deep").join("nest").join("a.ts");
        assert!(write_if_changed(&p, "body\n").unwrap());
        assert!(!write_if_changed(&p, "body\n").unwrap());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn write_if_changed_compares_content_not_mtime() {
        // A `git checkout` that touches a seed WITHOUT changing it must not churn the tree — an mtime
        // comparison would rewrite everything and hand a running dev server a change storm.
        let d = scratch("wic-mtime");
        let p = d.join("a.ts");
        write_if_changed(&p, "body\n").unwrap();
        let before = std::fs::metadata(&p).unwrap().modified().unwrap();
        // Push the mtime backwards so "older than expected" cannot be what is being tested.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(86_400);
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_modified(old).unwrap();
        drop(f);
        assert!(!write_if_changed(&p, "body\n").unwrap(), "identical bytes must not be rewritten");
        assert_ne!(
            std::fs::metadata(&p).unwrap().modified().unwrap(),
            before,
            "precondition: the mtime really did move, so the decline was about CONTENT"
        );
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_re_emit_with_no_seed_change_writes_zero_files_and_prunes_zero() {
        // THE HMR CONTRACT. `.bsc-records/` sits inside the dev server's watched root, so a no-op emit
        // that rewrote every file would be a change storm — which is exactly why the mid-session
        // re-emit used to be gated behind a resolve MISS and could never see an EDIT.
        let d = scratch("reemit");
        let seed_dir = d.join("src-tauri").join("data").join("components").join("app");
        std::fs::create_dir_all(&seed_dir).unwrap();
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(
            seed_dir.join("gone.json"),
            r#"{"id":"gone","provides":"@/gone/Thing","srcText":"export const thing = 1;\n","tests":[]}"#,
        )
        .unwrap();

        let first = emit_records(&d).unwrap();
        assert_eq!(first.materialized, vec!["@/gone/Thing"], "the seed materialized");
        assert!(first.written > 0, "the first emit must actually write");

        let second = emit_records(&d).unwrap();
        assert_eq!(second.written, 0, "a re-emit with no seed change writes nothing");
        assert_eq!(second.pruned, 0, "and prunes nothing");
        assert_eq!(second.intended, first.intended, "while still intending the same tree");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_file_that_came_back_to_src_is_pruned_from_the_emitted_tree() {
        // The other half of what deleting the whole tree used to do: a module that returned to `src/`
        // leaves an emitted copy that shadows nothing, and its carried test would keep RUNNING.
        let d = scratch("prune-return");
        let seed_dir = d.join("src-tauri").join("data").join("components").join("app");
        std::fs::create_dir_all(&seed_dir).unwrap();
        std::fs::create_dir_all(d.join("src").join("gone")).unwrap();
        std::fs::write(
            seed_dir.join("gone.json"),
            r#"{"id":"gone","provides":"@/gone/Thing","srcText":"export const thing = 1;\n","tests":[]}"#,
        )
        .unwrap();
        emit_records(&d).unwrap();
        assert!(d.join(".bsc-records").join("gone").join("Thing.ts").exists());

        // The file comes back — `src` wins, so the record must NOT be emitted any more.
        std::fs::write(d.join("src").join("gone").join("Thing.ts"), "export const thing = 2;\n").unwrap();
        let after = emit_records(&d).unwrap();
        assert!(after.materialized.is_empty(), "src/ wins, so nothing is materialized");
        assert_eq!(after.pruned, 1, "the stale emitted copy is pruned");
        assert!(!d.join(".bsc-records").join("gone").join("Thing.ts").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn stale_emitted_names_a_file_the_plan_no_longer_intends() {
        let d = scratch("stale-names");
        let keep = d.join("keep.ts");
        let gone = d.join("gone.ts");
        std::fs::write(&keep, "1").unwrap();
        std::fs::write(&gone, "1").unwrap();
        let intended = BTreeMap::from([(keep.clone(), "1".to_string())]);
        assert_eq!(stale_emitted(&d, &intended), vec![gone]);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn stale_emitted_names_nothing_when_the_tree_matches_the_plan() {
        let d = scratch("stale-match");
        let p = d.join("a.ts");
        std::fs::write(&p, "1").unwrap();
        assert!(stale_emitted(&d, &BTreeMap::from([(p, "1".to_string())])).is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn stale_emitted_on_an_absent_tree_is_empty_rather_than_an_error() {
        let d = scratch("stale-absent");
        assert!(stale_emitted(&d.join("nope"), &BTreeMap::new()).is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn stale_emitted_recurses_into_subdirectories() {
        let d = scratch("stale-deep");
        let nested = d.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        let gone = nested.join("x.ts");
        std::fs::write(&gone, "1").unwrap();
        assert_eq!(stale_emitted(&d, &BTreeMap::new()), vec![gone]);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn prune_empty_dirs_removes_what_a_prune_emptied_but_never_the_root() {
        let d = scratch("prune-empty");
        std::fs::create_dir_all(d.join("a").join("b")).unwrap();
        std::fs::create_dir_all(d.join("keep")).unwrap();
        std::fs::write(d.join("keep").join("x.ts"), "1").unwrap();
        prune_empty_dirs(&d);
        assert!(!d.join("a").exists(), "an emptied branch should be gone");
        assert!(d.join("keep").join("x.ts").exists(), "a populated branch survives");
        assert!(d.exists(), "the root is NEVER removed");
        std::fs::remove_dir_all(&d).ok();
    }
}
