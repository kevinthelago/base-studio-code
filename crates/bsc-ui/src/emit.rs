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

    /// Build an EmitKit from the live component STORE overlaid on the packaged artifact (#3720) — so
    /// `emit component` can vendor a component from ANY kit (react-d3, harvested, …), not just react-ui.
    ///
    /// The packaged artifact is the BASE: it supplies the react-ui component sources (a built-in's store
    /// `source` is STRIPPED, #2794, so the store alone couldn't vendor react-ui) AND the shared runtime
    /// closure (`@/shared/lib/…` support modules every kit imports). Each store component that carries real
    /// source is then OVERLAID — a react-d3 chart or a harvested component resolves to its own source, and
    /// its `@/…` imports walk against the store siblings + the packaged runtime. A store record with NO
    /// usable source never clobbers a packaged source (a stripped builtin stays served from the artifact);
    /// it only registers its id→path so a `composes` edge to it still resolves best-effort.
    pub fn from_store(store_components: &[Value]) -> EmitKit {
        let mut kit = Self::packaged();
        // The merged view's provenance id — an emitted cross-kit file did not come from `bsc/react-ui`.
        kit.id = "bsc/studio".to_string();
        for c in store_components {
            let (Some(cid), Some(src)) = (
                c.get("id").and_then(Value::as_str),
                c.get("src").and_then(Value::as_str).filter(|s| !s.is_empty()),
            ) else {
                continue;
            };
            match component_source(c) {
                Some(source) => {
                    kit.id_to_path.insert(cid.to_string(), src.to_string());
                    kit.component_paths.insert(src.to_string());
                    kit.source_by_path.insert(src.to_string(), source);
                }
                None => {
                    kit.id_to_path.entry(cid.to_string()).or_insert_with(|| src.to_string());
                    kit.component_paths.insert(src.to_string());
                }
            }
        }
        kit
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
    /// prepend the provenance stamp — which embeds a `sha256` of the rewritten BODY, the fingerprint
    /// `emit sync` diffs to tell a MANAGED file (untouched since emit) from a DIVERGED one (hand-edited).
    fn render(&self, path: &str) -> String {
        let source = self.source_by_path.get(path).map(String::as_str).unwrap_or("");
        let dir = dir_of(path);
        let body = rewrite_imports(source, dir, &|spec| {
            self.resolve(spec).map(|t| rel_import(dir, &strip_ext(&t)))
        });
        let hash = crate::kit::sha256_hex(body.as_bytes());
        format!("{}\n{body}", stamp_line(&self.id, &self.version, &hash))
    }

    /// Re-render the file at `path` (a `src/`-relative path) if the current kit still has it as a
    /// component or runtime module; `None` when the kit no longer carries it (a removed/renamed source).
    pub fn render_path(&self, path: &str) -> Option<String> {
        self.source_by_path.contains_key(path).then(|| self.render(path))
    }

    /// Classify a vendored file at `path` (its `src/`-relative path) against the CURRENT kit, given its
    /// on-disk `content` — the pure core of `emit sync`. MANAGED (body hash == the stamp's) re-renders
    /// to `UpToDate`/`Rewrite`; a body that no longer matches the stamp is `Diverged` (hand-edited →
    /// never clobbered); a stamped path the kit dropped is `Unknown`; an unstamped file is `NotVendored`.
    pub fn classify(&self, path: &str, content: &str) -> SyncVerdict {
        let Some(stamp) = parse_stamp(content) else {
            return SyncVerdict::NotVendored;
        };
        if crate::kit::sha256_hex(body_of(content).as_bytes()) != stamp.body_sha256 {
            return SyncVerdict::Diverged; // hand-edited since emit — fall loudly, don't overwrite
        }
        match self.render_path(path) {
            None => SyncVerdict::Unknown,
            Some(fresh) if fresh == content => SyncVerdict::UpToDate,
            Some(fresh) => SyncVerdict::Rewrite(fresh),
        }
    }
}

