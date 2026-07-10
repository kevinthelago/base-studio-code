//! `bsc ui emit` (#2800, epic #2793) — vendor a kit component (or the whole kit) as **compilable**
//! source into a target directory. This is the consumption end of the vendored-source distribution: an
//! agent building an app pulls the components it needs as real files it can import, with every
//! first-party `@/…` import rewritten to a resolvable relative path so the emitted tree compiles with
//! **no alias config and no network** — it resolves entirely against the EMBEDDED kit artifact
//! ([`crate::kit::PACKAGED_KIT_JSON`]), so it works inside the sealed sandbox where the mutable stores
//! aren't reachable.
//!
//! The artifact carries two things this needs (built by `reactUiKit.gen`): each component's verbatim
//! `source` (#2795) and a `runtime` map of the transitive NON-component modules the components import
//! (#2799 — the `_kit/` support closure). Emit resolves a component's transitive closure by walking its
//! source imports against those two sets — a `@/…` that resolves to a component `src` is a sibling file
//! (a `composes` edge), one that resolves to a `runtime` key is a support module; anything else is an
//! external npm dep (react, d3), left as-is and REPORTED so the app declares it.
//!
//! Layout: every emitted file mirrors its `src/`-relative path under `<dir>/`, so the relative structure
//! is preserved and each `@/X` rewrites to `relative(dir_of_this_file, X)`. Provenance is stamped on
//! every file (the marker ②·3 `sync` keys on).

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// A parsed kit artifact, ready to emit from. Holds the component sources + the runtime support map,
/// both keyed by their `src/`-relative path (the identity the import walk + layout use).
pub struct EmitKit {
    /// Publisher-scoped id (`bsc/react-ui`) + exact version — stamped into every emitted file's provenance.
    id: String,
    version: String,
    /// component id (lowercase, e.g. `card`) -> its `src/`-relative path (e.g. `shared/ui/data/Card.tsx`).
    id_to_path: BTreeMap<String, String>,
    /// `src/`-relative path -> verbatim source, for BOTH component files and runtime modules (one lookup
    /// for the import walk; the two sets are distinguished by [`Self::component_paths`]).
    source_by_path: BTreeMap<String, String>,
    /// The subset of `source_by_path` keys that are COMPONENT files (the rest are runtime modules).
    component_paths: BTreeSet<String>,
}

/// One file to write: its path relative to the emit `<dir>` (mirroring `src/`) and its final content
/// (imports rewritten + provenance stamped).
#[derive(Debug)]
pub struct EmitFile {
    pub path: String,
    pub content: String,
}

/// The result of planning an emit: the files to write + the external (npm) packages the vendored code
/// imports (so the app can declare them — the closure vendors first-party source only).
#[derive(Debug)]
pub struct EmitPlan {
    pub files: Vec<EmitFile>,
    pub external_deps: Vec<String>,
}

impl EmitKit {
    /// The packaged `bsc/react-ui` kit — the embedded artifact, no fs/network. Panics only on a
    /// malformed embedded file (guarded by tests + the frontend drift guard).
    pub fn packaged() -> EmitKit {
        Self::from_artifact(crate::kit::PACKAGED_KIT_JSON).expect("embedded react-ui.json is a valid kit artifact")
    }

    /// Parse a kit artifact JSON (`{ id, version, components: [{id, src, source}], runtime: {path: src} }`).
    pub fn from_artifact(json: &str) -> Result<EmitKit, String> {
        let v: Value = serde_json::from_str(json).map_err(|e| format!("kit artifact is not valid JSON: {e}"))?;
        let id = v.get("id").and_then(Value::as_str).unwrap_or("bsc/react-ui").to_string();
        let version = v.get("version").and_then(Value::as_str).unwrap_or("0.0.0").to_string();
        let mut id_to_path = BTreeMap::new();
        let mut source_by_path = BTreeMap::new();
        let mut component_paths = BTreeSet::new();
        for c in v.get("components").and_then(Value::as_array).into_iter().flatten() {
            let (Some(cid), Some(src)) = (
                c.get("id").and_then(Value::as_str),
                c.get("src").and_then(Value::as_str),
            ) else {
                continue;
            };
            id_to_path.insert(cid.to_string(), src.to_string());
            component_paths.insert(src.to_string());
            // A component without a real file (a pure stub) carries no `source` — skip it as an emit
            // target, but keep its id→path so a composes edge to it still resolves (best-effort).
            if let Some(source) = c.get("source").and_then(Value::as_str) {
                source_by_path.insert(src.to_string(), source.to_string());
            }
        }
        for (path, source) in v.get("runtime").and_then(Value::as_object).into_iter().flatten() {
            if let Some(s) = source.as_str() {
                source_by_path.insert(path.clone(), s.to_string());
            }
        }
        Ok(EmitKit { id, version, id_to_path, source_by_path, component_paths })
    }

