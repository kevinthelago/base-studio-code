//! `bsc ui tests harvest` (#3907) — carry each component's COLOCATED test file onto its node.
//!
//! #3878 made `tests` a per-node data contract and #3884 gave it a surface, but nothing populated it: a
//! component's tests lived only in a parallel file tree beside a source the graph no longer owns. This
//! pairs each record with `<src-without-ext>.test.tsx` (or `.test.ts`) and emits the record with `tests`
//! filled, so the existing audited `bsc ui set` applies it.
//!
//! **MIRROR, not source.** The files stay authoritative and checked in. The graph cannot execute a test
//! today, so making it the source would stake the whole suite on a materializer that does not exist. This
//! buys doctor honesty, real Tests-tab content, and a queryable graph at zero risk.
//!
//! **One entry per FILE, verbatim.** A test file's meaning lives partly OUTSIDE its `it()` blocks —
//! imports, `beforeEach`, local helpers, `vi.mock` calls. Splitting into per-`it` entries would silently
//! drop that, which is exactly the fidelity loss #3892/#3895 were about. So `src` is the file byte-for-byte
//! and `name` is its top-level `describe` title (else the file's basename). Per-`it` granularity stays
//! derivable from the stored source later, if it ever earns its keep.
use std::path::{Path, PathBuf};

/// One harvested test file, in the `ComponentTest` shape the record carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarvestedTest {
    pub name: String,
    pub src: String,
}

/// The colocated test path for a `src/`-relative module path, if one exists under `root`.
///
/// Delegates to [`bsc_util::test_path_for`] (#4126). The pairing moved to the shared crate when the
/// ALGORITHMS library needed the identical derivation — the same reason `folder_from_src` lives there:
/// two libraries deriving the same thing from the same input must not drift apart.
pub fn test_path_for(root: &Path, src: &str) -> Option<PathBuf> {
    bsc_util::test_path_for(root, src)
}

/// The test file's display name: its FIRST top-level `describe("…")` title, else the file's basename.
/// Delegates to [`bsc_util::test_display_name`] (#4126).
pub fn display_name(path: &Path, contents: &str) -> String {
    bsc_util::test_display_name(path, contents)
}

/// Harvest the colocated test for one record `src`, reading from `root`. `None` when there is no test.
pub fn harvest_for(root: &Path, src: &str) -> Option<HarvestedTest> {
    let path = test_path_for(root, src)?;
    let contents = std::fs::read_to_string(&path).ok()?;
    Some(HarvestedTest { name: display_name(&path, &contents), src: contents })
}


/// `bsc ui tests harvest [<root>] [--kit K] [--pretty]` — emit each record that HAS a colocated test,
/// with `tests` populated, so the existing audited `bsc ui set` applies it:
///
/// ```text
/// bsc ui tests harvest --kit base-studio-code | bsc ui set --by tests-harvest
/// ```
///
/// READ-ONLY. A record with no colocated test is omitted entirely — never emitted with an empty `tests`,
/// which would read as "declared none" rather than "not yet harvested".
pub fn run(args: &[String], prog: &str) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("help") || args.is_empty() {
        println!("{}", HELP.replace("{prog}", prog));
        return Ok(());
    }
    match args.first().map(String::as_str) {
        Some("harvest") => cmd_harvest(&args[1..]),
        Some("adopt") => cmd_adopt(&args[1..]),
        Some(other) => {
            Err(format!("unknown tests command '{other}' — want: {prog} tests harvest | {prog} tests adopt"))
        }
        None => unreachable!("empty args handled above"),
    }
}

