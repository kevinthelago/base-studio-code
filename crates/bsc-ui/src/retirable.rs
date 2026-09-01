//! WHICH FILES CAN BE RETIRED — the census behind `bsc ui retirable`.
//!
//! Derived from `scripts/retirement-candidates.mjs`, deleted with this verb.
//!
//! ## What is mechanical, and what is not
//!
//! A file is retirable when a packaged seed `provides` its specifier with real source, because
//! `emit-records.mjs` materializes that seed into `.bsc-records/` the moment the file is gone and all four
//! resolvers find it there. That much is mechanical.
//!
//! WHAT IS NOT is why this exists: the seed's `srcText` is a PROJECTION of the file taken at migration
//! time, and the two drift. Retiring a file whose seed has fallen behind does not "move" the module — it
//! REPLACES it with an older copy, silently, and the gate stays green because the older copy still
//! compiles. So every candidate is classified by whether its seed still agrees with the file.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// One retirable-or-not candidate.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub spec: String,
    pub file: String,
    pub id: String,
    pub kind: &'static str,
    pub importers: usize,
    pub relative: Vec<String>,
    /// `same` · `reformatted` · `BODY-DIFFERS` · `BREAKS`.
    pub verdict: &'static str,
    pub missing: Vec<String>,
    pub missing_exports: Vec<String>,
    pub test: Option<String>,
    pub delta: i64,
}

/// The identifiers a source DECLARES, split by whether they are exported.
///
/// IMPORTS ARE STRIPPED FIRST, or `import { type Foo }` reads as a `type Foo` DECLARATION and three
/// deploy modules get reported as drifted when they are not. A false "drifted" costs as much as a missed
/// one.
///
/// The export/internal split is the SEVERITY. A missing EXPORT breaks importers at once — retiring
/// `SettingsPageHeader.tsx` against its current seed would delete `SettingsSubHeader`, which three other
/// files render — while a missing internal name means the seed is merely an older revision: still drift,
/// still a reason to refresh the seed first, but not an immediate break.
pub fn symbols(src: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    static IMPORT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static DECL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let import = IMPORT.get_or_init(|| {
        regex::Regex::new(r#"(?m)^[ \t]*import\s+[^;]*?from\s*["'][^"']+["'];?[ \t]*$"#)
            .expect("import pattern")
    });
    let decl = DECL.get_or_init(|| {
        regex::Regex::new(
            r"(?:^|\n)[ \t]*(export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)",
        )
        .expect("declaration pattern")
    });
    let body = import.replace_all(src, "");
    let (mut all, mut exported) = (BTreeSet::new(), BTreeSet::new());
    for c in decl.captures_iter(&body) {
        let name = c[2].to_string();
        if c.get(1).is_some() {
            exported.insert(name.clone());
        }
        all.insert(name);
    }
    (all, exported)
}

/// Every file under `src/`, as `src/`-relative paths.
pub fn list_src(repo: &Path) -> BTreeSet<String> {
    fn walk(dir: &Path, rel: &str, out: &mut BTreeSet<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if e.path().is_dir() {
                walk(&e.path(), &r, out);
            } else {
                out.insert(r);
            }
        }
    }
    let mut out = BTreeSet::new();
    walk(&repo.join("src"), "", &mut out);
    out
}

/// The file a `@/…` specifier resolves to, trying each extension form in order.
pub fn file_for(src_files: &BTreeSet<String>, spec: &str) -> Option<String> {
    const EXT: [&str; 7] = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];
    let b = spec.strip_prefix("@/")?;
    EXT.iter().map(|e| format!("{b}{e}")).find(|c| src_files.contains(c))
}

/// Every packaged seed that `provides` a specifier with real source, keyed by that specifier.
///
/// A COMPONENT wins a collision with an algorithm impl — the same precedence `resolveGraphSource` and
/// `emit-records` apply, so the census agrees with what would actually be served.
pub fn collect_seeds(repo: &Path) -> BTreeMap<String, (String, &'static str, String)> {
    fn walk(dir: &Path, seeds: &mut BTreeMap<String, (String, &'static str, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, seeds);
                continue;
            }
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            // A 4 MB ceiling: the packaged kit blobs are not per-record seeds and parsing them here
            // would cost seconds for nothing.
            if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) > 4_000_000 {
                continue;
            }
            let Ok(body) = std::fs::read_to_string(&p) else { continue };
            let Ok(r) = serde_json::from_str::<serde_json::Value>(&body) else { continue };
            let spec = r.get("provides").and_then(serde_json::Value::as_str).unwrap_or("").trim();
            let text = r.get("srcText").and_then(serde_json::Value::as_str).unwrap_or("");
            let id = r.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
            if spec.starts_with("@/") && !text.trim().is_empty() && !id.is_empty() {
                seeds.insert(spec.to_string(), (id.to_string(), "component", text.to_string()));
            }
        }
    }
    let mut seeds = BTreeMap::new();
    walk(&repo.join("src-tauri/data/components"), &mut seeds);

    // A checkout without the algorithm seed is still valid, so this is best-effort.
    if let Ok(body) = std::fs::read_to_string(repo.join("src-tauri/data/knowledge/algorithms.json")) {
        if let Ok(k) = serde_json::from_str::<serde_json::Value>(&body) {
            for im in k.get("implementations").and_then(serde_json::Value::as_array).unwrap_or(&vec![]) {
                let spec = im.get("provides").and_then(serde_json::Value::as_str).unwrap_or("").trim();
                let code = im.get("code").and_then(serde_json::Value::as_str).unwrap_or("");
                let id = im.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
                if spec.starts_with("@/")
                    && !code.trim().is_empty()
                    && !id.is_empty()
                    && !seeds.contains_key(spec)
                {
                    seeds.insert(spec.to_string(), (id.to_string(), "algorithm", code.to_string()));
                }
            }
        }
    }
    seeds
}

