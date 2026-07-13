//! Design-graph health analyzer (#2678, epic #2677) — the PURE traversal behind `bsc ui doctor`.
//!
//! The component library is a per-kit composition graph: nodes are components (`role`, `used` =
//! cross-codebase reuse count, `composes` = the names it depends on), edges are `composes`
//! (composer → dependency, resolved by-name WITHIN a kit). This module finds the dead/duplicated
//! design a growing kit accumulates — especially as the designer LLM authors components via
//! `bsc ui` — so the session can discover and prune it in ONE call.
//!
//! Pure: input is the parsed component records, output is a ranked `Vec<Finding>`. No I/O, so it's
//! unit-tested directly and the same taxonomy can be mirrored frontend-side for graph badges (#2680).
//!
//! Findings (most-severe first): **cycle** (a `composes` loop — also breaks the layered layout) ·
//! **dangling-branch** (an unused root that still pulls in dependencies) · **duplicate** (two
//! components wrapping the same intrinsic, or byte-identical source) · **no-implementation** (a
//! component the Design Studio preview can't build — a spec, not code) · **self-reference** (an
//! own-module component whose only rendered element is ITSELF, `<Name/>` — a self-referential stub
//! that passes the buildability + syntax gates yet produces no output, #3026) · **unresolvable-import** (a
//! module imports something the preview can't resolve — a bare npm package not in the import-map, #2934,
//! OR an internal `@/…`/relative import matching no kit component or runtime-closure module, #2954 —
//! throws "module not found" at preview time) · **orphan**
//! (an isolated, never-referenced primitive/composite) · **unwired-prop** (declares props its own source
//! never references — a declared interface that does nothing, #2924) · **slot-shell** (INFORMATIONAL — a
//! composite whose composed children arrive via ReactNode content slots, so a standalone preview renders
//! a demo placeholder, #2921). "Unused" = orphan ∪ dangling-branch — a node with no composer AND
//! `used == 0`; a `page`/`layout` with `used > 0` is a legit entry point, never flagged.
//!
//! The **no-implementation** check is artifact-aware: a store record strips a built-in's `source`
//! (#2794), so both built-ins and user specs look source-less in the store — but a built-in still
//! builds because its real code lives in the packaged react-ui artifact. So a node is buildable iff
//! its `src` is in that artifact (with `source`), OR it carries its own non-empty `source`, OR its
//! `srcText` is a real module (`looks_buildable_module`) — the exact `componentPreviewFiles` logic
//! (#2824/#2828). Only a node that is NONE of those is flagged (mirrors `graphHealth.ts`).

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// One health finding — LLM-consumable: what, where, why, and what to do about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// `cycle` | `dangling-branch` | `duplicate` | `no-implementation` | `unresolvable-import` |
    /// `orphan` | `unwired-prop` | `slot-shell`.
    pub category: &'static str,
    /// Higher = more severe; the report is sorted by this, descending.
    pub severity: u8,
    /// The kit the finding is scoped to.
    pub kit: String,
    /// The component id(s) involved (a cycle/duplicate/branch can span several).
    pub node_ids: Vec<String>,
    /// The component name(s), parallel to `node_ids` — the human/LLM-readable handle.
    pub node_names: Vec<String>,
    /// A one-line explanation of the finding.
    pub why: String,
    /// The concrete next step (e.g. which id to remove, or which to merge into which).
    pub suggested_action: String,
}

impl Finding {
    /// The finding as a JSON object (the `--json` report shape). Manual — the crate carries
    /// `serde_json` but not the `serde` derive.
    pub fn to_value(&self) -> Value {
        json!({
            "category": self.category,
            "severity": self.severity,
            "kit": self.kit,
            "nodeIds": self.node_ids,
            "nodeNames": self.node_names,
            "why": self.why,
            "suggestedAction": self.suggested_action,
        })
    }
}