/// The provenance stamp line embedding the kit ref + the body's sha256.
fn stamp_line(id: &str, version: &str, body_sha256: &str) -> String {
    format!("// vendored from {id}@{version} (sha256:{body_sha256}) — `bsc ui emit sync` to update, do not hand-edit")
}

/// The kit ref + stamped body-hash parsed from a vendored file's first line. `None` when the first
/// line isn't an emit stamp (an un-vendored file — `emit sync` leaves it alone).
#[derive(Debug, PartialEq)]
pub struct Stamp {
    pub kit_ref: String,
    pub body_sha256: String,
}

/// Parse the provenance stamp from a vendored file's content (its first line).
pub fn parse_stamp(content: &str) -> Option<Stamp> {
    let first = content.lines().next()?;
    let rest = first.strip_prefix("// vendored from ")?;
    let (kit_ref, after) = rest.split_once(" (sha256:")?;
    let hash = after.split_once(')').map(|(h, _)| h)?;
    Some(Stamp { kit_ref: kit_ref.to_string(), body_sha256: hash.to_string() })
}

/// The body of a vendored file — everything after the first (stamp) line, which is what the stamp's
/// sha256 covers.
fn body_of(content: &str) -> &str {
    content.find('\n').map(|i| &content[i + 1..]).unwrap_or("")
}

/// The verdict for one file under `emit sync` — the pure classification the CLI acts on.
#[derive(Debug)]
pub enum SyncVerdict {
    /// Managed + identical to a fresh render — nothing to do.
    UpToDate,
    /// Managed but the kit moved — the fresh content to overwrite it with (atomic upgrade).
    Rewrite(String),
    /// Hand-edited since emit — skipped, never clobbered (fall loudly).
    Diverged,
    /// Stamped, but its path is no longer in the kit (a removed/renamed source).
    Unknown,
    /// No provenance stamp — not a vendored kit file, left untouched.
    NotVendored,
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

/// The verbatim module source of a STORE component record for emit — its `source`, else its `srcText`,
/// whichever is non-empty first. `None` = a source-stripped builtin (#2794) or a spec-only record with
/// nothing to vendor, so the overlay leaves the packaged source (if any) in place.
fn component_source(c: &Value) -> Option<String> {
    for field in ["source", "srcText"] {
        if let Some(s) = c.get(field).and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            return Some(s.to_string());
        }
    }
    None
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
        // Provenance stamped, with the body hash the sync divergence check keys on.
        assert!(card.starts_with("// vendored from acme/kit@2.1.0 (sha256:"), "provenance header: {card}");
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
    fn stamp_round_trips_and_classify_reports_managed_up_to_date() {
        let kit = fixture();
        let card = kit.render_path("shared/ui/data/Card.tsx").unwrap();
        // The stamp parses back to the kit ref + a hash that IS the body's hash (a managed file).
        let stamp = parse_stamp(&card).expect("card is stamped");
        assert_eq!(stamp.kit_ref, "acme/kit@2.1.0");
        assert_eq!(stamp.body_sha256, crate::kit::sha256_hex(body_of(&card).as_bytes()));
        // A freshly-emitted file is UpToDate against the same kit — sync rewrites nothing.
        assert!(matches!(kit.classify("shared/ui/data/Card.tsx", &card), SyncVerdict::UpToDate));
    }

    #[test]
    fn classify_flags_a_hand_edited_file_diverged_and_never_rewrites_it() {
        let kit = fixture();
        let card = kit.render_path("shared/ui/data/Card.tsx").unwrap();
        // Hand-edit the BODY (append a line) — the body hash no longer matches the stamp.
        let edited = format!("{card}\n// a human tweaked this");
        assert!(matches!(kit.classify("shared/ui/data/Card.tsx", &edited), SyncVerdict::Diverged));
        // An unstamped file is simply not ours.
        assert!(matches!(kit.classify("shared/ui/data/Card.tsx", "export const X = 1;"), SyncVerdict::NotVendored));
    }

