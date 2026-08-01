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
    if args.first().map(String::as_str) != Some("harvest") {
        return Err(format!("unknown tests command '{}' — want: {prog} tests harvest", args[0]));
    }
    let (mut root, mut kit, mut pretty) = (".".to_string(), None::<String>, false);
    let mut it = args[1..].iter();
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

const HELP: &str = "{prog} tests — the per-node TEST manifest (#3878/#3907)

USAGE:
  {prog} tests harvest [<root>] [--kit K] [--pretty]

Pairs each component record with its COLOCATED test file (`<src-without-ext>.test.tsx`, else `.test.ts`)
under <root> (default `.`) and prints the records that HAVE one, with `tests` populated. READ-ONLY —
pipe into `set` to apply, which stamps rev/provenance as usual:

  {prog} tests harvest --kit base-studio-code | {prog} set --by tests-harvest

MIRROR, NOT SOURCE. The files stay authoritative and checked in; this copies them onto their node so the
graph is queryable and `bsc ui doctor`'s `no-tests` is honest. Nothing executes a graph-held test yet.

ONE ENTRY PER FILE, VERBATIM. A test file's meaning lives partly outside its `it()` blocks — imports,
`beforeEach`, local helpers, mocks — so splitting per-test would silently drop it. `src` is the file
byte-for-byte; `name` is its first `describe(...)` title, else the file's basename.

A record with no colocated test is OMITTED, never emitted with an empty `tests`: absent means \"not yet
harvested\", while `[]` would read as \"declared none\" and silence the doctor for the wrong reason.
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
}