    /// The lowercase ids of every component in the kit (sorted) — for the `emit kit` set + error help.
    pub fn component_ids(&self) -> Vec<String> {
        self.id_to_path.keys().cloned().collect()
    }

    /// Plan an emit of ONE component + its transitive closure into `<dir>`-relative files.
    pub fn plan_component(&self, id: &str) -> Result<EmitPlan, String> {
        let root = self.id_to_path.get(id).ok_or_else(|| {
            format!("unknown component '{id}' — see `bsc ui emit kit` or `bsc ui components`")
        })?;
        self.plan_from_roots(std::slice::from_ref(root))
    }

    /// Plan an emit of the WHOLE kit (every component + the full runtime closure).
    pub fn plan_kit(&self) -> EmitPlan {
        let roots: Vec<String> = self.component_paths.iter().cloned().collect();
        // The whole kit is self-complete by construction (the #2799 completeness guard), so this never errs.
        self.plan_from_roots(&roots).expect("whole-kit closure is complete")
    }

    /// The transitive closure of `roots` (each a `src/`-relative path), walked through first-party
    /// imports, rendered to `EmitFile`s + the external-dep report.
    fn plan_from_roots(&self, roots: &[String]) -> Result<EmitPlan, String> {
        let mut needed: BTreeSet<String> = BTreeSet::new();
        let mut externals: BTreeSet<String> = BTreeSet::new();
        let mut queue: Vec<String> = roots.to_vec();
        while let Some(path) = queue.pop() {
            if !needed.insert(path.clone()) {
                continue;
            }
            let Some(source) = self.source_by_path.get(&path) else {
                // A closure member with no bundled source (a stub component) — nothing to walk/emit.
                needed.remove(&path);
                continue;
            };
            for spec in import_specifiers(source) {
                if let Some(first_party) = spec.strip_prefix("@/") {
                    // An unresolved first-party path (shouldn't happen for a complete kit) is skipped.
                    if let Some(target) = self.resolve(first_party) {
                        queue.push(target);
                    }
                } else if let Some(pkg) = external_package(&spec) {
                    externals.insert(pkg);
                }
            }
        }
        let files = needed
            .iter()
            .filter(|p| self.source_by_path.contains_key(*p))
            .map(|p| EmitFile { path: p.clone(), content: self.render(p) })
            .collect();
        Ok(EmitPlan { files, external_deps: externals.into_iter().collect() })
    }

    /// Resolve a first-party import (an `@/…` specifier with the `@/` stripped, e.g.
    /// `shared/ui/feedback/Skeleton`) to a known `src/`-relative path in the artifact, trying TS
    /// module-resolution order. `None` when it isn't a bundled component or runtime module.
    fn resolve(&self, spec: &str) -> Option<String> {
        for ext in [".ts", ".tsx", "/index.ts", "/index.tsx"] {
            let cand = format!("{spec}{ext}");
            if self.source_by_path.contains_key(&cand) || self.component_paths.contains(&cand) {
                return Some(cand);
            }
        }
        None
    }

    /// Render one file's final content: rewrite every first-party `@/…` import to a relative path and
    /// prepend the provenance stamp.
    fn render(&self, path: &str) -> String {
        let source = self.source_by_path.get(path).map(String::as_str).unwrap_or("");
        let dir = dir_of(path);
        let rewritten = rewrite_imports(source, dir, &|spec| {
            self.resolve(spec).map(|t| rel_import(dir, &strip_ext(&t)))
        });
        format!(
            "// vendored from {}@{} — `bsc ui emit` (regenerate to update; do not hand-edit)\n{}",
            self.id, self.version, rewritten
        )
    }
}

/// The directory portion of a `src/`-relative path (`shared/ui/data/Card.tsx` → `shared/ui/data`;
/// a top-level file → `""`).
fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