    #[test]
    fn classify_rewrites_a_managed_file_when_the_kit_moved_and_flags_a_dropped_path_unknown() {
        // Emit `card` from v1, then classify it against a v2 kit whose card source CHANGED. The file is
        // still MANAGED (body untouched), so the moved kit → a Rewrite with the fresh content.
        let v1 = fixture();
        let card_v1 = v1.render_path("shared/ui/data/Card.tsx").unwrap();
        let v2 = {
            let json = serde_json::json!({
                "id": "acme/kit", "version": "3.0.0",
                "components": [{ "id": "card", "src": "shared/ui/data/Card.tsx",
                    "source": "export const Card = () => \"v2\";" }],
                "runtime": {}
            });
            EmitKit::from_artifact(&json.to_string()).unwrap()
        };
        match v2.classify("shared/ui/data/Card.tsx", &card_v1) {
            SyncVerdict::Rewrite(fresh) => {
                assert!(fresh.contains("v2"), "rewrites to the current kit's source");
                assert!(fresh.starts_with("// vendored from acme/kit@3.0.0"), "re-stamped to the new version");
            }
            other => panic!("expected Rewrite, got {other:?}"),
        }
        // A managed file whose path the kit dropped is Unknown (nothing to re-render).
        let orphan = v1.render_path("shared/lib/core/format.ts").unwrap();
        assert!(matches!(v2.classify("shared/lib/core/format.ts", &orphan), SyncVerdict::Unknown));
    }

    #[test]
    fn from_store_emits_a_component_the_packaged_artifact_lacks() {
        // #3720: a react-d3 chart is NOT in the packaged react-ui artifact, so `emit component barchart`
        // used to fail 'unknown component'. Overlaid from the store, it emits from its own `srcText`.
        assert!(
            EmitKit::packaged().plan_component("barchart").is_err(),
            "precondition: the packaged artifact has no barchart"
        );
        let store = serde_json::json!([{
            "id": "barchart", "name": "BarChart", "kitId": "react-d3", "src": "shared/ui/charts/BarChart.tsx",
            "srcText": "import { scaleLinear } from \"d3-scale\";\nexport const BarChart = () => null;"
        }]);
        let plan = EmitKit::from_store(store.as_array().unwrap()).plan_component("barchart").unwrap();
        let file = plan.files.iter().find(|f| f.path == "shared/ui/charts/BarChart.tsx").expect("BarChart emitted");
        assert!(file.content.contains("export const BarChart"), "its store source is vendored: {}", file.content);
        assert!(file.content.starts_with("// vendored from bsc/studio@"), "stamped with the merged-view id");
        assert_eq!(plan.external_deps, vec!["d3-scale".to_string()], "its external dep is reported");
    }

    #[test]
    fn from_store_does_not_let_a_source_stripped_builtin_clobber_the_packaged_source() {
        // #2794: a builtin's store record has its `source` stripped. Overlaying that empty record must NOT
        // wipe the packaged source — `card` still emits with real content from the artifact.
        let stripped = serde_json::json!([{ "id": "card", "name": "Card", "kitId": "react-ui",
            "src": "shared/ui/data/Card.tsx", "source": "", "srcText": "" }]);
        let plan = EmitKit::from_store(stripped.as_array().unwrap()).plan_component("card").unwrap();
        let card = plan.files.iter().find(|f| f.path.ends_with("Card.tsx")).expect("card emitted");
        // The body (after the stamp line) is the packaged source — not empty.
        assert!(!body_of(&card.content).trim().is_empty(), "packaged card source survived the empty overlay");
        for f in &plan.files {
            assert!(!f.content.contains("@/"), "{} still has a first-party alias — closure incomplete", f.path);
        }
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