fn cmd_harvest(args: &[String]) -> Result<(), String> {
    let (mut root, mut kit, mut pretty) = (".".to_string(), None::<String>, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--kit" => kit = Some(it.next().cloned().ok_or("--kit needs a kit id")?),
            "--pretty" => pretty = true,
            "--json" => {}
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => root = other.to_string(),
        }
    }
    let root = std::path::Path::new(&root);
    if !root.is_dir() {
        return Err(format!("no such directory: {}", root.display()));
    }
    // A harvest hands back file CONTENTS, so it honours the SAME boundary the file tools do (#3475) —
    // `bsc-confine` is blind to what this binary reads.
    bsc_cli_util::require_harvestable_root(root)?;

    let store = bsc_json_store::Store::open_default("components", "component")?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    let (mut paired, mut skipped) = (0usize, 0usize);
    // `Store::list()` yields the verbatim record JSON, not ids.
    for raw in store.list() {
        let Ok(mut rec) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        if let Some(k) = &kit {
            if rec.get("kitId").and_then(serde_json::Value::as_str) != Some(k.as_str()) {
                continue;
            }
        }
        // A suppression tombstone (#3725) is not a component.
        if rec.get("suppressed").and_then(serde_json::Value::as_bool) == Some(true) {
            continue;
        }
        let src = rec.get("src").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
        match harvest_for(root, &src) {
            Some(t) => {
                rec["tests"] = serde_json::json!([{ "name": t.name, "src": t.src }]);
                out.push(rec);
                paired += 1;
            }
            None => skipped += 1,
        }
    }
    eprintln!("{paired} record(s) paired with a colocated test; {skipped} left untouched");
    let v = serde_json::Value::Array(out);
    let s = if pretty { serde_json::to_string_pretty(&v) } else { serde_json::to_string(&v) };
    println!("{}", s.map_err(|e| e.to_string())?);
    Ok(())
}

/// The per-component seed directory relative to a repo root — the ONE tree `emit-records` reads and
/// `bsc ui tests adopt` writes.
const SEED_SUBDIR: &str = "src-tauri/data/components/app";

/// `bsc ui tests adopt <id> --from <path> [<root>]` (#109) — write a component's carried test straight
/// onto its SEED record (`tests[0]`), from a file on disk. Read [`crate::seed_patch`] for the how and
/// why of the write; this function is just: find the seed file for `<id>` under
/// `<root>/src-tauri/data/components/app/**`, read `--from` verbatim, name the entry the same way
/// `harvest` does (its first `describe(...)` title, else the file's basename), and patch it in.
///
/// A ui-scope MUTATION (#2470) — refuses under a read-only `ui` scope before touching anything. The
/// `--from` read is confined the same way `harvest`'s directory read is (#3475): a restricted studio
/// session cannot launder an arbitrary path through this either.
fn cmd_adopt(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("help") {
        print!("{}", HELP.replace("{prog}", "bsc ui"));
        return Ok(());
    }
    let (mut id, mut from, mut root, mut pretty) = (None::<String>, None::<String>, ".".to_string(), false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--from" => from = Some(it.next().cloned().ok_or("--from needs a file path")?),
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other if id.is_none() => id = Some(other.to_string()),
            other => root = other.to_string(),
        }
    }
    let id = id.ok_or("usage: bsc ui tests adopt <id> --from <path> [<root>]")?;
    let from = from.ok_or("usage: bsc ui tests adopt <id> --from <path> [<root>]")?;

    bsc_cli_util::require_write_scope("ui")?;

    let from_path = Path::new(&from);
    bsc_cli_util::require_harvestable_root(from_path)?;
    let test_src = std::fs::read_to_string(from_path).map_err(|e| format!("cannot read {from}: {e}"))?;
    let name = display_name(from_path, &test_src);

    let seed_dir = Path::new(&root).join(SEED_SUBDIR);
    if !seed_dir.is_dir() {
        return Err(format!("no such directory: {} (is <root> the repo root?)", seed_dir.display()));
    }
    let seed_path = find_seed_file(&seed_dir, &id)?
        .ok_or_else(|| format!("no seed record with id '{id}' under {}", seed_dir.display()))?;
    let raw = std::fs::read_to_string(&seed_path)
        .map_err(|e| format!("cannot read {}: {e}", seed_path.display()))?;

    let new_tests = serde_json::json!([{ "name": name, "src": test_src }]);
    let (patched, changed) = crate::seed_patch::set_field(&raw, "tests", &new_tests)?;
    if changed {
        std::fs::write(&seed_path, &patched)
            .map_err(|e| format!("cannot write {}: {e}", seed_path.display()))?;
    }

    let summary = serde_json::json!({
        "id": id,
        "seed": seed_path.display().to_string(),
        "from": from,
        "name": name,
        "changed": changed,
    });
    let s =
        if pretty { serde_json::to_string_pretty(&summary) } else { serde_json::to_string(&summary) };
    println!("{}", s.map_err(|e| e.to_string())?);
    Ok(())
}