/// Strip a TS extension from a `src/`-relative path so it reads as an import specifier
/// (`shared/ui/data/Card.tsx` → `shared/ui/data/Card`).
fn strip_ext(path: &str) -> String {
    for ext in [".tsx", ".ts"] {
        if let Some(base) = path.strip_suffix(ext) {
            return base.to_string();
        }
    }
    path.to_string()
}

/// The POSIX relative import from a file in `from_dir` to the extension-less target `to`, always
/// prefixed `./` or `../` so a bundler treats it as a relative path (not a bare package).
fn rel_import(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let to_parts: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = from.iter().zip(&to_parts).take_while(|(a, b)| a == b).count();
    let mut segs: Vec<String> = vec!["..".to_string(); from.len() - common];
    segs.extend(to_parts[common..].iter().map(|s| s.to_string()));
    let joined = segs.join("/");
    if joined.starts_with("..") {
        joined
    } else {
        format!("./{joined}")
    }
}

/// Every module specifier a source `import`s / `export … from`s / dynamically `import()`s. Scans for
/// the quoted specifier after a `from`/`import` keyword — enough for the kit's sources (which use the
/// `@/…` convention exclusively for first-party modules).
fn import_specifiers(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = source.as_bytes();
    for kw in ["from", "import"] {
        let mut search = 0;
        while let Some(rel) = source[search..].find(kw) {
            let at = search + rel;
            search = at + kw.len();
            // The keyword must be a word boundary (not e.g. `transform`), and be followed by the
            // specifier after optional whitespace / a `(` (dynamic import).
            let before_ok = at == 0 || !bytes[at - 1].is_ascii_alphanumeric() && bytes[at - 1] != b'_';
            if !before_ok {
                continue;
            }
            let rest = &source[search..];
            let trimmed = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '(');
            let Some(quote) = trimmed.chars().next().filter(|c| *c == '"' || *c == '\'') else {
                continue;
            };
            if let Some(end) = trimmed[1..].find(quote) {
                out.push(trimmed[1..1 + end].to_string());
            }
        }
    }
    out
}

/// The npm PACKAGE name of a non-first-party specifier — `react` / `react/jsx-runtime` → `react`,
/// `@scope/pkg/sub` → `@scope/pkg`. `None` for a relative specifier (`.`/`..`) — those resolve within
/// the emitted tree and are never external.
fn external_package(spec: &str) -> Option<String> {
    if spec.starts_with('.') || spec.starts_with('/') {
        return None;
    }
    let parts: Vec<&str> = spec.split('/').collect();
    if spec.starts_with('@') {
        // Scoped: keep `@scope/name`.
        (parts.len() >= 2).then(|| format!("{}/{}", parts[0], parts[1]))
    } else {
        parts.first().map(|s| s.to_string())
    }
}