/// Files importing `spec` — by the `@/` specifier, OR by a RELATIVE path resolving to the same module.
///
/// The relative half matters because those importers must be rewritten to `@/…` BEFORE the file goes:
/// a relative import cannot resolve to an emitted record.
pub fn importers_of(
    texts: &BTreeMap<String, String>,
    spec: &str,
    file: &str,
) -> (Vec<String>, Vec<String>) {
    static REL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let rel_re = REL.get_or_init(|| {
        regex::Regex::new(r#"(?:from|import|require)\s*\(?\s*["'](\.\.?/[^"']+)["']"#)
            .expect("relative pattern")
    });
    let base = strip_ext(file);
    let (mut by_alias, mut by_relative) = (Vec::new(), Vec::new());
    for (f, t) in texts {
        if f == file {
            continue;
        }
        if t.contains(spec) {
            by_alias.push(f.clone());
            continue;
        }
        let fdir = f.rsplit_once('/').map_or("", |(d, _)| d);
        for c in rel_re.captures_iter(t) {
            let mut out: Vec<&str> = Vec::new();
            let joined = format!("{fdir}/{}", &c[1]);
            for p in joined.split('/') {
                match p {
                    "." | "" => continue,
                    ".." => {
                        out.pop();
                    }
                    _ => out.push(p),
                }
            }
            if out.join("/") == base {
                by_relative.push(f.clone());
                break;
            }
        }
    }
    (by_alias, by_relative)
}

/// A path with its extension and any trailing `/index` removed — the form a specifier compares against.
fn strip_ext(file: &str) -> String {
    let s = file
        .strip_suffix(".tsx")
        .or_else(|| file.strip_suffix(".ts"))
        .or_else(|| file.strip_suffix(".jsx"))
        .or_else(|| file.strip_suffix(".js"))
        .unwrap_or(file);
    s.strip_suffix("/index").unwrap_or(s).to_string()
}

/// Classify every seed-backed file under `repo/src` as retirable or not.
pub fn census(repo: &Path) -> Vec<Candidate> {
    let src_files = list_src(repo);
    let seeds = collect_seeds(repo);
    let texts: BTreeMap<String, String> = src_files
        .iter()
        .filter(|f| f.ends_with(".ts") || f.ends_with(".tsx"))
        .filter_map(|f| std::fs::read_to_string(repo.join("src").join(f)).ok().map(|t| (f.clone(), t)))
        .collect();

    // Hoisted: an algorithm-library module is served from the graph, not retired into a record, and
    // compiling this per candidate is both wasteful and a clippy error.
    let algo_lib = regex::Regex::new(r"^shared/lib/algorithms/[^/]+\.ts$")
        .expect("algorithm-library pattern");

    let mut rows: Vec<Candidate> = Vec::new();
    for (spec, (id, kind, source)) in &seeds {
        let Some(file) = file_for(&src_files, spec) else { continue }; // already retired, or record-native
        if file.ends_with(".d.ts") {
            continue;
        }
        if algo_lib.is_match(&file) {
            continue;
        }
        // A module an app ENTRY imports statically must exist as a FILE however good its record is — the
        // dev server resolves the alias before the records plugin is installed. Shared with the deleter,
        // so the census cannot offer what the tool would refuse.
        let base = strip_ext(&file);
        let read = |p: &str| std::fs::read_to_string(p).unwrap_or_default();
        let exists = |p: &str| Path::new(p).is_file();
        if !crate::record_source::entries_importing_statically(
            &repo.to_string_lossy(),
            &base,
            &read,
            &exists,
        )
        .is_empty()
        {
            continue;
        }

        let Ok(file_src) =
            crate::record_source::file_as_record_source(&repo.join("src").join(&file), &file)
        else {
            continue;
        };
        let (_, seed_src) =
            crate::record_source::split_preamble(&crate::record_source::norm(source), &file_src);
        let (file_all, file_exported) = symbols(&file_src);
        let (seed_all, _) = symbols(&seed_src);
        let missing: Vec<String> = file_all.iter().filter(|s| !seed_all.contains(*s)).cloned().collect();
        let missing_exports: Vec<String> =
            missing.iter().filter(|s| file_exported.contains(*s)).cloned().collect();
        let (by_alias, by_relative) = importers_of(&texts, spec, &file);

        // ORDER IS THE JUDGEMENT. `same` is byte-identical once the preamble is off. `BREAKS` outranks
        // `reformatted` because a missing EXPORT is worse than a formatting difference and must not be
        // hidden by one. `BODY-DIFFERS` is the residue: the code itself differs, so retiring ships the
        // RECORD's behaviour under the file's name — and it compiles either way.
        let verdict = if seed_src == file_src {
            "same"
        } else if !missing_exports.is_empty() {
            "BREAKS"
        } else if crate::record_source::code_only(&seed_src)
            == crate::record_source::code_only(&file_src)
        {
            "reformatted"
        } else {
            "BODY-DIFFERS"
        };

        let stem = file
            .strip_suffix(".tsx")
            .or_else(|| file.strip_suffix(".ts"))
            .unwrap_or(&file)
            .to_string();
        let test = ["test", "spec"]
            .iter()
            .flat_map(|k| [format!("{stem}.{k}.ts"), format!("{stem}.{k}.tsx")])
            .find(|p| src_files.contains(p));

        rows.push(Candidate {
            spec: spec.clone(),
            file,
            id: id.clone(),
            kind,
            importers: by_alias.len() + by_relative.len(),
            relative: by_relative,
            verdict,
            missing,
            missing_exports,
            test,
            // UTF-16 UNITS, not bytes. The JS this reproduces reports `String.length`, which counts
            // code units; a byte count differs on every non-ASCII character and this repo's sources are
            // full of em dashes. Measured on shared/ui/charts/index.ts: +24999 against +26001.
            delta: seed_src.encode_utf16().count() as i64 - file_src.encode_utf16().count() as i64,
        });
    }
    // Fewest importers first — the cheapest retirement to review is the one nothing depends on.
    rows.sort_by(|a, b| a.importers.cmp(&b.importers).then_with(|| a.file.cmp(&b.file)));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway repo: `src/` files plus packaged component seeds, which is all [`census`] reads.
    fn repo(label: &str, files: &[(&str, &str)], seeds: &[(&str, &str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("bsc-retirable-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (rel, body) in files {
            let p = root.join("src").join(rel);
            std::fs::create_dir_all(p.parent().expect("a parent")).expect("mkdir");
            std::fs::write(p, body).expect("write a src file");
        }
        let seed_dir = root.join("src-tauri/data/components");
        std::fs::create_dir_all(&seed_dir).expect("mkdir seeds");
        for (id, provides, src_text) in seeds {
            let body = serde_json::json!({ "id": id, "provides": provides, "srcText": src_text });
            std::fs::write(seed_dir.join(format!("{id}.json")), body.to_string()).expect("write a seed");
        }
        root
    }

    /// REPLACES a vitest assertion that grepped the census's SOURCE for the exclusion regex. Reading the
    /// implementation's text passes for a rule that is present but unreachable; this asserts the rule
    /// actually holds.
    ///
    /// A `.d.ts` is types only — there is nothing to retire into a record, and offering one would hand
    /// the deleter a file whose removal changes no behaviour and breaks every consumer's types.
    #[test]
    fn a_d_ts_is_never_offered_as_a_candidate() {
        let root = repo(
            "dts",
            &[("shared/types/globals.d.ts", "declare const X: number;\n")],
            &[("globals", "@/shared/types/globals", "declare const X: number;\n")],
        );
        let rows = census(&root);
        assert!(rows.is_empty(), "a .d.ts must not be a candidate: {:?}", rows.iter().map(|r| &r.file).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// ...and the corpus is not vacuous: an ORDINARY file with an identical seed IS offered, so the test
    /// above proves an exclusion rather than a census that finds nothing at all.
    #[test]
    fn an_ordinary_file_with_a_matching_seed_is_offered_as_same() {
        let body = "export const a = 1;\n";
        let root = repo("same", &[("shared/lib/a.ts", body)], &[("a", "@/shared/lib/a", body)]);
        let rows = census(&root);
        assert_eq!(rows.len(), 1, "the ordinary candidate must be found: {rows:?}");
        assert_eq!(rows[0].verdict, "same");
        assert_eq!(rows[0].file, "shared/lib/a.ts");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The severity order: a seed missing an EXPORT is `BREAKS`, and that must outrank a formatting
    /// match — otherwise a reflowed comment could hide a module whose consumers stop compiling.
    #[test]
    fn a_missing_export_breaks_and_outranks_reformatted() {
        let file = "export const a = 1;\nexport const b = 2;\n";
        let seed = "export const a = 1;\n";
        let root = repo("breaks", &[("shared/lib/b.ts", file)], &[("b", "@/shared/lib/b", seed)]);
        let rows = census(&root);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].verdict, "BREAKS", "{rows:?}");
        assert_eq!(rows[0].missing_exports, vec!["b".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