/// Find the seed JSON file under `dir` (recursively) whose `id` field equals `id`. `Err` on a
/// duplicate id (two seed files claiming the same record is corruption, not a normal "not found").
fn find_seed_file(dir: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    let mut found: Option<PathBuf> = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = std::fs::read_dir(&d).map_err(|e| format!("cannot read {}: {e}", d.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            // The packaged kit closure is a multi-megabyte array, not a per-record seed — skip it
            // the same way `emit-records.mjs`'s `collectSeeds` does.
            if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > 4_000_000 {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            let Ok(rec) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
            if rec.get("id").and_then(serde_json::Value::as_str) == Some(id) {
                if let Some(prior) = &found {
                    return Err(format!(
                        "record id '{id}' is claimed by two seed files: {} and {}",
                        prior.display(),
                        path.display()
                    ));
                }
                found = Some(path);
            }
        }
    }
    Ok(found)
}

const HELP: &str = "{prog} tests — the per-node TEST manifest (#3878/#3907/#109)

USAGE:
  {prog} tests harvest [<root>] [--kit K] [--pretty]
  {prog} tests adopt <id> --from <path> [<root>] [--pretty]

harvest pairs each component record with its COLOCATED test file (`<src-without-ext>.test.tsx`, else
`.test.ts`) under <root> (default `.`) and prints the records that HAVE one, with `tests` populated.
READ-ONLY — pipe into `set` to apply, which stamps rev/provenance as usual:

  {prog} tests harvest --kit base-studio-code | {prog} set --by tests-harvest

MIRROR, NOT SOURCE. The files stay authoritative and checked in; this copies them onto their node so the
graph is queryable and `bsc ui doctor`'s `no-tests` is honest. Nothing executes a graph-held test yet.

ONE ENTRY PER FILE, VERBATIM. A test file's meaning lives partly outside its `it()` blocks — imports,
`beforeEach`, local helpers, mocks — so splitting per-test would silently drop it. `src` is the file
byte-for-byte; `name` is its first `describe(...)` title, else the file's basename.

A record with no colocated test is OMITTED, never emitted with an empty `tests`: absent means \"not yet
harvested\", while `[]` would read as \"declared none\" and silence the doctor for the wrong reason.

adopt is the OTHER direction (#109): a record's `tests` field lives in the SEED
(`src-tauri/data/components/app/**/<id>.json`), not the runtime store `{prog} set` writes — the seed is
what SHIPS and what `emit-records` reads. So when a record's test has fallen out of sync with the file
that shadows it (the file is the copy that ran and got maintained; the record is a stale snapshot),
adopting the file's current content is a JSON-rewrite with no command behind it — this is that command.
Reads <path> verbatim (byte-for-byte, whatever line endings it already has), names the entry the same
way harvest does, writes it as the record's WHOLE `tests` array (replacing any prior entries, matching
the one-entry-per-record convention), and reports `changed: false` when the content already matched —
so re-running it is always safe. It edits ONLY the `tests` field: every other byte of the seed file,
including key order and indentation, is left exactly as it was (a full parse-and-reserialize would
reorder every key alphabetically and turn a one-field change into a whole-file diff). Deleting the
now-redundant src/ test file (so it stops shadowing the record) is a separate, ordinary `rm` — this
command only ever writes into the seed.
";

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixture root PER TEST — these run in parallel, and a single shared dir means one test's
    /// `remove_dir_all` wipes the fixture another is mid-way through reading.
    fn tmp(label: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-tests-harvest-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src/shared/ui/data")).unwrap();
        d
    }

    #[test]
    fn pairs_a_record_src_with_its_colocated_test_preferring_tsx() {
        let d = tmp("pairs");
        std::fs::write(d.join("src/shared/ui/data/Card.test.tsx"), "x").unwrap();
        assert_eq!(
            test_path_for(&d, "src/shared/ui/data/Card.tsx"),
            Some(d.join("src/shared/ui/data/Card.test.tsx"))
        );
        // A record with NO colocated test is left alone — never an empty manifest.
        assert_eq!(test_path_for(&d, "src/shared/ui/data/Chip.tsx"), None);
    }

    #[test]
    fn falls_back_to_a_dot_ts_test_for_a_dot_ts_module() {
        let d = tmp("ts");
        std::fs::write(d.join("src/shared/ui/data/model.test.ts"), "x").unwrap();
        assert_eq!(
            test_path_for(&d, "src/shared/ui/data/model.ts"),
            Some(d.join("src/shared/ui/data/model.test.ts"))
        );
    }

    #[test]
    fn a_directory_shaped_src_pairs_with_nothing() {
        // The #3892 defect: two harvested records carry a DIRECTORY as `src`. Not a module path, so it
        // has no colocated test and must not be guessed at.
        let d = tmp("dir");
        assert_eq!(test_path_for(&d, "src/shared/ui/layouts"), None);
        assert_eq!(test_path_for(&d, ""), None);
    }

    #[test]
    fn names_the_entry_after_its_describe_title_else_the_basename() {
        let p = Path::new("Card.test.tsx");
        assert_eq!(display_name(p, "describe(\"Card renders\", () => {});"), "Card renders");
        assert_eq!(display_name(p, "describe('single quoted', () => {});"), "single quoted");
        assert_eq!(display_name(p, "describe(`backticked`, () => {});"), "backticked");
        // An escaped quote inside the title does not truncate it.
        assert_eq!(display_name(p, r#"describe("a \"quoted\" bit", () => {});"#), "a \"quoted\" bit");
        // No describe at all ⇒ the basename, which is honest rather than invented.
        assert_eq!(display_name(p, "it(\"works\", () => {});"), "Card.test.tsx");
    }

    #[test]
    fn carries_the_file_verbatim_so_nothing_is_lost() {
        // The whole point of one-entry-per-file: imports, mocks and beforeEach live OUTSIDE the it()
        // blocks, and a per-test split would drop them silently.
        let d = tmp("verbatim");
        let body = "import { describe, it } from \"vitest\";\nvi.mock(\"@/store\");\nbeforeEach(reset);\ndescribe(\"X\", () => { it(\"a\", () => {}); });\n";
        std::fs::write(d.join("src/shared/ui/data/Card.test.tsx"), body).unwrap();
        let h = harvest_for(&d, "src/shared/ui/data/Card.tsx").unwrap();
        assert_eq!(h.src, body, "byte-identical to the file on disk");
        assert_eq!(h.name, "X");
    }

    /// A seed tree fixture for the `adopt` tests: `<root>/src-tauri/data/components/app/x/<id>.json`
    /// holding a record with the given `id` and an existing (stale) `tests` array, plus `<root>/<test_rel>`
    /// holding the fresh test file `adopt` should read from.
    fn seed_fixture(label: &str, id: &str, test_rel: &str, test_body: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-tests-adopt-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let seed_dir = d.join(SEED_SUBDIR).join("x");
        std::fs::create_dir_all(&seed_dir).unwrap();
        std::fs::write(
            seed_dir.join(format!("{id}.json")),
            format!(
                "{{\n  \"id\": \"{id}\",\n  \"name\": \"X\",\n  \"tests\": [\n    {{\n      \"name\": \"stale\",\n      \"src\": \"stale body\"\n    }}\n  ]\n}}\n"
            ),
        )
        .unwrap();
        let test_path = d.join(test_rel);
        std::fs::create_dir_all(test_path.parent().unwrap()).unwrap();
        std::fs::write(&test_path, test_body).unwrap();
        d
    }

    #[test]
    fn find_seed_file_locates_a_record_by_id_recursively() {
        let d = seed_fixture("find", "ui-card", "Card.test.tsx", "x");
        let seed_dir = d.join(SEED_SUBDIR);
        let found = find_seed_file(&seed_dir, "ui-card").unwrap();
        assert_eq!(found, Some(seed_dir.join("x").join("ui-card.json")));
        assert_eq!(find_seed_file(&seed_dir, "no-such-id").unwrap(), None);
    }

    #[test]
    fn find_seed_file_refuses_a_duplicate_id() {
        let d = seed_fixture("dup", "ui-dupe", "Dupe.test.tsx", "x");
        let seed_dir = d.join(SEED_SUBDIR);
        std::fs::write(
            seed_dir.join("y-dupe.json"),
            "{\n  \"id\": \"ui-dupe\",\n  \"name\": \"Y\"\n}\n",
        )
        .unwrap();
        std::fs::create_dir_all(seed_dir.join("y")).unwrap();
        std::fs::write(
            seed_dir.join("y").join("dupe.json"),
            "{\n  \"id\": \"ui-dupe\",\n  \"name\": \"Y\"\n}\n",
        )
        .unwrap();
        let err = find_seed_file(&seed_dir, "ui-dupe").unwrap_err();
        assert!(err.contains("claimed by two seed files"), "{err}");
    }

    #[test]
    fn adopt_writes_the_test_field_and_leaves_every_other_byte_untouched() {
        let d = seed_fixture("adopt", "ui-card", "Card.test.tsx", "describe(\"Card\", () => {});");
        let root = d.display().to_string();
        bsc_cli_util::with_repo_root(None, || {
            run(
                &[
                    "adopt".to_string(),
                    "ui-card".to_string(),
                    "--from".to_string(),
                    d.join("Card.test.tsx").display().to_string(),
                    root.clone(),
                ],
                "bsc ui",
            )
        })
        .unwrap();
        let seed_path = d.join(SEED_SUBDIR).join("x").join("ui-card.json");
        let patched = std::fs::read_to_string(&seed_path).unwrap();
        let rec: serde_json::Value = serde_json::from_str(&patched).unwrap();
        assert_eq!(rec["id"], "ui-card");
        assert_eq!(rec["name"], "X", "sibling field untouched");
        assert_eq!(rec["tests"][0]["name"], "Card");
        assert_eq!(rec["tests"][0]["src"], "describe(\"Card\", () => {});");
        // Rewriting with the SAME content a second time is a byte-for-byte no-op.
        let before = std::fs::read_to_string(&seed_path).unwrap();
        bsc_cli_util::with_repo_root(None, || {
            run(
                &[
                    "adopt".to_string(),
                    "ui-card".to_string(),
                    "--from".to_string(),
                    d.join("Card.test.tsx").display().to_string(),
                    root,
                ],
                "bsc ui",
            )
        })
        .unwrap();
        let after = std::fs::read_to_string(&seed_path).unwrap();
        assert_eq!(before, after, "re-adopting identical content is a no-op byte-for-byte");
    }

    #[test]
    fn adopt_refuses_under_a_read_only_ui_scope() {
        let d = seed_fixture("scope", "ui-card", "Card.test.tsx", "describe(\"Card\", () => {});");
        let root = d.display().to_string();
        let err = bsc_cli_util::with_scopes(Some(r#"{"ui":"read"}"#), || {
            bsc_cli_util::with_repo_root(None, || {
                run(
                    &[
                        "adopt".to_string(),
                        "ui-card".to_string(),
                        "--from".to_string(),
                        d.join("Card.test.tsx").display().to_string(),
                        root,
                    ],
                    "bsc ui",
                )
            })
        })
        .unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        // Untouched: the seed still carries the stale test.
        let seed_path = d.join(SEED_SUBDIR).join("x").join("ui-card.json");
        let rec: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        assert_eq!(rec["tests"][0]["name"], "stale");
    }

    #[test]
    fn adopt_reports_an_unknown_id() {
        let d = seed_fixture("unknown", "ui-card", "Card.test.tsx", "x");
        let root = d.display().to_string();
        let err = bsc_cli_util::with_repo_root(None, || {
            run(
                &[
                    "adopt".to_string(),
                    "no-such-id".to_string(),
                    "--from".to_string(),
                    d.join("Card.test.tsx").display().to_string(),
                    root,
                ],
                "bsc ui",
            )
        })
        .unwrap_err();
        assert!(err.contains("no seed record with id"), "{err}");
    }
}