/// Rewrite every first-party `@/…` import specifier in `source` using `resolve` (spec-without-`@/` →
/// the relative import to write). An unresolved `@/…` is left verbatim (never dropped). Non-`@/`
/// specifiers are untouched.
fn rewrite_imports(source: &str, _dir: &str, resolve: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(source.len());
    let mut last = 0;
    let mut search = 0;
    while let Some(rel) = source[search..].find("@/") {
        let at = search + rel;
        let after = at + 2;
        // The specifier body runs until the closing quote.
        let end = source[after..].find(['"', '\'']).map(|e| after + e).unwrap_or(source.len());
        let spec = &source[after..end];
        out.push_str(&source[last..at]);
        match resolve(spec) {
            Some(relimport) => out.push_str(&relimport),
            None => out.push_str(&source[at..end]), // leave `@/spec` untouched
        }
        last = end;
        search = end;
    }
    out.push_str(&source[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny synthetic kit: Card composes Skeleton; both import a `core/format` runtime module; Card
    /// also imports `react` (external). Exercises component→component, →runtime, and external edges.
    fn fixture() -> EmitKit {
        let json = serde_json::json!({
            "id": "acme/kit",
            "version": "2.1.0",
            "components": [
                { "id": "card", "src": "shared/ui/data/Card.tsx",
                  "source": "import { Skeleton } from \"@/shared/ui/feedback/Skeleton\";\nimport { fmt } from \"@/shared/lib/core/format\";\nimport { useState } from \"react\";\nexport const Card = () => null;" },
                { "id": "skeleton", "src": "shared/ui/feedback/Skeleton.tsx",
                  "source": "import { fmt } from \"@/shared/lib/core/format\";\nexport const Skeleton = () => null;" }
            ],
            "runtime": {
                "shared/lib/core/format.ts": "export const fmt = (x: number) => String(x);"
            }
        });
        EmitKit::from_artifact(&json.to_string()).unwrap()
    }

    #[test]
    fn rel_import_computes_posix_relative_paths() {
        assert_eq!(rel_import("shared/ui/data", "shared/ui/feedback/Skeleton"), "../feedback/Skeleton");
        assert_eq!(rel_import("shared/ui/data", "shared/lib/core/format"), "../../lib/core/format");
        assert_eq!(rel_import("shared/ui/data", "shared/ui/data/Sibling"), "./Sibling");
        assert_eq!(rel_import("", "Top"), "./Top");
    }

    #[test]
    fn import_specifiers_finds_first_party_and_external() {
        let src = "import { A } from \"@/x/y\";\nexport { B } from '@/z';\nconst m = await import(\"react\");";
        let specs = import_specifiers(src);
        assert!(specs.contains(&"@/x/y".to_string()));
        assert!(specs.contains(&"@/z".to_string()));
        assert!(specs.contains(&"react".to_string()));
    }

    #[test]
    fn external_package_extracts_the_bare_name() {
        assert_eq!(external_package("react"), Some("react".into()));
        assert_eq!(external_package("react/jsx-runtime"), Some("react".into()));
        assert_eq!(external_package("d3-scale"), Some("d3-scale".into()));
        assert_eq!(external_package("@scope/pkg/sub"), Some("@scope/pkg".into()));
        assert_eq!(external_package("./local"), None);
    }

    #[test]
    fn plan_component_resolves_the_transitive_closure_and_rewrites_imports() {
        let plan = fixture().plan_component("card").unwrap();
        let by_path: BTreeMap<_, _> = plan.files.iter().map(|f| (f.path.as_str(), f.content.as_str())).collect();
        // The closure is Card + Skeleton (composes) + format (runtime) — three files.
        assert_eq!(plan.files.len(), 3, "closure = card + skeleton + format");
        assert!(by_path.contains_key("shared/ui/data/Card.tsx"));
        assert!(by_path.contains_key("shared/ui/feedback/Skeleton.tsx"));
        assert!(by_path.contains_key("shared/lib/core/format.ts"));
        // Card's `@/…` imports are rewritten to resolvable relative paths, react is untouched.
        let card = by_path["shared/ui/data/Card.tsx"];
        assert!(card.contains("from \"../feedback/Skeleton\""), "composes edge → sibling: {card}");
        assert!(card.contains("from \"../../lib/core/format\""), "runtime edge → _kit path: {card}");
        assert!(card.contains("from \"react\""), "external import left as-is");
        assert!(!card.contains("@/"), "no first-party alias survives in the emitted file");
        // Provenance stamped.
        assert!(card.starts_with("// vendored from acme/kit@2.1.0 —"), "provenance header: {card}");
        // The external dep is reported.
        assert_eq!(plan.external_deps, vec!["react".to_string()]);
    }

    #[test]
    fn every_emitted_first_party_import_resolves_within_the_emitted_set() {
        // The compile guarantee: after rewriting, no `@/…` remains anywhere in an emitted file.
        let plan = fixture().plan_kit();
        for f in &plan.files {
            assert!(!f.content.contains("@/"), "{} still has a first-party alias", f.path);
        }
    }

    #[test]
    fn unknown_component_errors_with_help() {
        let err = fixture().plan_component("nope").unwrap_err();
        assert!(err.contains("unknown component 'nope'"), "{err}");
    }

    #[test]
    fn packaged_kit_plans_a_real_component_with_a_complete_closure() {
        // Against the REAL embedded artifact: emitting `card` produces files, and NONE retains a
        // first-party alias — the #2799 closure really is complete end-to-end.
        let plan = EmitKit::packaged().plan_component("card").unwrap();
        assert!(!plan.files.is_empty());
        for f in &plan.files {
            assert!(!f.content.contains("@/"), "{} retains @/", f.path);
            assert!(f.content.starts_with("// vendored from bsc/react-ui@"), "stamped: {}", f.path);
        }
    }
}
