//! Lockfile/manifest parsers (#3797) — turn a dependency file into the flat `Vec<Package>` the scan
//! queries OSV with. Pure over the file TEXT (fixture-tested); the only I/O is [`scan_path`], which
//! detects the file by name and reads it. Coverage this slice: **npm** (`package-lock.json` v2/v3,
//! with a v1 `dependencies` fallback), **Cargo** (`Cargo.lock`), and **pip** (`requirements.txt`).
//! yarn/pnpm/go are recognized-but-unsupported for now (a clear error, not a silent empty scan).

use crate::types::{Ecosystem, Package};
use serde_json::Value;
use std::path::Path;

/// Parse a `package-lock.json`. Prefers the modern `packages` map (lockfileVersion 2/3), keyed by
/// install path — the package NAME is whatever follows the last `node_modules/`; the root entry (`""`)
/// and workspace `link` entries are skipped. Falls back to a recursive walk of the v1 `dependencies`
/// tree. Dedupes on (name, version) so a package installed at many depths is queried once.
pub fn parse_npm_lock(text: &str) -> Result<Vec<Package>, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("package-lock.json: bad JSON: {e}"))?;
    let mut out: Vec<Package> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |name: String, version: Option<String>, out: &mut Vec<Package>| {
        if name.is_empty() {
            return;
        }
        if seen.insert((name.clone(), version.clone())) {
            out.push(Package::new(Ecosystem::Npm, name, version));
        }
    };

    if let Some(packages) = root.get("packages").and_then(|p| p.as_object()) {
        for (path, entry) in packages {
            if path.is_empty() {
                continue; // the root project, not a dependency
            }
            if entry.get("link").and_then(|l| l.as_bool()).unwrap_or(false) {
                continue; // a workspace symlink, not a real install
            }
            let name = path.rsplit("node_modules/").next().unwrap_or(path).to_string();
            let version = entry.get("version").and_then(|v| v.as_str()).map(str::to_string);
            push(name, version, &mut out);
        }
        return Ok(out);
    }

    // v1 fallback: a nested `dependencies` tree.
    if let Some(deps) = root.get("dependencies").and_then(|d| d.as_object()) {
        walk_v1_deps(deps, &mut |name, version, o| push(name, version, o), &mut out);
    }
    Ok(out)
}

/// Recursively collect names+versions from a v1 `dependencies` tree.
fn walk_v1_deps(
    deps: &serde_json::Map<String, Value>,
    push: &mut impl FnMut(String, Option<String>, &mut Vec<Package>),
    out: &mut Vec<Package>,
) {
    for (name, entry) in deps {
        let version = entry.get("version").and_then(|v| v.as_str()).map(str::to_string);
        push(name.clone(), version, out);
        if let Some(nested) = entry.get("dependencies").and_then(|d| d.as_object()) {
            walk_v1_deps(nested, push, out);
        }
    }
}

/// Parse a `Cargo.lock` (TOML). The format is regular — a sequence of `[[package]]` blocks each with
/// `name = "…"` / `version = "…"` — so a line scan is robust + dep-free. Only complete (name+version)
/// packages are emitted; dedupe on (name, version).
pub fn parse_cargo_lock(text: &str) -> Result<Vec<Package>, String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut name: Option<String> = None;
    let mut version: Option<String> = None;
    let mut in_pkg = false;

    let flush = |name: &mut Option<String>, version: &mut Option<String>, out: &mut Vec<Package>, seen: &mut std::collections::HashSet<(String, String)>| {
        if let (Some(n), Some(v)) = (name.take(), version.take()) {
            if seen.insert((n.clone(), v.clone())) {
                out.push(Package::new(Ecosystem::Cargo, n, Some(v)));
            }
        }
    };

    for line in text.lines() {
        let t = line.trim();
        if t == "[[package]]" {
            flush(&mut name, &mut version, &mut out, &mut seen);
            in_pkg = true;
            continue;
        }
        if t.starts_with('[') {
            // Any other table (e.g. `[metadata]`) ends the current package block.
            flush(&mut name, &mut version, &mut out, &mut seen);
            in_pkg = false;
            continue;
        }
        if !in_pkg {
            continue;
        }
        if let Some(v) = toml_str_value(t, "name") {
            name = Some(v);
        } else if let Some(v) = toml_str_value(t, "version") {
            version = Some(v);
        }
    }
    flush(&mut name, &mut version, &mut out, &mut seen);
    Ok(out)
}