/// A component record reduced to the fields the analyzer needs (parsed from the store JSON). Records
/// that don't parse to at least an id are skipped — the analyzer never crashes on an odd row.
struct Node {
    id: String,
    name: String,
    kit: String,
    role: String,
    used: i64,
    composes: Vec<String>,
    wraps: Option<String>,
    src_text: String,
    /// `src/`-relative source path — cross-referenced against the packaged artifact roster for the
    /// buildability check (a built-in's real code lives in the artifact even though the store strips it).
    src: String,
    /// The component's own implementation `source`, when it carries one (a user-authored module).
    /// The store strips a built-in's `source` (#2794), so this is empty for built-ins.
    source: String,
    /// `(name, type)` per prop — for the slot-shell check (a non-`children` ReactNode content slot).
    props: Vec<(String, String)>,
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn parse_node(v: &Value) -> Option<Node> {
    let id = v.get("id").and_then(Value::as_str)?.to_string();
    if id.is_empty() {
        return None;
    }
    Some(Node {
        name: {
            let n = s(v, "name");
            if n.is_empty() { id.clone() } else { n }
        },
        id,
        kit: s(v, "kitId"),
        role: {
            let r = s(v, "role");
            if r.is_empty() { "primitive".to_string() } else { r }
        },
        used: v.get("used").and_then(Value::as_i64).unwrap_or(0),
        composes: v
            .get("composes")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        wraps: v.get("wraps").and_then(Value::as_str).filter(|w| !w.is_empty()).map(str::to_string),
        src_text: s(v, "srcText"),
        src: s(v, "src"),
        source: s(v, "source"),
        props: v
            .get("props")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let name = p.get("name").and_then(Value::as_str)?.to_string();
                        let ty = p.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
                        Some((name, ty))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Is `(name, ty)` a CONTENT-SLOT prop — a non-`children` prop typed as a React node? Mirrors
/// `isNodeSlotProp` (graphHealth.ts) + how the preview samples props: a `reactnode`/`node`-typed prop is
/// filled with a placeholder standalone, so a component with one renders a demo (#2921).
fn is_node_slot_prop(name: &str, ty: &str) -> bool {
    if name == "children" {
        return false;
    }
    let t = ty.to_lowercase();
    t.contains("reactnode") || t.contains("node")
}

/// The packaged `bsc/react-ui` kit artifact — the SAME embedded `react-ui.json` the kit store + the
/// vendored-source emit read (`bsc_ui::kit::PACKAGED_KIT_JSON`). Embedded here too because this crate
/// can't depend on `bsc-ui` (that edge would cycle), so the buildability check can cross-reference a
/// component's `src` against the artifact roster with no fs/network — exactly like the frontend's raw
/// `@data/components/react-ui.json` import that `componentPreviewFiles` resolves a built-in against.
const PACKAGED_KIT_JSON: &str = include_str!("../../../src-tauri/data/components/react-ui.json");

/// The preview import-map (`src-tauri/data/ui/preview-importmap.json`) — the SAME json the frontend
/// `componentBundle` uses. Its KEYS are the specifiers the preview iframe can resolve; a bare import not
/// among them throws "Failed to resolve module specifier" at preview time (#2934). Embedded so the
/// static `unresolvable-import` check runs with no fs/network — the Rust twin of `graphHealth.ts`.
const PREVIEW_IMPORTMAP_JSON: &str = include_str!("../../../src-tauri/data/ui/preview-importmap.json");

/// The set of specifiers the preview can resolve — the import-map's keys. Cached; a malformed map yields
/// an empty set (so the check flags nothing — fail safe, never a false alarm).
fn resolvable_specifiers() -> &'static BTreeSet<String> {
    static KEYS: std::sync::OnceLock<BTreeSet<String>> = std::sync::OnceLock::new();
    KEYS.get_or_init(|| {
        serde_json::from_str::<Value>(PREVIEW_IMPORTMAP_JSON)
            .ok()
            .as_ref()
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    })
}

/// Is `spec` a BARE package specifier — not a relative (`.`/`..`), absolute (`/`), first-party (`@/`),
/// or an absolute URL? Only bare specifiers resolve through the preview import-map. Mirrors
/// `isBareSpecifier` (TS).
fn is_bare_specifier(spec: &str) -> bool {
    !spec.starts_with('.') && !spec.starts_with('/') && !spec.starts_with("@/") && !is_url_specifier(spec)
}

/// Is `spec` an ABSOLUTE URL — a `scheme:` prefix (the first `:` sits before any `/`, e.g. `https:`,
/// `http:`, `data:`)? Such a specifier resolves DIRECTLY in the preview iframe (the import-map's own
/// values ARE esm.sh URLs), so it needs no import-map entry and must never be flagged as an unresolvable
/// bare import (#2963). Mirrors `isUrlSpecifier` (TS). (Protocol-relative `//` is already excluded by the
/// leading-`/` check in `is_bare_specifier`.)
fn is_url_specifier(spec: &str) -> bool {
    match (spec.find(':'), spec.find('/')) {
        (Some(colon), Some(slash)) => colon < slash, // a scheme (`https:`) before any path `/`
        (Some(_), None) => true,                     // `data:…` with no slash
        _ => false,
    }
}

/// Every module specifier imported/exported-from in `source` — `import … from "X"`, `export … from "X"`,
/// `import "X"`, `import("X")`. A hand scanner (no regex dep): track the last identifier and, when a
/// string literal opens in normal code, capture it iff the last word was `from` or `import`. String +
/// line/block-comment state is tracked so a quote inside a comment/string is never captured. Deliberately
/// loose — over-inclusion is harmless (the caller flags only BARE unresolved specifiers). Rust twin of
/// `importSpecifiers` (TS).
fn import_specifiers(source: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let n = chars.len();
    let mut i = 0;
    let mut out = Vec::new();
    let mut last_word = String::new();
    let is_id = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    while i < n {
        let c = chars[i];
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            i += 2;
            while i < n && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            i += 2;
            while i < n && !(chars[i] == '*' && i + 1 < n && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if c == '"' || c == '\'' || c == '`' {
            let quote = c;
            i += 1;
            let start = i;
            while i < n && chars[i] != quote {
                if chars[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            if last_word == "from" || last_word == "import" {
                out.push(chars[start..i.min(n)].iter().collect());
            }
            i += 1; // past the closing quote (or EOF)
            last_word.clear(); // a string is not an identifier
        } else if is_id(c) {
            let mut w = String::new();
            while i < n && is_id(chars[i]) {
                w.push(chars[i]);
                i += 1;
            }
            last_word = w;
        } else {
            // A non-identifier char (whitespace, `(`, `;`, …) — keep `last_word` so `import(` / `import "x"`
            // still see the `import` keyword.
            i += 1;
        }
    }
    out
}

/// The set of packaged-artifact component `src` paths that ship a real implementation `source` — the
/// "buildable roster" the Design Studio preview (`componentPreviewFiles`, #2824) resolves a built-in
/// against. Cached: parsed once from the embedded artifact.
fn buildable_srcs() -> &'static BTreeSet<String> {
    static ROSTER: std::sync::OnceLock<BTreeSet<String>> = std::sync::OnceLock::new();
    ROSTER.get_or_init(|| artifact_buildable_srcs(PACKAGED_KIT_JSON))
}

/// Collect the `src` of every component in a kit-artifact JSON that carries a non-empty `source` (a
/// real implementation file) — mirrors the `comp.src === c.src && c.source` artifact match in
/// `componentPreviewFiles`. Pure over the JSON text (testable without the embed); a malformed artifact
/// yields an empty roster, so the check just falls back to own-source / srcText — fail safe.
fn artifact_buildable_srcs(artifact_json: &str) -> BTreeSet<String> {
    let Ok(v) = serde_json::from_str::<Value>(artifact_json) else {
        return BTreeSet::new();
    };
    v.get("components")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let src = c.get("src").and_then(Value::as_str).filter(|s| !s.is_empty())?;
            let has_source = c.get("source").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
            has_source.then(|| src.to_string())
        })
        .collect()
}

/// The runtime-closure module paths a kit artifact vendors (#2798/#2954) — the KEYS of its `runtime`
/// object (support modules like `shared/ui/typography/type.ts` the preview resolves a built-in's `@/`
/// or RELATIVE import against). Pure over the JSON text (testable without the embed); a malformed
/// artifact yields an empty set, so the internal-import check just flags nothing — fail safe.
fn artifact_runtime_paths(artifact_json: &str) -> BTreeSet<String> {
    serde_json::from_str::<Value>(artifact_json)
        .ok()
        .as_ref()
        .and_then(|v| v.get("runtime"))
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

/// The set an INTERNAL import can resolve to at preview time (#2954): every packaged built-in that ships
/// a real `source` (a `composes` sibling the preview vendors) PLUS every runtime-closure support module.
/// Cached from the embedded artifact. The per-kit check unions in this kit's own component `src` paths so
/// composing a sibling in the SAME kit (built-in or user) also resolves.
fn internal_targets() -> &'static BTreeSet<String> {
    static T: std::sync::OnceLock<BTreeSet<String>> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let mut s = artifact_buildable_srcs(PACKAGED_KIT_JSON);
        s.extend(artifact_runtime_paths(PACKAGED_KIT_JSON));
        s
    })
}

/// Is `spec` an INTERNAL first-party import — a `@/…` alias or a RELATIVE (`./`, `../`) path — as opposed
/// to a bare npm specifier or an absolute path? These resolve against the kit's components + runtime
/// closure, not the preview import-map. Mirrors `isInternalSpecifier` (TS).
fn is_internal_specifier(spec: &str) -> bool {
    spec.starts_with("@/") || spec.starts_with("./") || spec.starts_with("../")
}

/// Resolve an INTERNAL import `spec` — imported FROM module `from_rel` (a `src/`-relative path) — to its
/// `src/`-relative module BASE (no extension), or `None` when it isn't internal. `@/x` → `x`; a relative
/// path is joined onto the importer's directory and `.`/`..` segments collapsed. Mirrors the closure
/// walker's resolver (reactUiKit.gen.test.ts) and `resolveInternalBase` (TS).
fn resolve_internal_base(spec: &str, from_rel: &str) -> Option<String> {
    let segs: Vec<&str> = if let Some(rest) = spec.strip_prefix("@/") {
        rest.split('/').collect()
    } else if spec.starts_with("./") || spec.starts_with("../") {
        let from_dir = from_rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        from_dir.split('/').chain(spec.split('/')).collect()
    } else {
        return None;
    };
    let mut out: Vec<&str> = Vec::new();
    for seg in segs {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            _ => out.push(seg),
        }
    }
    Some(out.join("/"))
}

/// Does an INTERNAL import `spec` (from module `from_rel`) resolve to a component or runtime module the
/// preview provides (`targets`)? Tries TS module-resolution order (`.ts`/`.tsx`/`/index.ts`/`/index.tsx`)
/// over the importer-relative base. A NON-internal spec returns `true` — it isn't this check's concern
/// (the bare-specifier check owns npm resolution). Mirrors `resolvesInternal` (TS).
fn resolves_internal(spec: &str, from_rel: &str, targets: &BTreeSet<String>) -> bool {
    let Some(base) = resolve_internal_base(spec, from_rel) else {
        return true;
    };
    [".ts", ".tsx", "/index.ts", "/index.tsx"]
        .iter()
        .any(|ext| targets.contains(&format!("{base}{ext}")))
}

/// Whether a component has a buildable implementation the Design Studio preview can render — the Rust
/// mirror of `componentPreviewFiles(comp, artifact) !== null` (componentPreview.ts, #2824/#2828).
/// Buildable iff: its `src` is a packaged-artifact component shipping a real `source` (a BUILT-IN — its
/// code lives in the artifact even though the store strips it, #2794), OR it carries its own non-empty
/// `source`, OR its `srcText` is a real module rather than a usage snippet (`looks_buildable_module`).
fn is_buildable(node: &Node, buildable: &BTreeSet<String>) -> bool {
    (!node.src.is_empty() && buildable.contains(&node.src))
        || !node.source.trim().is_empty()
        || looks_buildable_module(&node.src_text)
}