/// Extract `key = "value"` from a trimmed TOML line, returning the unquoted value.
fn toml_str_value(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim_start();
    let rest = rest.strip_prefix('=')?.trim();
    let inner = rest.strip_prefix('"')?.strip_suffix('"')?;
    Some(inner.to_string())
}

/// Parse a `requirements.txt`. Emits `name==version` pins with their exact version, and bare `name`
/// lines versionless; skips comments, blank lines, includes (`-r`/`-c`), options (`-e`, `--…`), URLs,
/// and inexact constraints (`>=`, `~=`, …) whose exact version can't be resolved here.
pub fn parse_requirements(text: &str) -> Result<Vec<Package>, String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() || line.starts_with('-') || line.contains("://") {
            continue;
        }
        // Strip environment markers / extras: `pkg[extra]; python_version<'3'` → `pkg[extra]`.
        let core = line.split(';').next().unwrap_or(line).trim();
        let (name_part, version) = match core.split_once("==") {
            Some((n, v)) => (n, Some(v.trim().to_string())),
            None => {
                // Bare name (no operator) → versionless; an inexact constraint → skip.
                if core.contains(['>', '<', '~', '!', '=']) {
                    continue;
                }
                (core, None)
            }
        };
        // Drop extras in `pkg[extra]`.
        let name = name_part.split('[').next().unwrap_or(name_part).trim().to_string();
        if name.is_empty() {
            continue;
        }
        if seen.insert((name.clone(), version.clone())) {
            out.push(Package::new(Ecosystem::Pypi, name, version));
        }
    }
    Ok(out)
}

/// A recognized lockfile kind, chosen by file name.
enum Kind {
    Npm,
    Cargo,
    Pip,
}

/// Classify a path by its file name; `None` for an unrecognized file.
fn classify(path: &Path) -> Option<Kind> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    match name.as_str() {
        "package-lock.json" | "npm-shrinkwrap.json" => Some(Kind::Npm),
        "cargo.lock" => Some(Kind::Cargo),
        "requirements.txt" => Some(Kind::Pip),
        _ => None,
    }
}

/// Recognized-but-unsupported lockfiles, so `scan` gives a clear "not yet" instead of a silent empty
/// result that reads as "no vulnerabilities".
fn unsupported(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    match name.as_str() {
        "yarn.lock" => Some("yarn.lock"),
        "pnpm-lock.yaml" => Some("pnpm-lock.yaml"),
        "go.sum" | "go.mod" => Some("go.sum/go.mod"),
        "poetry.lock" | "pipfile.lock" => Some("poetry.lock/Pipfile.lock"),
        _ => None,
    }
}

/// The lockfiles a bare-directory scan looks for, in priority order.
const DIR_CANDIDATES: &[&str] = &["package-lock.json", "npm-shrinkwrap.json", "Cargo.lock", "requirements.txt"];