/// Rust port of `looksBuildableModule` (componentPreview.ts, #2828): does `src_text` look like a
/// self-contained, buildable component MODULE rather than the usual usage snippet? Conservative — it
/// must declare an `export`, contain no `…` usage-snippet placeholder, and use no `@/` first-party
/// import (which has no dependency closure to resolve against here). MUST stay in lockstep with the TS
/// twin — both gate the SAME preview build. Crate-visible so the write-time syntax gate (#2928) reuses
/// the SAME "is this a module?" test to decide whether to syntax-check a `srcText`.
pub(crate) fn looks_buildable_module(src_text: &str) -> bool {
    let s = src_text.trim();
    !s.is_empty()
        && contains_word(s, "export") // an export for the bootstrap to import + mount
        && !s.contains('…') // the `…` usage-snippet placeholder won't compile
        && !s.contains("\"@/") // a `@/` first-party import — no closure to resolve it against here
        && !s.contains("'@/")
}

/// Whether `needle` appears in `haystack` as a whole word (the JS `\bword\b` the TS twin uses) —
/// bounded by a non-word char (`[^A-Za-z0-9_]`) or the string edge on each side.
fn contains_word(haystack: &str, needle: &str) -> bool {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(needle) {
        let at = from + rel;
        let before_ok = haystack[..at].chars().next_back().is_none_or(|c| !is_word(c));
        let after = at + needle.len();
        let after_ok = haystack[after..].chars().next().is_none_or(|c| !is_word(c));
        if before_ok && after_ok {
            return true;
        }
        from = at + 1;
    }
    false
}

/// Whether `source` DECLARES the symbol `name` — a `function`/`const`/`let`/`var`/`class` binding of it
/// (`export function Foo` / `const Foo =` / …), not a mere reference. Distinguishes a module that DEFINES
/// the component from a bare usage snippet that only calls it. Mirrors `declaresSymbol` (graphHealth.ts).
fn declares_symbol(source: &str, name: &str) -> bool {
    ["function ", "const ", "let ", "var ", "class "].iter().any(|kw| {
        let needle = format!("{kw}{name}");
        let mut from = 0;
        while let Some(rel) = source[from..].find(&needle) {
            let at = from + rel;
            let after = at + needle.len();
            let after_ok =
                source[after..].chars().next().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
            if after_ok {
                return true;
            }
            from = at + 1;
        }
        false
    })
}

/// The set of JSX element/component tag names OPENED in `source` — every `<Ident` that is not a closing
/// `</…` tag. (A TS generic like `<Number>` lands here too, which only makes the self-reference check
/// MORE conservative — a stub carrying a generic simply isn't flagged.) Mirrors `jsxTagNames` (graphHealth.ts).
fn jsx_tag_names(source: &str) -> BTreeSet<String> {
    let bytes = source.as_bytes();
    let mut set = BTreeSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' && i + 1 < bytes.len() && (bytes[i + 1] as char).is_ascii_alphabetic() {
            let start = i + 1;
            let mut k = start;
            while k < bytes.len() && ((bytes[k] as char).is_ascii_alphanumeric() || bytes[k] == b'_') {
                k += 1;
            }
            set.insert(source[start..k].to_string());
            i = k;
            continue;
        }
        i += 1;
    }
    set
}

/// Whether `node` is a SELF-REFERENTIAL STUB — an own-module component that declares its own name yet the
/// ONLY element it renders is itself (`<Name/>`). It passes `looks_buildable_module` (it has an `export`)
/// so `no-implementation` is blind to it, and it's syntactically valid so the write-time gate accepts it —
/// but it produces no real output and recurses forever. Mirrors `isSelfReferentialStub` (graphHealth.ts).
fn is_self_referential_stub(node: &Node) -> bool {
    // The component's OWN module source: its `source`, else a `srcText` that is a real module. A
    // non-module usage snippet is already `no-implementation`; a built-in's stripped source isn't ours.
    let src = if !node.source.trim().is_empty() {
        node.source.as_str()
    } else if looks_buildable_module(&node.src_text) {
        node.src_text.as_str()
    } else {
        return false;
    };
    if node.name.is_empty() || !declares_symbol(src, &node.name) {
        return false;
    }
    let tags = jsx_tag_names(src);
    tags.len() == 1 && tags.contains(&node.name)
}

/// Analyze the component records for graph-health findings, grouped and scoped PER KIT (edges only
/// resolve within a kit). Returns a ranked list, most-severe first (stable tiebreak: kit, then the
/// first node name), so the same input always yields the same ordering.
pub fn analyze(components: &[Value]) -> Vec<Finding> {
    let nodes: Vec<Node> = components.iter().filter_map(parse_node).collect();
    let mut by_kit: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for n in &nodes {
        by_kit.entry(n.kit.as_str()).or_default().push(n);
    }
    let buildable = buildable_srcs();
    let mut out = Vec::new();
    for (kit, kit_nodes) in by_kit {
        analyze_kit(kit, &kit_nodes, buildable, &mut out);
    }
    out.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.kit.cmp(&b.kit))
            .then_with(|| a.node_names.first().cmp(&b.node_names.first()))
    });
    out
}

/// A component safe to prune (#2679) — a finding root the confirm-gated `--fix` may remove.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prunable {
    pub id: String,
    pub name: String,
    pub reason: String,
}

/// The safe-to-remove set (#2679): the ROOT of every orphan / dangling-branch finding — a node with
/// no composer and `used == 0`. Deliberately NOT the branch DESCENDANTS (one might be shared by a live
/// component): removing the roots and re-running `doctor` surfaces any newly-orphaned children on the
/// next pass. Cycles, duplicates, and no-implementation findings are never auto-pruned (they need a
/// human's merge/break/author call). By construction a `used > 0` node can never appear here.
pub fn prunable(components: &[Value]) -> Vec<Prunable> {
    analyze(components)
        .into_iter()
        .filter_map(|f| match f.category {
            "orphan" | "dangling-branch" => Some(Prunable {
                id: f.node_ids.into_iter().next()?,
                name: f.node_names.into_iter().next().unwrap_or_default(),
                reason: f.why,
            }),
            _ => None,
        })
        .collect()
}