/// Read + parse a manifest at `path`. If `path` is a directory, the first supported lockfile inside it
/// (by [`DIR_CANDIDATES`] priority) is used. Returns the parsed packages, or a clear error naming an
/// unsupported/absent file — never a silent empty scan.
pub fn scan_path(path: &Path) -> Result<Vec<Package>, String> {
    let file = if path.is_dir() {
        DIR_CANDIDATES
            .iter()
            .map(|c| path.join(c))
            .find(|p| p.is_file())
            .ok_or_else(|| {
                format!(
                    "no supported lockfile in {} (looked for {})",
                    path.display(),
                    DIR_CANDIDATES.join(", ")
                )
            })?
    } else {
        path.to_path_buf()
    };

    if let Some(kind) = classify(&file) {
        let text = std::fs::read_to_string(&file).map_err(|e| format!("reading {}: {e}", file.display()))?;
        return match kind {
            Kind::Npm => parse_npm_lock(&text),
            Kind::Cargo => parse_cargo_lock(&text),
            Kind::Pip => parse_requirements(&text),
        };
    }
    if let Some(what) = unsupported(&file) {
        return Err(format!("{} is not supported yet (supported: package-lock.json, Cargo.lock, requirements.txt)", what));
    }
    Err(format!(
        "unrecognized lockfile {} (supported: package-lock.json, Cargo.lock, requirements.txt)",
        file.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_npm_lock_v3_packages_map() {
        let text = r#"{
          "name": "myapp", "lockfileVersion": 3,
          "packages": {
            "": { "name": "myapp", "version": "1.0.0" },
            "node_modules/lodash": { "version": "4.17.19" },
            "node_modules/@scope/pkg": { "version": "2.1.0" },
            "node_modules/a/node_modules/b": { "version": "0.3.0" },
            "node_modules/local": { "version": "9.9.9", "link": true }
          }
        }"#;
        let pkgs = parse_npm_lock(text).unwrap();
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"lodash"));
        assert!(names.contains(&"@scope/pkg"));
        assert!(names.contains(&"b"), "nested node_modules name is the last segment");
        assert!(!names.contains(&"myapp"), "the root project is skipped");
        assert!(!names.contains(&"local"), "workspace links are skipped");
        let lodash = pkgs.iter().find(|p| p.name == "lodash").unwrap();
        assert_eq!(lodash.version.as_deref(), Some("4.17.19"));
        assert_eq!(lodash.ecosystem, Ecosystem::Npm);
    }

    #[test]
    fn parses_npm_lock_v1_dependencies_fallback() {
        let text = r#"{
          "name": "old", "lockfileVersion": 1,
          "dependencies": {
            "lodash": { "version": "4.17.11" },
            "chalk": { "version": "2.4.2", "dependencies": { "ansi-styles": { "version": "3.2.1" } } }
          }
        }"#;
        let pkgs = parse_npm_lock(text).unwrap();
        let names: Vec<&str> = pkgs.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"lodash") && names.contains(&"chalk") && names.contains(&"ansi-styles"));
    }

    #[test]
    fn parses_cargo_lock() {
        let text = r#"
version = 3

[[package]]
name = "serde"
version = "1.0.197"

[[package]]
name = "time"
version = "0.3.34"
source = "registry+https://github.com/rust-lang/crates.io-index"

[metadata]
"foo" = "bar"
"#;
        let pkgs = parse_cargo_lock(text).unwrap();
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0].name, "serde");
        assert_eq!(pkgs[0].version.as_deref(), Some("1.0.197"));
        assert_eq!(pkgs[1].name, "time");
        assert!(pkgs.iter().all(|p| p.ecosystem == Ecosystem::Cargo));
    }

    #[test]
    fn parses_requirements_txt() {
        let text = "\
# a comment
requests==2.31.0
Django>=4.0            # inexact, skipped
flask[async]==3.0.0   # extras stripped
-e ./local            # editable, skipped
-r other.txt          # include, skipped
https://x/y.whl       # url, skipped
click                 # bare name, versionless
";
        let pkgs = parse_requirements(text).unwrap();
        let by: std::collections::HashMap<&str, Option<&str>> =
            pkgs.iter().map(|p| (p.name.as_str(), p.version.as_deref())).collect();
        assert_eq!(by.get("requests"), Some(&Some("2.31.0")));
        assert_eq!(by.get("flask"), Some(&Some("3.0.0")), "extras stripped from the name");
        assert_eq!(by.get("click"), Some(&None), "bare name is versionless");
        assert!(!by.contains_key("Django"), "inexact constraint skipped");
        assert!(pkgs.iter().all(|p| p.ecosystem == Ecosystem::Pypi));
    }

    #[test]
    fn scan_path_errors_clearly_on_unsupported_and_unknown() {
        // We can classify by name without the file existing (classify/unsupported are name-only), but
        // scan_path reads the file — so use a temp dir with the actual files.
        let dir = std::env::temp_dir().join(format!("cve-lock-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("yarn.lock"), "# yarn").unwrap();
        let err = scan_path(&dir.join("yarn.lock")).unwrap_err();
        assert!(err.contains("not supported yet"), "{err}");
        std::fs::write(dir.join("random.txt"), "x").unwrap();
        assert!(scan_path(&dir.join("random.txt")).unwrap_err().contains("unrecognized"));
        // A directory with no lockfile is a clear error.
        let empty = dir.join("empty");
        let _ = std::fs::create_dir_all(&empty);
        assert!(scan_path(&empty).unwrap_err().contains("no supported lockfile"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_path_reads_a_directory_lockfile() {
        let dir = std::env::temp_dir().join(format!("cve-dir-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("Cargo.lock"), "[[package]]\nname = \"x\"\nversion = \"1.0.0\"\n").unwrap();
        let pkgs = scan_path(&dir).unwrap();
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].name, "x");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