fn analyze_kit(kit: &str, nodes: &[&Node], buildable: &BTreeSet<String>, out: &mut Vec<Finding>) {
    // Name → id (in-kit). A duplicate NAME would collide; the store keys by id, so we keep the first.
    let mut id_by_name: BTreeMap<&str, &str> = BTreeMap::new();
    for n in nodes {
        id_by_name.entry(n.name.as_str()).or_insert(n.id.as_str());
    }
    // Resolved edges (composer id → dependency id) + in/out degree by id.
    let mut out_ids: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut in_deg: BTreeMap<&str, usize> = BTreeMap::new();
    for n in nodes {
        in_deg.entry(n.id.as_str()).or_insert(0);
    }
    for n in nodes {
        for dep_name in &n.composes {
            if let Some(&dep_id) = id_by_name.get(dep_name.as_str()) {
                out_ids.entry(n.id.as_str()).or_default().push(dep_id);
                *in_deg.entry(dep_id).or_insert(0) += 1;
            }
        }
    }
    let node_by_id: BTreeMap<&str, &&Node> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let name_of = |id: &str| node_by_id.get(id).map(|n| n.name.clone()).unwrap_or_default();

    // ── cycles (severity 4) — a `composes` loop; report each SCC of size > 1 (or a self-loop).
    for scc in strongly_connected(nodes, &out_ids) {
        let is_cycle = scc.len() > 1 || out_ids.get(scc[0]).is_some_and(|d| d.contains(&scc[0]));
        if !is_cycle {
            continue;
        }
        let names: Vec<String> = scc.iter().map(|id| name_of(id)).collect();
        out.push(Finding {
            category: "cycle",
            severity: 4,
            kit: kit.to_string(),
            node_ids: scc.iter().map(|s| s.to_string()).collect(),
            node_names: names.clone(),
            why: format!("these components form a `composes` cycle: {}", names.join(" → ")),
            suggested_action: "break the loop — a composition graph must be acyclic (it also breaks the layered layout)".to_string(),
        });
    }

    // ── no-implementation (severity 3): a component the Design Studio preview can't build
    // (componentPreviewFiles → null) — it's a spec, not code. The store strips a built-in's artifact
    // `source` (#2794), so a BUILT-IN looks source-less yet builds from the packaged artifact; only a
    // node in NEITHER the artifact roster NOR carrying its own module/`source` is flagged (a user-
    // authored spec, e.g. a `page` like GraphExplorerPage). Independent of used/role/degree — an
    // unrenderable node is always flagged. Mirrors the frontend `analyzeGraphHealth` (graphHealth.ts).
    for n in nodes {
        if is_buildable(n, buildable) {
            continue;
        }
        out.push(Finding {
            category: "no-implementation",
            severity: 3,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` has no buildable implementation — the preview can't render it (a spec, not code)",
                n.name
            ),
            suggested_action: format!(
                "author a self-contained module for `{}` (its own `source`/`srcText`) or compose it from built-in kit components",
                n.name
            ),
        });
    }

    // ── self-reference (severity 3): an own-module component whose only rendered element is ITSELF
    // (`<Name/>`). It passes the buildability check (it has an `export`, so no-implementation is blind to
    // it) and the write-time syntax gate (it's valid), yet it produces no output and recurses forever —
    // the class the designer hit authoring D3 components as self-calls (#3026).
    for n in nodes {
        if !is_self_referential_stub(n) {
            continue;
        }
        out.push(Finding {
            category: "self-reference",
            severity: 3,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` only renders itself (`<{}/>`) — a self-referential stub, not a real implementation (it produces no output and recurses forever)",
                n.name, n.name
            ),
            suggested_action: format!(
                "replace `{}`'s source with its REAL body — the elements/state/effects that produce its output — never a call to `<{}>`",
                n.name, n.name
            ),
        });
    }

    // ── dead roots: in-degree 0 AND used == 0, excluding a page/layout entry point kept alive by use.
    for n in nodes {
        let indeg = *in_deg.get(n.id.as_str()).unwrap_or(&0);
        let outdeg = out_ids.get(n.id.as_str()).map(Vec::len).unwrap_or(0);
        if indeg != 0 || n.used != 0 {
            continue;
        }
        if outdeg == 0 {
            // ── orphan (severity 2) — an isolated primitive/composite nobody composes or uses.
            if n.role == "primitive" || n.role == "composite" {
                out.push(Finding {
                    category: "orphan",
                    severity: 2,
                    kit: kit.to_string(),
                    node_ids: vec![n.id.clone()],
                    node_names: vec![n.name.clone()],
                    why: format!("`{}` is isolated (nothing composes it) and unused (used = 0)", n.name),
                    suggested_action: format!("prune it — `bsc ui remove {}` (confirm-gated)", n.id),
                });
            }
            // A dead isolated page/layout is unusual (a stray screen); leave it for the human — it's
            // an entry point by role, so we don't auto-flag it as prunable.
        } else {
            // ── dangling-branch (severity 3) — an unused root that still pulls in dependencies.
            let mut reachable = BTreeSet::new();
            collect_reachable(n.id.as_str(), &out_ids, &mut reachable);
            reachable.remove(n.id.as_str());
            let mut ids = vec![n.id.clone()];
            let mut names = vec![n.name.clone()];
            for id in &reachable {
                ids.push(id.to_string());
                names.push(name_of(id));
            }
            out.push(Finding {
                category: "dangling-branch",
                severity: 3,
                kit: kit.to_string(),
                node_ids: ids,
                node_names: names,
                why: format!(
                    "`{}` is an unused root (nothing composes it, used = 0) that pulls in {} dependenc{}",
                    n.name,
                    reachable.len(),
                    if reachable.len() == 1 { "y" } else { "ies" }
                ),
                suggested_action: format!(
                    "prune the branch from its root `{}` — check each dependency isn't shared before removing",
                    n.name
                ),
            });
        }
    }

    // ── duplicates (severity 3): two components wrapping the SAME intrinsic, or byte-identical source.
    let mut by_wraps: BTreeMap<&str, Vec<&&Node>> = BTreeMap::new();
    for n in nodes {
        if let Some(w) = &n.wraps {
            by_wraps.entry(w.as_str()).or_default().push(n);
        }
    }
    for (intrinsic, group) in by_wraps {
        if group.len() < 2 {
            continue;
        }
        let names: Vec<String> = group.iter().map(|n| n.name.clone()).collect();
        // Suggest keeping the most-used one as the merge target.
        let target = group.iter().max_by_key(|n| n.used).map(|n| n.name.clone()).unwrap_or_default();
        out.push(Finding {
            category: "duplicate",
            severity: 3,
            kit: kit.to_string(),
            node_ids: group.iter().map(|n| n.id.clone()).collect(),
            node_names: names.clone(),
            why: format!("{} components all wrap the raw `<{}>`: {}", group.len(), intrinsic, names.join(", ")),
            suggested_action: format!("merge into `{target}` (the most-used) and repoint the others"),
        });
    }
    // Byte-identical source (a stronger duplicate signal than `wraps`).
    let mut by_src: BTreeMap<&str, Vec<&&Node>> = BTreeMap::new();
    for n in nodes {
        if !n.src_text.trim().is_empty() {
            by_src.entry(n.src_text.as_str()).or_default().push(n);
        }
    }
    for (_src, group) in by_src {
        if group.len() < 2 {
            continue;
        }
        let names: Vec<String> = group.iter().map(|n| n.name.clone()).collect();
        let target = group.iter().max_by_key(|n| n.used).map(|n| n.name.clone()).unwrap_or_default();
        out.push(Finding {
            category: "duplicate",
            severity: 3,
            kit: kit.to_string(),
            node_ids: group.iter().map(|n| n.id.clone()).collect(),
            node_names: names.clone(),
            why: format!("{} components have byte-identical source: {}", group.len(), names.join(", ")),
            suggested_action: format!("merge into `{target}` (the most-used) and repoint the others"),
        });
    }

    // ── unresolvable-import (severity 3): a component whose module imports something the preview CAN'T
    // resolve — the class `bsc ui doctor` was blind to (the static graph looked clean while the component
    // was broken). Two kinds, both flagged here (#2934 bare, #2954 internal):
    //   • BARE — an npm package not in the preview import-map → the iframe throws "Failed to resolve
    //     module specifier".
    //   • INTERNAL — a `@/…` or RELATIVE import resolving to NEITHER a kit component NOR a runtime-closure
    //     module → "module not found" (exactly the `Code`→`../typography/type` / `Skeleton`→`./shimmer`
    //     failure #2954 fixed in the packaged closure; this catches any future/user-authored recurrence).
    // Scanned on own-source components (a built-in's `source`, or a `looks_buildable_module` srcText) — the
    // source the preview actually builds. Mirrors `graphHealth.ts`.
    let mut targets = internal_targets().clone();
    targets.extend(nodes.iter().map(|n| n.src.clone()).filter(|s| !s.is_empty()));
    for n in nodes {
        let src = if !n.source.trim().is_empty() {
            n.source.as_str()
        } else if looks_buildable_module(&n.src_text) {
            n.src_text.as_str()
        } else {
            continue;
        };
        let resolvable = resolvable_specifiers();
        let specs = import_specifiers(src);
        let mut bare: Vec<String> =
            specs.iter().filter(|s| is_bare_specifier(s) && !resolvable.contains(*s)).cloned().collect();
        let mut internal: Vec<String> = specs
            .iter()
            .filter(|s| is_internal_specifier(s) && !resolves_internal(s, &n.src, &targets))
            .cloned()
            .collect();
        for v in [&mut bare, &mut internal] {
            v.sort();
            v.dedup();
        }
        if bare.is_empty() && internal.is_empty() {
            continue;
        }
        let fmt = |v: &[String]| v.iter().map(|s| format!("`{s}`")).collect::<Vec<_>>().join(", ");
        let mut reasons = Vec::new();
        let mut actions = Vec::new();
        if !bare.is_empty() {
            reasons.push(format!("{} (no preview import-map entry)", fmt(&bare)));
            actions.push(format!(
                "pin {} in the preview import-map (src-tauri/data/ui/preview-importmap.json) or drop it",
                fmt(&bare)
            ));
        }
        if !internal.is_empty() {
            reasons.push(format!("{} (no such module in the kit or its runtime closure)", fmt(&internal)));
            actions.push(format!("fix or add the module for {} (it resolves to no kit component or runtime file)", fmt(&internal)));
        }
        out.push(Finding {
            category: "unresolvable-import",
            severity: 3,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` imports {} — the preview can't resolve it, so it throws \"module not found\" when rendered",
                n.name,
                reasons.join("; ")
            ),
            suggested_action: actions.join("; "),
        });
    }

    // ── unwired-prop (severity 2): a component that declares props its OWN module source never references
    // — a declared interface that does nothing (#2924). Only for a node whose own source is present (a
    // user-authored module: its `source`, or a buildable `srcText`); a built-in (source in the artifact)
    // or a spec (no buildable module) is skipped. Guard: require ≥1 prop REFERENCED (so it uses NAMED
    // props — not a `{...props}` spreader) before flagging the unreferenced ones. Mirrors `graphHealth.ts`.
    for n in nodes {
        let src = if !n.source.trim().is_empty() {
            n.source.as_str()
        } else if looks_buildable_module(&n.src_text) {
            n.src_text.as_str()
        } else {
            continue;
        };
        if n.props.is_empty() || !n.props.iter().any(|p| contains_word(src, &p.0)) {
            continue; // no props, or none referenced (a spreader) → conservative skip
        }
        let unwired: Vec<&str> =
            n.props.iter().filter(|p| !contains_word(src, &p.0)).map(|p| p.0.as_str()).collect();
        if unwired.is_empty() {
            continue;
        }
        out.push(Finding {
            category: "unwired-prop",
            severity: 2,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` declares prop{} its source never uses: {} — a declared interface that does nothing",
                n.name,
                if unwired.len() == 1 { "" } else { "s" },
                unwired.join(", ")
            ),
            suggested_action: format!(
                "wire {} into `{}`'s implementation, or drop {} from its props",
                unwired.join(", "),
                n.name,
                if unwired.len() == 1 { "it" } else { "them" }
            ),
        });
    }

    // ── slot-shell (severity 1, INFORMATIONAL): a composite whose composed children arrive via ReactNode
    // CONTENT SLOTS. Standalone (no slots passed) it renders a demo/placeholder fallback, not its
    // assembled function — so a preview looks non-functional even though it isn't (#2921). Explains e.g.
    // GraphExplorerPage / AnalyticsPage. Detect: it `composes` ≥1 child AND exposes ≥1 non-`children`
    // ReactNode slot prop. Mirrors the frontend `analyzeGraphHealth` (graphHealth.ts).
    for n in nodes {
        if n.composes.is_empty() {
            continue;
        }
        let slots: Vec<&str> =
            n.props.iter().filter(|p| is_node_slot_prop(&p.0, &p.1)).map(|p| p.0.as_str()).collect();
        if slots.is_empty() {
            continue;
        }
        out.push(Finding {
            category: "slot-shell",
            severity: 1,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` is a slot-driven composite — its composed children ({}) arrive via content slots ({}), so a standalone preview renders a demo placeholder, not its assembled function",
                n.name,
                n.composes.join(", "),
                slots.join(", ")
            ),
            suggested_action: format!(
                "to preview `{}`'s real function, fill its slots ({}) with instances of the components it composes ({})",
                n.name,
                slots.join(", "),
                n.composes.join(", ")
            ),
        });
    }
}

/// Collect every id reachable from `start` along `out_ids` (DFS, cycle-safe via the visited set).
fn collect_reachable<'a>(
    start: &'a str,
    out_ids: &BTreeMap<&'a str, Vec<&'a str>>,
    visited: &mut BTreeSet<&'a str>,
) {
    if !visited.insert(start) {
        return;
    }
    if let Some(deps) = out_ids.get(start) {
        for &d in deps {
            collect_reachable(d, out_ids, visited);
        }
    }
}

/// Tarjan's strongly-connected components over the resolved `composes` edges — the SCCs of size > 1
/// (and self-loops) are the cycles. Deterministic: nodes are visited in the input order.
fn strongly_connected<'a>(nodes: &[&'a Node], out_ids: &BTreeMap<&'a str, Vec<&'a str>>) -> Vec<Vec<&'a str>> {
    struct T<'a> {
        idx: BTreeMap<&'a str, usize>,
        low: BTreeMap<&'a str, usize>,
        on_stack: BTreeSet<&'a str>,
        stack: Vec<&'a str>,
        counter: usize,
        sccs: Vec<Vec<&'a str>>,
    }
    fn strong<'a>(v: &'a str, out_ids: &BTreeMap<&'a str, Vec<&'a str>>, t: &mut T<'a>) {
        t.idx.insert(v, t.counter);
        t.low.insert(v, t.counter);
        t.counter += 1;
        t.stack.push(v);
        t.on_stack.insert(v);
        if let Some(deps) = out_ids.get(v) {
            for &w in deps {
                if !t.idx.contains_key(w) {
                    strong(w, out_ids, t);
                    let lw = t.low[w];
                    let e = t.low.get_mut(v).unwrap();
                    *e = (*e).min(lw);
                } else if t.on_stack.contains(w) {
                    let iw = t.idx[w];
                    let e = t.low.get_mut(v).unwrap();
                    *e = (*e).min(iw);
                }
            }
        }
        if t.low[v] == t.idx[v] {
            let mut comp = Vec::new();
            while let Some(w) = t.stack.pop() {
                t.on_stack.remove(w);
                comp.push(w);
                if w == v {
                    break;
                }
            }
            t.sccs.push(comp);
        }
    }
    let mut t = T {
        idx: BTreeMap::new(),
        low: BTreeMap::new(),
        on_stack: BTreeSet::new(),
        stack: Vec::new(),
        counter: 0,
        sccs: Vec::new(),
    };
    for n in nodes {
        if !t.idx.contains_key(n.id.as_str()) {
            strong(n.id.as_str(), out_ids, &mut t);
        }
    }
    t.sccs
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A buildable component fixture — it carries its own `source` (a real module), so the
    // no-implementation check never fires on it and the topology tests below stay about topology.
    // (The no-implementation-specific tests build their own deliberately source-less fixtures.)
    fn comp(id: &str, role: &str, used: i64, composes: &[&str]) -> Value {
        json!({ "id": id, "name": id, "kitId": "k", "role": role, "used": used,
                "composes": composes, "srcText": format!("src-{id}"),
                "source": "export const C = () => null;" })
    }

    fn cats(fs: &[Finding]) -> Vec<&str> {
        fs.iter().map(|f| f.category).collect()
    }

    #[test]
    fn a_clean_kit_has_no_findings() {
        // Page → Card → Button, all used; nothing dead or duplicated.
        let comps = [
            comp("page", "page", 1, &["Card"]),
            json!({ "id": "Card", "name": "Card", "kitId": "k", "role": "composite", "used": 3, "composes": ["Button"], "srcText": "card", "source": "export const C = () => null;" }),
            json!({ "id": "Button", "name": "Button", "kitId": "k", "role": "primitive", "used": 9, "composes": [], "srcText": "btn", "source": "export const C = () => null;" }),
        ];
        assert!(analyze(&comps).is_empty());
    }

    #[test]
    fn flags_an_isolated_unused_primitive_as_an_orphan() {
        let comps = [
            comp("Button", "primitive", 5, &[]),
            comp("Ghost", "primitive", 0, &[]), // isolated + unused
        ];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["orphan"]);
        assert_eq!(fs[0].node_names, ["Ghost"]);
    }

    #[test]
    fn flags_a_self_referential_stub_but_not_a_real_module_or_a_snippet() {
        let comps = [
            // A self-call: it has an `export` (so it's "buildable") and is valid syntax, but the only
            // element it renders is itself — the exact designer failure (#3026). `used: 1` so it isn't
            // also a dead-root orphan, keeping the assertion about self-reference alone.
            json!({ "id":"D3Chart", "name":"D3Chart", "kitId":"k", "role":"composite", "used":1, "composes":[],
                    "srcText":"export function D3Chart(props){ return <D3Chart {...props} />; }" }),
            // A REAL module — renders its own `<svg>`, never itself: NOT a self-reference.
            json!({ "id":"Spark", "name":"Spark", "kitId":"k", "role":"composite", "used":2, "composes":[],
                    "srcText":"import { useRef } from \"react\";\nexport function Spark(){ const r = useRef(null); return <svg ref={r} />; }" }),
            // A bare usage snippet — no `export` → already `no-implementation`, never double-flagged.
            json!({ "id":"Usage", "name":"Usage", "kitId":"k", "role":"composite", "used":1, "composes":[],
                    "srcText":"<Usage data={[1,2,3]} />" }),
        ];
        let fs = analyze(&comps);
        let self_ref: Vec<&str> = fs
            .iter()
            .filter(|f| f.category == "self-reference")
            .flat_map(|f| f.node_names.iter().map(String::as_str))
            .collect();
        assert_eq!(self_ref, ["D3Chart"], "only the self-call is a self-reference");
        assert!(!fs.iter().any(|f| f.node_names.contains(&"Spark".to_string())), "a real module isn't flagged");
        let usage = fs.iter().find(|f| f.node_names.contains(&"Usage".to_string())).expect("Usage flagged");
        assert_eq!(usage.category, "no-implementation", "a bare snippet is no-implementation, not self-reference");
        let f = fs.iter().find(|f| f.category == "self-reference").unwrap();
        assert_eq!(f.severity, 3);
        assert!(f.why.contains("renders itself"), "why names the failure");
    }

    #[test]
    fn import_specifiers_extracts_from_import_export_and_dynamic_but_not_comments() {
        let src = "import React from \"react\";\nimport { a } from \"d3-scale\";\nexport * from \"./local\";\n\
                   const x = import(\"lucide-react\");\n// import \"commented-out\"\nconst s = \"not-an-import\";";
        let specs = import_specifiers(src);
        assert!(specs.contains(&"react".to_string()));
        assert!(specs.contains(&"d3-scale".to_string()));
        assert!(specs.contains(&"./local".to_string()));
        assert!(specs.contains(&"lucide-react".to_string()));
        assert!(!specs.contains(&"commented-out".to_string()), "a comment's string is not captured");
        assert!(!specs.contains(&"not-an-import".to_string()), "a plain string is not an import");
    }

    #[test]
    fn flags_a_user_component_importing_a_preview_unresolvable_package() {
        // Imports d3-scale (NOT in the preview import-map) alongside react + lucide-react (both pinned).
        let comps = [json!({
            "id":"chart", "name":"Chart", "kitId":"k", "role":"composite", "used":2, "composes":[],
            "srcText":"import React from \"react\";\nimport { scaleLinear } from \"d3-scale\";\nimport { Icon } from \"lucide-react\";\nexport function Chart(){ return React.createElement(Icon, null, scaleLinear); }"
        })];
        let fs = analyze(&comps);
        let f = fs.iter().find(|f| f.category == "unresolvable-import").expect("flagged");
        assert_eq!(f.severity, 3);
        assert!(f.why.contains("d3-scale"), "names the unresolvable specifier");
        assert!(!f.why.contains("`react`") && !f.why.contains("`lucide-react`"), "pinned imports not listed");
        assert!(f.suggested_action.contains("preview-importmap"));
    }

    #[test]
    fn does_not_flag_unresolvable_import_when_all_resolve_or_for_a_snippet() {
        let comps = [
            json!({ "id":"fine", "name":"Fine", "kitId":"k", "role":"composite", "used":2, "composes":[],
                    "srcText":"import React from \"react\";\nimport * as d3 from \"d3\";\nexport function Fine(){ return null; }" }),
            // a usage-snippet srcText (`@/`) is not a buildable module → not scanned for imports
            json!({ "id":"snip", "name":"Snip", "kitId":"k", "role":"primitive", "used":3, "composes":[],
                    "srcText":"import { Snip } from \"@/x\";\n<Snip/>" }),
        ];
        let fs = analyze(&comps);
        let found = cats(&fs);
        assert!(!found.contains(&"unresolvable-import"));
    }

    #[test]
    fn is_url_specifier_recognizes_absolute_urls_but_not_bare_packages() {
        assert!(is_url_specifier("https://esm.sh/d3@7"));
        assert!(is_url_specifier("http://x/y"));
        assert!(is_url_specifier("data:text/javascript,x"));
        assert!(!is_url_specifier("d3")); // a bare package
        assert!(!is_url_specifier("d3-scale"));
        assert!(!is_url_specifier("@scope/pkg")); // scoped, no scheme
        assert!(!is_url_specifier("./local"));
        // a URL is therefore NOT a bare specifier; a genuine bare package still is.
        assert!(!is_bare_specifier("https://esm.sh/d3@7"));
        assert!(is_bare_specifier("d3-scale"));
    }

    #[test]
    fn does_not_flag_an_absolute_url_import_but_still_flags_a_bare_miss() {
        // #2963: a full esm.sh URL resolves DIRECTLY in the preview (no import-map entry) → not flagged;
        // a bare package missing from the map (d3-scale) is still flagged.
        let comps = [
            json!({ "id":"chart", "name":"Chart", "kitId":"k", "role":"composite", "used":2, "composes":[],
                    "srcText":"import * as d3 from \"https://esm.sh/d3@7\";\nexport function Chart(){ return d3; }" }),
            json!({ "id":"bad", "name":"Bad", "kitId":"k", "role":"composite", "used":2, "composes":[],
                    "srcText":"import { scaleLinear } from \"d3-scale\";\nexport function Bad(){ return scaleLinear; }" }),
        ];
        let fs = analyze(&comps);
        let flagged: Vec<_> = fs.iter().filter(|f| f.category == "unresolvable-import").collect();
        assert_eq!(flagged.len(), 1, "only the bare miss is flagged, not the esm.sh URL");
        assert_eq!(flagged[0].node_names, ["Bad"]);
        assert!(flagged[0].why.contains("d3-scale"));
    }

    #[test]
    fn resolve_internal_base_handles_alias_and_relative() {
        assert_eq!(
            resolve_internal_base("@/shared/ui/typography/type", "anything"),
            Some("shared/ui/typography/type".into())
        );
        // `Code`'s real failing import (#2954): relative, resolved against the importer's dir.
        assert_eq!(
            resolve_internal_base("../typography/type", "shared/ui/data/Code.tsx"),
            Some("shared/ui/typography/type".into())
        );
        assert_eq!(
            resolve_internal_base("./shimmer", "shared/ui/feedback/Skeleton.tsx"),
            Some("shared/ui/feedback/shimmer".into())
        );
        assert_eq!(resolve_internal_base("react", "x"), None); // a bare npm spec isn't internal
    }

    #[test]
    fn artifact_runtime_paths_reads_the_runtime_keys() {
        let j = r#"{"components":[],"runtime":{"shared/ui/typography/type.ts":"x","shared/ui/feedback/shimmer.ts":"y"}}"#;
        let p = artifact_runtime_paths(j);
        assert!(p.contains("shared/ui/typography/type.ts"));
        assert!(p.contains("shared/ui/feedback/shimmer.ts"));
        assert!(artifact_runtime_paths("not json").is_empty()); // malformed → empty → fail safe
    }

    #[test]
    fn resolves_internal_matches_only_known_targets() {
        let targets: BTreeSet<String> = ["shared/ui/typography/type.ts".to_string()].into_iter().collect();
        assert!(resolves_internal("@/shared/ui/typography/type", "x", &targets));
        assert!(resolves_internal("../typography/type", "shared/ui/data/Code.tsx", &targets));
        assert!(!resolves_internal("@/shared/ui/nope", "x", &targets));
        assert!(resolves_internal("react", "x", &targets), "a bare spec isn't this check's concern");
    }

    #[test]
    fn flags_a_component_importing_a_nonexistent_internal_module() {
        // #2954: an internal `@/…` / relative import resolving to no kit component or runtime module —
        // exactly the invisible `Code`/`Skeleton` preview failure, now surfaced by the doctor.
        let comps = [json!({
            "id":"widget", "name":"Widget", "kitId":"k", "role":"composite", "used":1, "composes":[],
            "src":"shared/ui/data/Widget.tsx",
            "source":"import { helper } from \"@/shared/ui/nope/missing\";\nimport { x } from \"../also/gone\";\nexport function Widget(){ return helper(x); }"
        })];
        let fs = analyze(&comps);
        let f = fs.iter().find(|f| f.category == "unresolvable-import").expect("flagged");
        assert_eq!(f.severity, 3);
        assert!(f.why.contains("@/shared/ui/nope/missing"), "names the unresolvable alias import");
        assert!(f.why.contains("../also/gone"), "names the unresolvable relative import");
        assert!(f.why.contains("no such module in the kit or its runtime closure"));
        assert!(f.suggested_action.contains("no kit component or runtime file"));
    }

    #[test]
    fn does_not_flag_a_component_importing_a_valid_kit_sibling() {
        // A `@/…` OR relative import that resolves to another component in the SAME kit is fine.
        let comps = [
            json!({ "id":"sib", "name":"Sibling", "kitId":"k", "role":"primitive", "used":1, "composes":[],
                    "src":"shared/ui/data/Sibling.tsx", "source":"export const S = () => null;" }),
            json!({ "id":"w", "name":"Widget", "kitId":"k", "role":"composite", "used":1, "composes":[],
                    "src":"shared/ui/data/Widget.tsx",
                    "source":"import { S } from \"@/shared/ui/data/Sibling\";\nimport { R } from \"./Sibling\";\nexport function Widget(){ return S ?? R; }" }),
        ];
        let fs = analyze(&comps);
        assert!(!cats(&fs).contains(&"unresolvable-import"), "a sibling in the same kit resolves");
    }

    #[test]
    fn flags_a_slot_driven_composite_as_slot_shell() {
        // A used page composing children delivered via a `view` ReactNode slot → previews a demo
        // placeholder. used>0 so it isn't ALSO a dead-root dangling-branch — isolate the slot-shell.
        let comps = [json!({
            "id": "gx", "name": "GraphExplorerPage", "kitId": "k", "role": "page", "used": 2,
            "composes": ["ForceGraph", "TreeDiagram"], "srcText": "src", "source": "export const C = () => null;",
            "props": [
                { "name": "title", "type": "string" },
                { "name": "view", "type": "ReactNode" },
                { "name": "inspector", "type": "ReactNode" }
            ]
        })];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["slot-shell"]);
        assert_eq!(fs[0].severity, 1);
        assert!(fs[0].why.contains("ForceGraph, TreeDiagram")); // names the composed children
        assert!(fs[0].why.contains("view, inspector")); // names the slots
        assert!(fs[0].suggested_action.contains("fill its slots"));
    }

    #[test]
    fn does_not_flag_slot_shell_without_a_node_slot_or_children_only() {
        let comps = [
            // composes children but no ReactNode content slot → renders standalone, not flagged
            json!({ "id": "tb", "name": "Toolbar", "kitId": "k", "role": "composite", "used": 3,
                    "composes": ["Button"], "srcText": "a", "source": "export const C = () => null;",
                    "props": [{ "name": "label", "type": "string" }] }),
            // a `children`-only prop is universal, never a slot-shell signal
            json!({ "id": "cd", "name": "Card", "kitId": "k", "role": "composite", "used": 3,
                    "composes": ["Icon"], "srcText": "b", "source": "export const C = () => null;",
                    "props": [{ "name": "children", "type": "ReactNode" }] }),
            comp("Button", "primitive", 9, &[]),
            comp("Icon", "primitive", 9, &[]),
        ];
        let fs = analyze(&comps);
        let found = cats(&fs);
        assert!(!found.contains(&"slot-shell"));
    }

    #[test]
    fn flags_a_component_that_declares_props_its_source_never_uses() {
        // Reads `title` but ignores its declared `data` + `onRefresh` — a dead interface (used>0 so it's
        // not a dead-root dangling-branch; source present so it's not no-implementation).
        let comps = [json!({
            "id": "dash", "name": "Dash", "kitId": "k", "role": "page", "used": 2, "composes": [],
            "srcText": "src", "source": "export function Dash({ title }){ return <h1>{title}</h1>; }",
            "props": [
                { "name": "title", "type": "string" },
                { "name": "data", "type": "Row[]" },
                { "name": "onRefresh", "type": "() => void" }
            ]
        })];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["unwired-prop"]);
        assert_eq!(fs[0].severity, 2);
        assert!(fs[0].why.contains("data, onRefresh")); // names the dead props
        assert!(!fs[0].why.contains("title")); // never the used one
    }

    #[test]
    fn does_not_flag_unwired_prop_when_wired_a_spreader_or_a_spec() {
        let comps = [
            // every prop referenced → wired
            json!({ "id": "card", "name": "Card", "kitId": "k", "role": "composite", "used": 3, "composes": [],
                    "srcText": "s", "source": "export function Card({ title, onClick }){ return <button onClick={onClick}>{title}</button>; }",
                    "props": [{ "name": "title", "type": "string" }, { "name": "onClick", "type": "() => void" }] }),
            // references NO named prop (a `{...props}` spreader) → conservative skip
            json!({ "id": "pt", "name": "Passthrough", "kitId": "k", "role": "composite", "used": 3, "composes": [],
                    "srcText": "s", "source": "export function Passthrough(props){ return <div {...props} />; }",
                    "props": [{ "name": "title", "type": "string" }, { "name": "onClick", "type": "() => void" }] }),
            // no OWN module source (usage-snippet srcText, no `source`) → skipped (it's a spec)
            json!({ "id": "btn", "name": "Btn", "kitId": "k", "role": "primitive", "used": 5, "composes": [],
                    "srcText": "import { Btn } from \"@/x\";\n<Btn label={…} />",
                    "props": [{ "name": "label", "type": "string" }] }),
        ];
        let fs = analyze(&comps);
        let found = cats(&fs);
        assert!(!found.contains(&"unwired-prop"));
    }

    #[test]
    fn a_used_primitive_is_never_flagged() {
        let fs = analyze(&[comp("Button", "primitive", 2, &[])]);
        assert!(fs.is_empty());
    }

    #[test]
    fn flags_an_unused_root_with_deps_as_a_dangling_branch() {
        // DeadShell (unused, in-degree 0) composes Widget; the whole branch is dead.
        let comps = [
            json!({ "id": "shell", "name": "DeadShell", "kitId": "k", "role": "layout", "used": 0, "composes": ["Widget"], "srcText": "a", "source": "export const C = () => null;" }),
            json!({ "id": "widget", "name": "Widget", "kitId": "k", "role": "composite", "used": 0, "composes": [], "srcText": "b", "source": "export const C = () => null;" }),
        ];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["dangling-branch"]);
        assert!(fs[0].node_names.contains(&"DeadShell".to_string()));
        assert!(fs[0].node_names.contains(&"Widget".to_string()));
    }

    #[test]
    fn flags_two_components_wrapping_the_same_intrinsic_as_duplicates() {
        let comps = [
            json!({ "id": "btn", "name": "Button", "kitId": "k", "role": "primitive", "used": 9, "composes": [], "wraps": "button", "srcText": "a", "source": "export const C = () => null;" }),
            json!({ "id": "btn2", "name": "Btn2", "kitId": "k", "role": "primitive", "used": 1, "composes": [], "wraps": "button", "srcText": "b", "source": "export const C = () => null;" }),
        ];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["duplicate"]);
        // Merge target is the most-used one.
        assert!(fs[0].suggested_action.contains("Button"));
    }

    #[test]
    fn flags_a_composes_cycle() {
        let comps = [
            json!({ "id": "a", "name": "A", "kitId": "k", "role": "composite", "used": 1, "composes": ["B"], "srcText": "a", "source": "export const C = () => null;" }),
            json!({ "id": "b", "name": "B", "kitId": "k", "role": "composite", "used": 1, "composes": ["A"], "srcText": "b", "source": "export const C = () => null;" }),
        ];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["cycle"]);
        assert_eq!(fs[0].severity, 4);
    }

    #[test]
    fn edges_do_not_cross_kits() {
        // Same dependency name in two kits must not wire them together.
        let comps = [
            json!({ "id": "k1-page", "name": "Page", "kitId": "k1", "role": "page", "used": 1, "composes": ["Button"], "srcText": "a", "source": "export const C = () => null;" }),
            json!({ "id": "k1-btn", "name": "Button", "kitId": "k1", "role": "primitive", "used": 4, "composes": [], "srcText": "b", "source": "export const C = () => null;" }),
            json!({ "id": "k2-btn", "name": "Button", "kitId": "k2", "role": "primitive", "used": 0, "composes": [], "srcText": "c", "source": "export const C = () => null;" }),
        ];
        // k2's Button is isolated + unused in ITS kit → orphan; k1's Button is composed → clean.
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["orphan"]);
        assert_eq!(fs[0].kit, "k2");
    }

    #[test]
    fn prunable_is_the_orphan_and_dead_root_set_and_never_a_used_node() {
        let comps = [
            comp("Button", "primitive", 9, &[]),   // used → never prunable
            comp("Ghost", "primitive", 0, &[]),     // orphan → prunable
            // dead root + its dependency; only the ROOT is prunable this pass.
            json!({ "id": "shell", "name": "DeadShell", "kitId": "k", "role": "layout", "used": 0, "composes": ["Widget"], "srcText": "a" }),
            json!({ "id": "widget", "name": "Widget", "kitId": "k", "role": "composite", "used": 0, "composes": [], "srcText": "b" }),
            // a duplicate pair — reported, but NOT auto-prunable.
            json!({ "id": "b1", "name": "Btn1", "kitId": "k", "role": "primitive", "used": 3, "composes": [], "wraps": "button", "srcText": "x" }),
            json!({ "id": "b2", "name": "Btn2", "kitId": "k", "role": "primitive", "used": 1, "composes": [], "wraps": "button", "srcText": "y" }),
        ];
        let ids: Vec<String> = prunable(&comps).into_iter().map(|p| p.id).collect();
        assert!(ids.contains(&"Ghost".to_string()));
        assert!(ids.contains(&"shell".to_string()));
        assert!(!ids.contains(&"widget".to_string())); // a descendant, not a root — next pass
        assert!(!ids.contains(&"Button".to_string())); // used > 0
        assert!(!ids.contains(&"b1".to_string()) && !ids.contains(&"b2".to_string())); // duplicates aren't pruned
    }

    #[test]
    fn ranks_most_severe_first() {
        let comps = [
            comp("Ghost", "primitive", 0, &[]), // orphan (sev 2)
            json!({ "id": "a", "name": "A", "kitId": "k", "role": "composite", "used": 1, "composes": ["B"], "srcText": "a", "source": "export const C = () => null;" }),
            json!({ "id": "b", "name": "B", "kitId": "k", "role": "composite", "used": 1, "composes": ["A"], "srcText": "b", "source": "export const C = () => null;" }),
        ];
        let fs = analyze(&comps);
        assert_eq!(fs[0].category, "cycle"); // severity 4 leads
        assert_eq!(fs.last().unwrap().category, "orphan"); // severity 2 trails
    }

    // ── no-implementation (#2839) ────────────────────────────────────────────────────────────────

    #[test]
    fn flags_a_source_less_user_spec_but_never_a_built_in() {
        // A REAL built-in `src` from the embedded packaged artifact roster. The store strips a built-in's
        // `source` (#2794), so it looks source-less here (empty `source` + a usage-snippet `srcText`),
        // yet it IS buildable because its code lives in the artifact — the roster check must save it.
        let real_builtin_src =
            buildable_srcs().iter().next().expect("the packaged artifact ships components").clone();
        let comps = [
            // BUILT-IN: source-less in the store, but its `src` is in the artifact roster → NOT flagged.
            json!({ "id": "card", "name": "Card", "kitId": "react-ui", "role": "primitive", "used": 2,
                    "composes": [], "src": real_builtin_src, "source": "",
                    "srcText": "import { Card } from \"@/shared/ui/data/Card\";\n<Card />" }),
            // USER SPEC: a `page` that's a design, not code — source-less, a usage-snippet `srcText`, and a
            // `src` that is NOT in the artifact. The preview can't build it (componentPreviewFiles → null).
            json!({ "id": "gx", "name": "GraphExplorerPage", "kitId": "react-ui", "role": "page", "used": 1,
                    "composes": [], "src": "user/pages/GraphExplorerPage.tsx", "source": "",
                    "srcText": "import { GraphExplorerPage } from \"@/x\";\n<GraphExplorerPage nodes={…} />" }),
        ];
        let fs = analyze(&comps);
        let flagged: Vec<&str> = fs
            .iter()
            .filter(|f| f.category == "no-implementation")
            .flat_map(|f| f.node_names.iter().map(String::as_str))
            .collect();
        assert!(flagged.contains(&"GraphExplorerPage"), "the source-less user spec is flagged: {flagged:?}");
        assert!(
            !flagged.contains(&"Card"),
            "a built-in (its `src` in the packaged artifact) is NEVER flagged: {flagged:?}",
        );
        // The user spec's ONLY finding is no-implementation (used > 0 ⇒ not a dead root; composes nothing).
        assert_eq!(cats(&fs), ["no-implementation"]);
    }

    #[test]
    fn a_user_component_with_its_own_module_source_is_buildable() {
        // No artifact `src`, but a real self-contained `source` (path 2) OR a real-module `srcText`
        // (path 3) — either makes it buildable, so it's never flagged.
        let own_source = json!({ "id": "u1", "name": "OwnSource", "kitId": "user", "role": "composite",
            "used": 1, "composes": [], "src": "", "srcText": "",
            "source": "import * as d3 from \"d3\";\nexport function OwnSource() { return null; }" });
        let own_srctext = json!({ "id": "u2", "name": "OwnSrcText", "kitId": "user", "role": "composite",
            "used": 1, "composes": [], "src": "", "source": "",
            "srcText": "import * as d3 from \"d3\";\nexport function OwnSrcText() { return null; }" });
        let fs = analyze(&[own_source, own_srctext]);
        assert!(fs.iter().all(|f| f.category != "no-implementation"), "own-source/module fixtures build: {fs:?}");
    }

    #[test]
    fn looks_buildable_module_mirrors_the_ts_twin() {
        // Accepts a self-contained module (has an export; no `@/`; no `…`).
        assert!(looks_buildable_module("import * as d3 from \"d3\";\nexport function Foo() { return null; }"));
        assert!(looks_buildable_module("export default function Foo() { return null; }"));
        // Rejects: empty / whitespace, no export, a `@/` first-party import (either quote), a `…` placeholder.
        assert!(!looks_buildable_module(""));
        assert!(!looks_buildable_module("   \n  "));
        assert!(!looks_buildable_module("const x = 1;"));
        assert!(!looks_buildable_module("import { Card } from \"@/shared/ui/data/Card\";\nexport function X() {}"));
        assert!(!looks_buildable_module("import { Card } from '@/shared/ui/data/Card';\nexport function X() {}"));
        assert!(!looks_buildable_module("export function X() { return <Card>…</Card>; }"));
        // `export` must be a WHOLE word — a substring like `reexported` doesn't qualify.
        assert!(!looks_buildable_module("const reexportedThing = 1;"));
    }

    #[test]
    fn artifact_buildable_srcs_collects_only_components_that_ship_source() {
        let artifact = json!({
            "components": [
                { "id": "card", "src": "shared/ui/data/Card.tsx", "source": "export const Card = () => null;" },
                { "id": "stub", "src": "shared/ui/Stub.tsx" },                 // no source → excluded
                { "id": "empty", "src": "shared/ui/Empty.tsx", "source": "" }, // empty source → excluded
                { "id": "nosrc", "source": "export const X = () => null;" },   // no src → excluded
            ]
        })
        .to_string();
        let roster = artifact_buildable_srcs(&artifact);
        assert_eq!(roster.len(), 1);
        assert!(roster.contains("shared/ui/data/Card.tsx"));
        assert!(!roster.contains("shared/ui/Stub.tsx"));
        assert!(!roster.contains("shared/ui/Empty.tsx"));
        // A malformed artifact is an empty roster (fail safe — the check then falls back to source/srcText).
        assert!(artifact_buildable_srcs("not json").is_empty());
    }

    #[test]
    fn the_embedded_packaged_roster_is_populated() {
        // The buildability check reads the SAME react-ui.json the kit store + emit embed. If the include
        // path or the artifact shape drifts, the roster empties and every built-in would be falsely
        // flagged — so guard that it stays non-empty.
        assert!(!buildable_srcs().is_empty(), "the embedded react-ui artifact roster must not be empty");
    }
}
