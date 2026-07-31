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
//! throws "module not found" at preview time) · **reimplementation** (an own-source component that
//! DECLARES a symbol re-coding a node that already exists in the library — an inline `function fibonacci`
//! while `@bsc/algorithms/fibonacci` exists — instead of importing it; the "compose, don't recreate"
//! guardrail, #3118) · **orphan**
//! (an isolated, never-referenced primitive/composite) · **unwired-prop** (declares props its own source
//! never references — a declared interface that does nothing, #2924) · **phantom-compose** (a user
//! component declares `composes` children its own source never renders — a false graph edge that also
//! masks orphan detection, #3111) · **slot-shell** (INFORMATIONAL — a
//! composite whose composed children arrive via ReactNode content slots, so a standalone preview renders
//! a demo placeholder, #2921). "Unused" = orphan ∪ dangling-branch — a node with no composer AND
//! `used == 0`; a `page`/`layout` with `used > 0` is a legit entry point, never flagged.
//!
//! **Reporting a dead root is not the same as auto-DELETING one.** The findings above are a diagnosis;
//! [`prune_plan`] is what `bsc ui doctor --fix` may actually remove, and it filters the dead-root
//! candidates through three guards (#3087) — never a `page` (a page is a root by definition), never a
//! `builtin: true` packaged seed, and never anything at all while the `used` index is unpopulated
//! (`used == 0` store-wide means the usage signal is UNKNOWN, not that everything is unused). A guarded
//! candidate is still REPORTED; only its automatic removal is withheld.
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
    /// `cycle` | `dangling-branch` | `duplicate` | `no-implementation` | `self-reference` |
    /// `unresolvable-import` | `stubbed-import` (#3696, sev-1) | `hardcoded-color` (#3704, sev-1) |
    /// `reimplementation` | `reimplemented-component` (#3892, sev-3) | `orphan` | `unwired-prop` | `phantom-compose` | `no-empty-state` |
    /// `no-loading-state` | `no-error-state` (#3555) | `no-analytics` (#3810) | `no-tests` (#3878) | `slot-shell` | `render-error` (#3540, CLI-only — see [`render_error_findings`]).
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

/// Findings for components whose PREVIEW failed — a `build:` esbuild failure OR a `render:` runtime throw
/// (#3540/#3549) — the half doctor's static analyzer is blind to. Doctor cannot run esbuild or mount a
/// component, so a preview failure can only reach the report via the durable preview-error log
/// (`preview_errors::latest_error_by_id`), which the app's on-visit scan + live previews record with a
/// `build:`/`render:` kind prefix. Fed those `(id, message)` pairs, this emits one finding per errored
/// component STILL in `components` (a stale id for a removed component is dropped), with prose matched to
/// the kind (a build failure and a render throw need different fixes).
///
/// Deliberately NOT part of [`analyze_with`]: that function has a byte-parity TS twin (`graphHealth.ts`)
/// which is static-only, and the render error is a Rust/CLI-only signal fed from a log the frontend
/// doesn't read. `cmd_doctor` appends these like `analyze_motion`, so the twin stays untouched.
pub fn render_error_findings(components: &[Value], errors: &[(String, String)]) -> Vec<Finding> {
    let by_id: BTreeMap<&str, &Value> = components
        .iter()
        // #3725: a suppression tombstone is not a component — drop its errors like a store-absent one.
        .filter(|c| c.get("suppressed").and_then(Value::as_bool) != Some(true))
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(|id| (id, c)))
        .collect();
    errors
        .iter()
        .filter_map(|(id, message)| {
            let comp = by_id.get(id.as_str())?; // drop a stale error for a component no longer in the store
            // #3737: drop a render-error for a component whose current srcText is EMPTY — an empty spec
            // can't have a live render error (the preview shows no-implementation, not a throw), so a
            // persisted error there is stale by definition (the component was reduced to a spec since).
            // Conservative: a NON-empty srcText keeps its error (a real build/render failure is possible).
            if comp.get("srcText").and_then(Value::as_str).unwrap_or_default().trim().is_empty() {
                return None;
            }
            let name = comp.get("name").and_then(Value::as_str).unwrap_or(id.as_str()).to_string();
            let kit = comp.get("kitId").and_then(Value::as_str).unwrap_or_default().to_string();
            // The scan records the failure with a `build:`/`render:` kind prefix (#3549). Strip it for
            // display and branch the prose — a BUILD failure (esbuild) and a RENDER throw (an exception
            // during mount) need different fixes. A raw message with no prefix is treated as a render throw.
            let is_build = message.starts_with("build:");
            let detail = message
                .strip_prefix("build:")
                .or_else(|| message.strip_prefix("render:"))
                .unwrap_or(message)
                .trim();
            // Collapse a multi-line stack trace to one line and cap it — the finding is a summary; the
            // full trace stays in `bsc ui preview-errors`.
            let one_line: String = detail.replace(['\n', '\t'], " ").chars().take(240).collect();
            Some(Finding {
                // Severity 5 — above every static finding (cycle is 4): a confirmed preview failure is the
                // most actionable, so it sorts to the top of the report.
                category: "render-error",
                severity: 5,
                kit,
                node_ids: vec![id.clone()],
                node_names: vec![name.clone()],
                why: if is_build {
                    format!("`{name}` failed to BUILD in the preview: {}", one_line.trim())
                } else {
                    format!("`{name}` threw when the preview rendered it: {}", one_line.trim())
                },
                suggested_action: if is_build {
                    format!(
                        "the preview's esbuild build failed — check the source + imports with \
                         `bsc ui get {id} --field srcText --raw` (a missing/mistyped import, an unresolved \
                         sibling, or TypeScript in a file loaded as plain JS shows up here)"
                    )
                } else {
                    format!(
                        "the preview likely passes `undefined` for a prop it reads — check `bsc ui preview-props {id}` \
                         and guard the access (or fix the sample-data shape)"
                    )
                },
            })
        })
        .collect()
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
    /// The registered PLATFORM module specifier this graph-source component OVERRIDES (#3660), e.g.
    /// `@/shared/ui/typography/Text` — empty when it's an ordinary component. The runtime loader resolves a
    /// `@/…` import to the component that `provides` it; the buildability check mirrors that (#43).
    provides: String,
    /// `(name, type)` per prop — for the slot-shell check (a non-`children` ReactNode content slot).
    props: Vec<(String, String)>,
    /// Whether this is a packaged built-in (its store record is a contract catalog: `source` stripped,
    /// `srcText` an illustrative snippet). The phantom-compose check (#3111) skips built-ins — scanning
    /// their illustrative snippet for composed children would false-positive.
    builtin: bool,
    /// How many analytics events the component's `analytics` manifest declares (#3810) — the per-node
    /// events contract (data, not code). 0 ⇒ uninstrumented, which the `no-analytics` check flags for an
    /// interactive component.
    analytics_events: usize,
    /// How many tests the component's `tests` manifest carries (#3878) — the per-node test contract, the
    /// same shape one field over from `analytics`. A node's tests travel WITH it, because once its source
    /// is a store record compiled at runtime, a test file in `src/**` is no longer beside what it tests.
    /// 0 ⇒ untested, which the `no-tests` check flags for an IMPLEMENTED own-module component.
    tests: usize,
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn parse_node(v: &Value) -> Option<Node> {
    let id = v.get("id").and_then(Value::as_str)?.to_string();
    if id.is_empty() {
        return None;
    }
    // #3725: a suppression tombstone (`{ id, suppressed: true }`) is not a component — it marks a
    // permanently-removed packaged builtin. Skip it here so EVERY graph-health consumer (analyze,
    // prunable, usage index) ignores it and it never shows a false `no-implementation` etc.
    if v.get("suppressed").and_then(Value::as_bool) == Some(true) {
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
        provides: s(v, "provides"),
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
        builtin: v.get("builtin").and_then(Value::as_bool).unwrap_or(false),
        analytics_events: v.get("analytics").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        tests: v.get("tests").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
    })
}

/// Is `(name, ty)` an ACTION prop — an event/callback the component fires (`onClick`, `onChange`,
/// `onSelect`, …: name starts with `on` + a function type)? Its presence marks the component as
/// INTERACTIVE, so the `no-analytics` check (#3810) expects an events manifest. Mirrors `isActionProp`
/// (graphHealth.ts).
fn is_action_prop(name: &str, ty: &str) -> bool {
    name.len() > 2 && name.to_lowercase().starts_with("on") && ty.contains("=>")
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

/// Is `ty` a COLLECTION/data prop — an array (`Row[]`, `array`)? A data component takes one; the preview's
/// empty/loading state switch (#3135) is expected of it. Mirrors `isCollectionProp` (componentPreview.ts).
fn is_collection_prop(ty: &str) -> bool {
    let t = ty.to_lowercase();
    t.contains("[]") || t.contains("array")
}

/// Is `(name, ty)` a LOADING-family boolean (`loading`/`busy`/`pending`/`isLoading`)? A data component with
/// one can preview its loading/skeleton render (#3135). Mirrors `isLoadingProp` (componentPreview.ts).
fn is_loading_prop(name: &str, ty: &str) -> bool {
    let t = ty.to_lowercase();
    (t == "boolean" || t.contains("boolean"))
        && matches!(name.to_lowercase().as_str(), "loading" | "busy" | "pending" | "isloading")
}

/// Is `(name, ty)` an ERROR-family prop (`error`/`err`/`isError`/`hasError`, and NOT a callback)? A data
/// component with one can preview its error render (#3555). Mirrors `isErrorProp` (componentPreview.ts).
fn is_error_prop(name: &str, ty: &str) -> bool {
    let t = ty.to_lowercase();
    let is_fn = t.contains("=>") || t.contains("function") || t.contains("void");
    !is_fn && matches!(name.to_lowercase().as_str(), "error" | "err" | "iserror" | "haserror")
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

/// The specifiers the runtime module REGISTRY resolves (#3897) — the SAME json `graphHealth.ts` imports,
/// generated from the real registry by `platformModules.gen.test.ts`.
///
/// Without it the buildability check resolved `@/…` against the packaged artifact and sibling node `src`
/// paths only, so a record honestly importing a registered platform module
/// (`@/features/security/lib/badgeTone`) matched neither and read as `no-implementation` — while the app
/// mounted it fine. The finding then pressured the next author to STUB the import to silence it, which is
/// the corruption `reimplemented-component` exists to catch (#3892/#3895).
const PLATFORM_MODULES_JSON: &str = include_str!("../../../src-tauri/data/ui/platform-modules.json");

/// Whether `spec` is a REGISTERED platform module — one the runtime module registry resolves, so a
/// record importing it mounts in the app without the import being vendored anywhere.
///
/// Public so the HARVESTER shares this one predicate instead of growing a second copy of the registry
/// (#4071). Harvest had exactly the blind spot #3897 fixed here: it resolved `@/…` against sibling `src`
/// paths only, so 116 of its 351 unbuildable candidates were blocked wholly or partly by specifiers the
/// runtime resolves fine. A false "unresolved import" is not merely noise — it is the pressure that makes
/// the next author hand-stub the import to silence it, which is the corruption `reimplemented-component`
/// exists to catch (#3892/#3895).
pub fn is_registered_platform_module(spec: &str) -> bool {
    platform_modules().contains(spec)
}

/// The registered platform specifiers, matched LITERALLY (exactly as the loader's `isAppModule` does).
fn platform_modules() -> &'static BTreeSet<String> {
    static M: std::sync::OnceLock<BTreeSet<String>> = std::sync::OnceLock::new();
    M.get_or_init(|| {
        serde_json::from_str::<Vec<String>>(PLATFORM_MODULES_JSON).unwrap_or_default().into_iter().collect()
    })
}

/// The algorithms knowledge seed (`src-tauri/data/knowledge/algorithms.json`) — the SAME json the frontend
/// (`@data/knowledge/algorithms.json`) + `bsc graph` embed. Embedded here so the THIRD import-resolution
/// class (#3116) — a `@bsc/algorithms/<name>` cross-graph reference — is recognized with no fs/network: a
/// reference matching a real TS algorithm resolves (the preview vendors its code) and is NEVER flagged; a
/// `@bsc/algorithms/<missing>` is. The Rust twin of `libraryModules.ts` / `graphHealth.ts`.
const ALGORITHMS_JSON: &str = include_str!("../../../src-tauri/data/knowledge/algorithms.json");

/// The DEFAULT sound kit seed (`src-tauri/data/sounds/signal.json`) — the kit an UNPINNED project resolves
/// `@bsc/sounds/<id>` against, the twin of the frontend's `SoundKitSelection::default` arm. A project whose
/// blueprint PINS a sound kit resolves against that kit instead ([`HealthOptions::sound_kit_json`], #3412).
/// Embedded so the SOUNDS arm of the third import class (#3117) is recognized with no fs/network: a
/// reference matching a real cue/voice resolves (the preview vendors a GENERATED player module — a sound has
/// no JS source) and is NEVER flagged; a `@bsc/sounds/<missing>` is. The Rust twin of `soundNodeLookup` /
/// `libraryModules.ts`. LOCKSTEP: if the default sound kit ever changes, update this embed — a test pins
/// `signal` on both sides.
const SOUND_KIT_JSON: &str = include_str!("../../../src-tauri/data/sounds/signal.json");

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

/// Is `spec` a `@bsc/<segment>/<name>` LIBRARY reference (#3116) — the reserved cross-graph import root
/// (A's `LIBRARY_ROOT`)? Bare-shaped, but it resolves against a library store (the algorithms graph), NOT
/// the preview import-map — the THIRD import-resolution class. Mirrors `isLibrarySpec` (nodeUrn.ts).
fn is_library_specifier(spec: &str) -> bool {
    spec.starts_with("@bsc/")
}

/// The resolvable `@bsc/algorithms/…` reference NAMES — every TYPESCRIPT algorithm impl carrying real
/// `code`, keyed by BOTH its bare name (`fibonacci`) and its exact id (`fibonacci.ts`), since a React
/// component resolves against the TS algorithm kit and accepts either form (#3116). Cached; a malformed
/// seed yields an empty set, so every `@bsc/algorithms/…` is then flagged — fail safe, never a false
/// "resolves". Mirrors the resolvable set behind `libraryModuleResolver` (libraryModules.ts).
fn algo_library_names() -> &'static BTreeSet<String> {
    static N: std::sync::OnceLock<BTreeSet<String>> = std::sync::OnceLock::new();
    N.get_or_init(|| algo_library_names_from(ALGORITHMS_JSON))
}

/// Pure over the seed JSON text (testable without the embed): the bare names + exact ids of every
/// typescript algorithm impl that ships non-empty `code` (a primitive descriptor has no code → not
/// importable, so it's excluded). Malformed JSON → empty set.
fn algo_library_names_from(json: &str) -> BTreeSet<String> {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return BTreeSet::new();
    };
    let mut out = BTreeSet::new();
    for im in v.get("implementations").and_then(Value::as_array).into_iter().flatten() {
        let tech = im.get("tech").and_then(Value::as_str).unwrap_or_default();
        let role = im.get("role").and_then(Value::as_str).unwrap_or_default();
        let has_code = im.get("code").and_then(Value::as_str).is_some_and(|c| !c.trim().is_empty());
        if tech != "typescript" || role != "algorithm" || !has_code {
            continue;
        }
        if let Some(id) = im.get("id").and_then(Value::as_str) {
            out.insert(id.to_string());
        }
        if let Some(name) = im.get("name").and_then(Value::as_str) {
            out.insert(name.to_string());
        }
    }
    out
}

/// The resolvable `@bsc/sounds/…` reference NAMES (#3117) — every CUE id (the playable product) + every
/// VOICE id (a playable patch) in the DEFAULT sound kit. A PRIMITIVE is a raw source descriptor with no
/// player (not importable/vendorable), so it's excluded — mirroring an algorithm primitive. Cached; a
/// malformed seed yields an empty set, so every `@bsc/sounds/…` is then flagged — fail safe, never a false
/// "resolves". Mirrors the resolvable set behind `soundNodeLookup` (crossGraphAdapter.ts).
fn sound_library_names() -> &'static BTreeSet<String> {
    static N: std::sync::OnceLock<BTreeSet<String>> = std::sync::OnceLock::new();
    N.get_or_init(|| sound_library_names_from(SOUND_KIT_JSON))
}

/// Pure over the kit seed JSON text (testable without the embed): the ids of every cue + voice in the kit
/// (a primitive has no player → excluded). Malformed JSON → empty set.
fn sound_library_names_from(json: &str) -> BTreeSet<String> {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return BTreeSet::new();
    };
    let mut out = BTreeSet::new();
    for key in ["cues", "voices"] {
        for item in v.get(key).and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = item.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                out.insert(id.to_string());
            }
        }
    }
    out
}

/// Does a `@bsc/<segment>/<name>` LIBRARY reference resolve to a real, runnable library node (#3116/#3117)?
/// The `algorithms` segment resolves against the TS algorithm kit (`<name>` = bare name OR exact id of an
/// impl carrying code); the `sounds` segment resolves against the default sound kit (`<name>` = a cue or
/// voice id — the preview vendors a generated player module). Any other segment (`ui`) has no vendor path
/// here → false. A non-`@bsc/` spec returns false (gated by `is_library_specifier`). Mirrors
/// `libraryModuleResolver(spec) !== null` (graphHealth.ts / libraryModules.ts).
fn resolves_library(spec: &str, sounds: &BTreeSet<String>) -> bool {
    let Some(rest) = spec.strip_prefix("@bsc/") else {
        return false;
    };
    let Some((segment, name)) = rest.split_once('/') else {
        return false;
    };
    if name.is_empty() {
        return false;
    }
    match segment {
        "algorithms" => algo_library_names().contains(name),
        "sounds" => sounds.contains(name),
        _ => false,
    }
}

/// Is `s` a single valid JS identifier (so it COULD be a declared symbol)? Excludes empty, a leading
/// digit, and any non-`[A-Za-z0-9_$]` char — so a library name that can never appear as `function <name>`
/// (an extension-bearing algo id like `fibonacci.ts`) is not a reimplementation candidate. Mirrors
/// `isJsIdentifier` (libraryModules.ts).
fn is_js_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// The library nodes a component could RE-CODE instead of importing (#3118) — the "compose, don't
/// recreate" guardrail's candidate set. `(name, segment)`: `name` is the exact identifier a
/// reimplementation would DECLARE (an algorithm's bare name); `segment` is the `@bsc/<segment>` import
/// root (always `algorithms`). Drawn from the SAME `algo_library_names()` set the #3116 resolvable check
/// uses (so a listed name is one `@bsc/algorithms/<name>` resolves), then filtered to identifiers — a
/// non-identifier library name (the extension-bearing algo id `fibonacci.ts`) can never be a declared
/// symbol, so it's no reimplementation candidate. Cached. Mirrors `libraryReimplTargets` (libraryModules.ts).
///
/// ALGORITHMS-ONLY BY DESIGN. Sounds are DELIBERATELY excluded even though `@bsc/sounds/<id>` resolves +
/// vendors (#3117 — that import path stays fully intact, `sound_library_names()` still backs it): a sound
/// cue/voice id (`click`, `toggle`, `error`, `success`, `pop`, `tick`, …) collides with extremely common
/// handler/function names, so a component that legitimately declares `function click()` would be wrongly
/// flagged — and you don't "re-code" a cue as a function anyway. Value asymmetric, false-positive cost
/// high, so the reimplementation detector matches algorithms only.
fn reimpl_targets() -> &'static [(String, &'static str)] {
    static T: std::sync::OnceLock<Vec<(String, &'static str)>> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        algo_library_names()
            .iter()
            .filter(|name| is_js_identifier(name))
            .map(|name| (name.clone(), "algorithms"))
            .collect()
    })
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
            // A non-identifier char between a keyword and a string decides whether the string is a REAL
            // import target. A pending `from`/`import` survives ONLY across whitespace (`from "x"`,
            // `import "x"`); `import` additionally survives a single `(` (dynamic `import("x")`). Anything
            // else — a `:` (`{ from: "x" }` graph-edge demo data), a `(` after `from` (`Array.from("x")`),
            // a `.`, `,`, `{`, … — means the keyword was an object key or member, NOT an import clause, so
            // clear it. Without this a graph component's demo edge `{ from: "node-id" }` was misread as
            // importing "node-id" and flagged unresolvable-import (#3687: false positives on
            // RelationshipGraphView / TeamsCanvas, filed 5×). Mirrors the regex twins `\bfrom\s+["']`.
            let survives = last_word.is_empty()
                || c.is_whitespace()
                || (c == '(' && last_word == "import");
            if !survives {
                last_word.clear();
            }
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
pub fn is_internal_specifier(spec: &str) -> bool {
    spec.starts_with("@/") || spec.starts_with("./") || spec.starts_with("../")
}

/// Resolve an INTERNAL import `spec` — imported FROM module `from_rel` (a `src/`-relative path) — to its
/// `src/`-relative module BASE (no extension), or `None` when it isn't internal. `@/x` → `x`; a relative
/// path is joined onto the importer's directory and `.`/`..` segments collapsed. Mirrors the closure
/// walker's resolver (reactUiKit.gen.test.ts) and `resolveInternalBase` (TS).
pub fn resolve_internal_base(spec: &str, from_rel: &str) -> Option<String> {
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
fn is_buildable(node: &Node, buildable: &BTreeSet<String>, kit_targets: &BTreeSet<String>) -> bool {
    (!node.src.is_empty() && buildable.contains(&node.src))
        || !node.source.trim().is_empty()
        || is_preview_buildable(&node.src_text, &node.src, kit_targets)
}

/// Sibling-aware buildability of a preview MODULE (#3112) — the Rust mirror of `isPreviewBuildable`
/// (componentPreview.ts). Like `looks_buildable_module`, but an internal (`@/`, `./`) import is ALLOWED
/// when it resolves to a sibling in `kit_targets` (the kit's component `src` paths); an internal import
/// that resolves to NOTHING still fails, as do a `…` placeholder and a missing `export`.
///
/// This predicate answers "will the preview build it?", so its `…` test must be whatever the TS
/// `isPreviewBuildable` does — `doctor` must never be more permissive than the thing it reports on, or it
/// calls a component healthy that the preview then refuses (a MISSED no-implementation finding). Until
/// #3486 that pinned it to the PLAIN substring test, because the TS side still used one. #3486 ported the
/// context-aware scanner to TS, so both moved to [`has_code_elision`] together — and they must keep
/// moving together. The two are also wrong in opposite directions if they drift: plain-here/aware-there
/// makes `doctor` report a no-implementation the preview happily renders, which is the false accusation
/// #3486 was filed for.
fn is_preview_buildable(src_text: &str, from_rel: &str, kit_targets: &BTreeSet<String>) -> bool {
    let s = src_text.trim();
    if s.is_empty() || !contains_word(s, "export") || has_code_elision(s) {
        return false;
    }
    import_specifiers(s)
        .iter()
        // A REGISTERED platform module (#3897) resolves literally, like the loader's `isAppModule` — it is
        // neither an artifact path nor a sibling `src`, so without this it read as unbuildable.
        .all(|spec| {
            !is_internal_specifier(spec)
                || platform_modules().contains(spec)
                || resolves_internal(spec, from_rel, kit_targets)
        })
}

/// Every reason the preview CANNOT build `node` — the reason-first face of [`is_preview_buildable`],
/// in the same order that predicate tests them.
///
/// A `no-implementation` finding used to state only THAT a component was unbuildable, so the reader had
/// to re-derive the cause by hand — the gap `bsc request` #4 was filed for. The causes are already
/// computed to decide the predicate; this names them so `bsc ui doctor --json` is diagnosable on its own.
/// Mirrors `bsc_ui::harvest`'s `buildability`, which reports the same three defects at harvest time.
///
/// Returns EMPTY only when nothing is wrong, so a caller can treat non-empty as "unbuildable, and here
/// is why" — a node with no source of its own is a stated reason, not an empty list.
fn no_implementation_reasons(node: &Node, kit_targets: &BTreeSet<String>) -> Vec<String> {
    let s = node.src_text.trim();
    if s.is_empty() {
        return vec!["it carries no module source of its own (neither `source` nor `srcText`)".to_string()];
    }
    let mut why = Vec::new();
    if !contains_word(s, "export") {
        why.push("its source declares no `export`".to_string());
    }
    if has_code_elision(s) {
        why.push("its source contains a code-elision marker (`…`) — a sketch, not code".to_string());
    }
    let unresolved: BTreeSet<String> = import_specifiers(s)
        .into_iter()
        .filter(|spec| {
            is_internal_specifier(spec)
                && !platform_modules().contains(spec)
                && !resolves_internal(spec, &node.src, kit_targets)
        })
        .collect();
    if !unresolved.is_empty() {
        why.push(format!(
            "it imports {} — resolving to no kit component, runtime file or registered platform module",
            unresolved.iter().map(|s| format!("`{s}`")).collect::<Vec<_>>().join(", ")
        ));
    }
    why
}

/// The component's OWN module source — its `source`, else a `srcText` that is a real module — or `None`
/// when neither (a built-in whose store `source` is stripped, #2794, or a usage-snippet spec). `kit_targets`
/// (the kit's component `src` paths) makes a `srcText` that imports SIBLINGS count as a real (composing)
/// module (#3112), so the health checks scan exactly the source the preview builds. Mirrors `ownModuleSource`
/// (graphHealth.ts).
fn own_module_source<'a>(node: &'a Node, kit_targets: &BTreeSet<String>) -> Option<&'a str> {
    if !node.source.trim().is_empty() {
        return Some(node.source.as_str());
    }
    if is_preview_buildable(&node.src_text, &node.src, kit_targets) {
        return Some(node.src_text.as_str());
    }
    None
}

/// Rust port of `looksBuildableModule` (componentPreview.ts, #2828): does `src_text` look like a
/// self-contained, buildable component MODULE rather than the usual usage snippet? Conservative — it
/// must declare an `export`, contain no `…` code-elision marker, and use no `@/` first-party import
/// (which has no dependency closure to resolve against here). Crate-visible so the write-time syntax
/// gate (#2928) reuses the SAME "is this a module?" test to decide whether to syntax-check a `srcText`.
///
/// It is now the boolean face of [`module_defects`] — the reasons ARE the predicate, so the write-time
/// gate can NAME why it treated a `srcText` as a spec instead of silently skipping it (#3470).
pub(crate) fn looks_buildable_module(src_text: &str) -> bool {
    !src_text.trim().is_empty() && module_defects(src_text).is_empty()
}

/// Every reason `src_text` is NOT a self-contained, buildable component module — empty when it IS one
/// (so `defects.is_empty()` is exactly [`looks_buildable_module`] for a non-blank source). Reason-first
/// rather than bool-first because of #3470: `bsc ui set` used to SKIP its syntax gate whenever this
/// predicate was false, so the source least like a module — one that keeps its unresolved `@/…` imports —
/// got the LEAST validation and stored with no complaint at all, surfacing only much later as a
/// `no-implementation` finding in `bsc ui doctor`. Storing a spec-only record stays legitimate; it just
/// has to be a STATED outcome, which needs the reasons this returns. Mirrors `bsc_ui::harvest`'s
/// `buildability`, which reports the same three defects for a harvested candidate.
///
/// A blank source is NOT a defect here (it returns no reasons): "this record carries no `srcText`" is a
/// different, legitimate state, and every caller checks it first.
pub(crate) fn module_defects(src_text: &str) -> Vec<String> {
    let s = src_text.trim();
    let mut why = Vec::new();
    if s.is_empty() {
        return why;
    }
    if !contains_word(s, "export") {
        why.push("no `export` — the preview has nothing to import and mount".to_string());
    }
    if has_code_elision(s) {
        why.push("a `…` elision marker stands in for omitted code — a sketch, not compilable code".to_string());
    }
    if s.contains("\"@/") || s.contains("'@/") {
        let named = internal_specifiers(s);
        let list = if named.is_empty() {
            String::new()
        } else {
            format!(" ({})", named.iter().map(|m| format!("`{m}`")).collect::<Vec<_>>().join(", "))
        };
        why.push(format!(
            "unresolved first-party `@/…` import(s){list} — there is no dependency closure to resolve them against"
        ));
    }
    why
}

/// The distinct `@/…` module specifiers `src_text` imports, in source order and de-duplicated — used
/// only to NAME them in a [`module_defects`] reason (the defect itself is decided by the coarser
/// substring test above, which is what the preview gate uses, so the message can never contradict it).
fn internal_specifiers(src_text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for spec in import_specifiers(src_text) {
        if spec.starts_with("@/") && !out.iter().any(|s| s == &spec) {
            out.push(spec);
        }
    }
    out
}

/// Does `…` appear in real CODE — not inside a string/template literal or a comment? Only then is it an
/// elision marker standing in for omitted code. The plain substring test this replaced (#3470) is a
/// MEASURED false-positive generator, not a hypothetical one: `…` is ordinary UI copy
/// (`placeholder="Select…"`) and ordinary doc-comment prose, and over this repo's own `src/shared/ui` it
/// condemned 13 perfectly good components as sketches. Condemning a real component over the ellipsis in
/// its placeholder text is a false accusation someone then has to overrule, so both contexts are skipped.
///
/// Lives here, in the crate that owns the buildability predicates, so `bsc_ui::harvest` (which found the
/// false positives) and the write-time gate share ONE scanner rather than drifting copies.
pub fn has_code_elision(src: &str) -> bool {
    let b: Vec<char> = src.chars().collect();
    let (mut i, n) = (0usize, b.len());
    while i < n {
        match b[i] {
            '/' if i + 1 < n && b[i + 1] == '/' => {
                while i < n && b[i] != '\n' {
                    i += 1;
                }
            }
            '/' if i + 1 < n && b[i + 1] == '*' => {
                i += 2;
                while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(n);
            }
            quote @ ('"' | '\'' | '`') => {
                i += 1;
                while i < n && b[i] != quote {
                    // A backslash escapes the next char, so an escaped quote doesn't end the literal.
                    i += if b[i] == '\\' { 2 } else { 1 };
                }
                i += 1;
            }
            // An ellipsis DIRECTLY after a word character is PROSE, not an elision marker (#3897) — JSX
            // text like `>Loading projects…</Text>` is not quoted, so the string-skip above misses it, and
            // ProjectsPage read as "a sketch, not compilable code" over three UI labels while the app
            // mounted it fine. A real marker sits in code position (`{ … }`, or alone on a line).
            '…' if b[..i].iter().rev().find(|c| !c.is_whitespace()).is_some_and(|c| c.is_alphanumeric()) => {
                i += 1;
            }
            '…' => return true,
            _ => i += 1,
        }
    }
    false
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
/// The identifiers an `import` statement BINDS in `source` — the names inside `{ … }`, a default binding,
/// and a `* as X` namespace. Used by `reimplemented-component` (#3892) to skip a node that legitimately
/// imports the name it also mentions, so only a genuine local RE-DECLARATION is flagged.
///
/// Deliberately loose: it scans the header text of each `import … from` and takes every identifier that is
/// not a keyword. Over-collecting only ever SUPPRESSES a finding, which is the safe direction for a check
/// whose false positives are worse than its misses.
fn imported_identifiers(source: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for line_start in source.match_indices("import ").map(|(i, _)| i) {
        // Only a real statement start (line-initial, bar whitespace) — not `.import` or a string body.
        let before = source[..line_start].chars().rev().take_while(|c| !matches!(c, '\n')).all(char::is_whitespace);
        if !before {
            continue;
        }
        let rest = &source[line_start..];
        let Some(from_at) = rest.find(" from ") else { continue };
        let header = &rest[..from_at];
        let mut ident = String::new();
        for c in header.chars() {
            if c.is_alphanumeric() || c == '_' || c == '$' {
                ident.push(c);
            } else {
                if !ident.is_empty() && !matches!(ident.as_str(), "import" | "type" | "as") {
                    out.insert(std::mem::take(&mut ident));
                } else {
                    ident.clear();
                }
            }
        }
        if !ident.is_empty() && !matches!(ident.as_str(), "import" | "type" | "as") {
            out.insert(ident);
        }
    }
    out
}

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
fn is_self_referential_stub(node: &Node, kit_targets: &BTreeSet<String>) -> bool {
    // The component's OWN module source (sibling-aware, #3112). A non-module usage snippet is already
    // `no-implementation`; a built-in's stripped source isn't ours.
    let Some(src) = own_module_source(node, kit_targets) else {
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
/// How to run [`analyze_with`] — the injected state the packaged seeds can't supply (#3412).
#[derive(Debug, Default, Clone, Copy)]
pub struct HealthOptions<'a> {
    /// The PINNED sound kit's artifact JSON — the kit a `@bsc/sounds/<id>` reference resolves against for
    /// this project, mirroring the frontend's `SoundKitSelection`. `None` = no pin ⇒ the packaged default
    /// kit (the documented default, byte-identical to pre-#3412 behavior).
    ///
    /// FAIL LOUDLY, never a silent degrade: a caller holding a pin it could not resolve must NOT pass
    /// `None` (that would quietly report against the starter kit, and the user cannot hear the
    /// difference) — it should refuse to run. `bsc ui doctor --sound-kit` does exactly that.
    /// A malformed artifact yields an empty name set, so every `@bsc/sounds/…` is flagged — fail safe.
    pub sound_kit_json: Option<&'a str>,
}

/// The hardcoded COLOR literals in `text` (#3704, the theme-adherence check) — the leak candidates a theme
/// change can NOT reach (a `var(--token)` carries none): a 6- or 8-digit hex (`#rrggbb` / `#rrggbbaa`) or an
/// `rgb(` / `rgba(` / `hsl(` / `hsla(` / `oklch(` / `oklab(` function. Deliberately conservative — a 3-digit
/// `#219` (an issue ref) is skipped, named colors + values in comments aren't caught. Mirrors `colorLiterals`
/// (TS) + `bsc ui`'s `count_color_literals` (reimplemented here — this crate can't depend on `bsc-ui`).
fn color_literals(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        if b[i] == b'#' {
            let mut j = i + 1;
            while j < n && b[j].is_ascii_hexdigit() {
                j += 1;
            }
            let len = j - i - 1;
            if len == 6 || len == 8 {
                out.push(text[i..j].to_string());
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    let lower = text.to_ascii_lowercase();
    for kw in ["rgb(", "rgba(", "hsl(", "hsla(", "oklch(", "oklab("] {
        for _ in 0..lower.matches(kw).count() {
            out.push(kw.trim_end_matches('(').to_string());
        }
    }
    out
}

/// Does `text` reference a THEME TOKEN — a `var(--…)` design-token consumer? A component that does is
/// considered wired to the theme (it re-themes with the active palette); one that hardcodes colors and has
/// NONE is the `hardcoded-color` finding (#3704). Mirrors `usesThemeToken` (TS).
fn uses_theme_token(text: &str) -> bool {
    text.contains("var(--")
}

/// The JS unicode/hex escapes in `src` that sit in CODE position — OUTSIDE any string literal, template,
/// or comment (#3709). A `\uXXXX` / `\u{H+}` / `\xHH` here is almost always a JSX-**text** leak: JSX
/// children text is not a JS string literal, so the escape is never interpreted — the browser renders the
/// literal 6 characters `backslash-u-0-0-b-7`, not the `·` glyph. It passes the syntax check (valid JS)
/// and stores clean, so only a screenshot catches it. String/comment-aware (mirrors `has_code_elision`'s
/// scanner), so the CORRECT forms — a real `·` UTF-8 char, or the JSX `{"·"}` — are NOT flagged (the
/// escape lives inside a string there, or there is no escape at all). Conservative: a lone `\u` in a regex
/// literal is a rare false
/// positive, tolerable for an advisory. Mirrors `jsxTextEscapeLeaks` (there is no TS twin — this is a
/// write-time advisory, Rust-only).
pub fn jsx_text_escape_leaks(src: &str) -> Vec<String> {
    let b: Vec<char> = src.chars().collect();
    let (mut i, n) = (0usize, b.len());
    let mut out = Vec::new();
    while i < n {
        match b[i] {
            '/' if i + 1 < n && b[i + 1] == '/' => {
                while i < n && b[i] != '\n' {
                    i += 1;
                }
            }
            '/' if i + 1 < n && b[i + 1] == '*' => {
                i += 2;
                while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(n);
            }
            quote @ ('"' | '\'' | '`') => {
                i += 1;
                while i < n && b[i] != quote {
                    // A backslash escapes the next char — an escaped quote does not end the literal,
                    // and a `·` INSIDE the string (the correct form) is consumed here, never flagged.
                    i += if b[i] == '\\' { 2 } else { 1 };
                }
                i += 1;
            }
            '\\' if i + 1 < n && (b[i + 1] == 'u' || b[i + 1] == 'x') => {
                let is_u = b[i + 1] == 'u';
                let start = i;
                let mut j = i + 2;
                if is_u && j < n && b[j] == '{' {
                    // `\u{H+}` — code-point escape.
                    j += 1;
                    while j < n && b[j].is_ascii_hexdigit() {
                        j += 1;
                    }
                    if j < n && b[j] == '}' {
                        j += 1;
                    } else {
                        // Malformed (no closing `}`) — not an escape, step past the backslash only.
                        i += 1;
                        continue;
                    }
                } else {
                    // `\uHHHH` (4 hex) or `\xHH` (2 hex). Only a leak if the hex digits are actually there;
                    // a bare `\u` with no digits is a syntax error the write gate rejects separately.
                    let want = if is_u { 4 } else { 2 };
                    let mut got = 0;
                    while got < want && j < n && b[j].is_ascii_hexdigit() {
                        j += 1;
                        got += 1;
                    }
                    if got < want {
                        i += 1;
                        continue;
                    }
                }
                out.push(b[start..j].iter().collect::<String>());
                i = j;
            }
            _ => i += 1,
        }
    }
    out
}

/// [`analyze_with`] against the packaged seeds — the unpinned default (see [`HealthOptions`]).
pub fn analyze(components: &[Value]) -> Vec<Finding> {
    analyze_with(components, &HealthOptions::default())
}

/// The graph-health analyzer, run against a specific library context (#3412) — the Rust twin of
/// `analyzeGraphHealth(comps, libResolver)`. Both sides take the SAME pinned sound kit, so a reference
/// that resolves in the Design Studio resolves here too.
pub fn analyze_with(components: &[Value], opts: &HealthOptions) -> Vec<Finding> {
    // The pinned kit's importable names when a pin is supplied, else the packaged default kit's.
    let sounds = match opts.sound_kit_json {
        Some(json) => sound_library_names_from(json),
        None => sound_library_names().clone(),
    };
    let nodes: Vec<Node> = components.iter().filter_map(parse_node).collect();
    let mut by_kit: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for n in &nodes {
        by_kit.entry(n.kit.as_str()).or_default().push(n);
    }
    let buildable = buildable_srcs();
    let mut out = Vec::new();
    for (kit, kit_nodes) in by_kit {
        analyze_kit(kit, &kit_nodes, buildable, &sounds, &mut out);
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

/// A dead-root finding the auto-prune plan deliberately WITHHELD (#3087). It is still REPORTED by
/// `bsc ui doctor` — the read-only diagnosis stays complete — but `--fix` will never remove it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PruneSkip {
    pub id: String,
    pub name: String,
    /// Which guard held it back, in prose (printed by `--fix` so the withholding is never silent).
    pub guard: String,
}

/// The auto-prune plan: what `--fix` MAY remove, and what a guard held back (#3087).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PrunePlan {
    pub prune: Vec<Prunable>,
    pub skipped: Vec<PruneSkip>,
}

/// Is the `used` reuse-count index POPULATED for this component set — does ANY node carry `used > 0`?
///
/// `used` is a cross-codebase reuse count that no writer currently maintains: the packaged kit artifact
/// ships every component at `used: 0` and nothing increments it, so on a real install the whole store
/// reads zero. A store where NOTHING is used is therefore not a store full of dead components — it is a
/// store with **no usage signal at all**, and `used == 0` there means UNKNOWN, not unused (#3087).
/// Judged over the components HANDED IN, so a `--kit`-scoped call can only ever prune LESS.
pub fn usage_index_populated(components: &[Value]) -> bool {
    components.iter().filter_map(parse_node).any(|n| n.used > 0)
}

/// The safe-to-remove set (#2679): the ROOT of every orphan / dangling-branch finding — a node with
/// no composer and `used == 0`. Deliberately NOT the branch DESCENDANTS (one might be shared by a live
/// component): removing the roots and re-running `doctor` surfaces any newly-orphaned children on the
/// next pass. Cycles, duplicates, and no-implementation findings are never auto-pruned (they need a
/// human's merge/break/author call). By construction a `used > 0` node can never appear here.
///
/// See [`prune_plan`] for the three safety guards this set is filtered through.
pub fn prunable(components: &[Value]) -> Vec<Prunable> {
    prune_plan(components).prune
}

/// The guarded auto-prune plan (#3087). Every orphan / dangling-branch ROOT is a *candidate*; three
/// guards decide whether it may actually be removed, because the dead-root heuristic (`in-degree 0 AND
/// used == 0`) has three known FALSE-POSITIVE classes — and epic #3087 wires a curator to run `--fix`
/// automatically, which turns each of them into unattended data loss:
///
/// 1. **A `page` is a root BY DEFINITION** — nothing composes a page; that is what makes it a page. The
///    heuristic condemns the whole pages tier (#2505) on principle. (The orphan arm already refuses to
///    flag an isolated page/layout as "entry point by role"; the dangling-branch arm did not, so a page
///    that composes anything at all — i.e. every real page — landed in the prune plan.)
/// 2. **A packaged `builtin: true` seed is not garbage** — the viz kits' demo components (#3194/#3242)
///    are isolated ON PURPOSE, to demo their kit's motion. Removing one only invites the seed reconcile
///    to re-add it on the next launch, so the "optimization" is a no-op that churns the store.
/// 3. **An unpopulated usage index is UNKNOWN, not unused** — see [`usage_index_populated`]. When no
///    node in scope carries `used > 0` the usage half of the heuristic carries no information, and
///    in-degree alone must not condemn a node.
///
/// A guarded candidate moves to `skipped` rather than vanishing: `doctor` still REPORTS the finding
/// (the diagnosis is useful), only the automatic removal is withheld.
pub fn prune_plan(components: &[Value]) -> PrunePlan {
    let nodes: Vec<Node> = components.iter().filter_map(parse_node).collect();
    let by_id: BTreeMap<&str, &Node> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let usage_known = nodes.iter().any(|n| n.used > 0);

    let mut plan = PrunePlan::default();
    for f in analyze(components) {
        if !matches!(f.category, "orphan" | "dangling-branch") {
            continue;
        }
        let Some(id) = f.node_ids.into_iter().next() else { continue };
        let name = f.node_names.into_iter().next().unwrap_or_default();
        let node = by_id.get(id.as_str());
        let guard = if !usage_known {
            Some(
                "the usage index is unpopulated — NOTHING in scope has `used` > 0, so `used = 0` means \
                 UNKNOWN, not unused",
            )
        } else if node.is_some_and(|n| n.role == "page") {
            Some("a `page` is a root BY DEFINITION — nothing composes a page; that is what makes it a page")
        } else if node.is_some_and(|n| n.builtin) {
            Some("a packaged built-in seed — it is shipped on purpose and the seed reconcile re-adds it")
        } else {
            None
        };
        match guard {
            Some(guard) => plan.skipped.push(PruneSkip { id, name, guard: guard.to_string() }),
            None => plan.prune.push(Prunable { id, name, reason: f.why }),
        }
    }
    plan
}

/// A byte-identical MERGE group (#3089, epic #3087) — the OPTIMIZE analog of a [`Prunable`]: the safe,
/// mechanical dedup the curator's optimize command applies. Components in a kit sharing byte-identical
/// non-empty `srcText` ARE the same component (e.g. two projects harvested the same Button), so the group
/// folds into ONE canonical — the most-`used` (tie-broken by smallest id, deterministic) — and the rest
/// are removed. Only byte-identical is auto-merged: a same-`wraps` "duplicate" finding is a WEAKER signal
/// (two DIFFERENT implementations of one intrinsic) that needs the curator's semantic judgment, so it is
/// NOT merged here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeGroup {
    pub kit: String,
    pub canonical_id: String,
    pub canonical_name: String,
    /// The merged-away duplicates (removed from the store), each `(id, name)`.
    pub removed: Vec<(String, String)>,
}

/// The full byte-identical merge plan (#3089): the groups to fold + every composer record whose
/// `composes` must be repointed from a removed dup's NAME to the canonical's NAME. `repoints` carries the
/// FULL rewritten record (all fields preserved, only `composes` edited) so the caller writes it verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MergePlan {
    pub groups: Vec<MergeGroup>,
    pub repoints: Vec<(String, Value)>,
}

/// Plan the safe, MECHANICAL merge of byte-identical duplicate components (#3089) — the curator's
/// optimize step, so 'keep the graph minimal' is a COMMAND, not hand-organization. Per kit: group nodes
/// by non-empty `srcText`; a group of 2+ folds into the most-`used` canonical (tie-break smallest id),
/// removing the rest and repointing every composer's `composes` from a removed NAME → the canonical NAME
/// (deduped; a resulting self-reference is dropped). Pure — APPLYING the plan (store writes) is the
/// caller's. Deterministic ordering (kit+source sort). Never touches a cycle / same-`wraps` dup.
pub fn merge_plan(components: &[Value]) -> MergePlan {
    let nodes: Vec<Node> = components.iter().filter_map(parse_node).collect();
    let raw_by_id: BTreeMap<&str, &Value> = components
        .iter()
        .filter_map(|v| v.get("id").and_then(Value::as_str).map(|id| (id, v)))
        .collect();

    // Group by (kit, srcText) — byte-identical source within a kit (edges never cross kits).
    let mut by_src: BTreeMap<(&str, &str), Vec<&Node>> = BTreeMap::new();
    for n in &nodes {
        if !n.src_text.trim().is_empty() {
            by_src.entry((n.kit.as_str(), n.src_text.as_str())).or_default().push(n);
        }
    }

    let mut groups: Vec<MergeGroup> = Vec::new();
    let mut remap: BTreeMap<(String, String), String> = BTreeMap::new(); // (kit, removedName) → canonicalName
    let mut removed_ids: BTreeSet<String> = BTreeSet::new();
    for ((kit, _src), group) in &by_src {
        if group.len() < 2 {
            continue;
        }
        // Canonical = most-used; tie-break the SMALLEST id (so the pick is deterministic + stable).
        let canonical = group
            .iter()
            .max_by(|a, b| a.used.cmp(&b.used).then_with(|| b.id.cmp(&a.id)))
            .unwrap();
        let mut removed: Vec<(String, String)> = Vec::new();
        for n in group {
            if n.id != canonical.id {
                removed.push((n.id.clone(), n.name.clone()));
                removed_ids.insert(n.id.clone());
                remap.insert(((*kit).to_string(), n.name.clone()), canonical.name.clone());
            }
        }
        if !removed.is_empty() {
            groups.push(MergeGroup {
                kit: (*kit).to_string(),
                canonical_id: canonical.id.clone(),
                canonical_name: canonical.name.clone(),
                removed,
            });
        }
    }

    // Repoint composers: any SURVIVING node whose `composes` references a removed NAME (same kit) → the
    // canonical NAME, deduped; an edge the remap turns into a self-reference is dropped.
    let mut repoints: Vec<(String, Value)> = Vec::new();
    for n in &nodes {
        if removed_ids.contains(&n.id) {
            continue;
        }
        let mut changed = false;
        let mut new_composes: Vec<String> = Vec::new();
        for dep in &n.composes {
            let mapped = remap.get(&(n.kit.clone(), dep.clone())).cloned().unwrap_or_else(|| dep.clone());
            if &mapped != dep {
                changed = true;
            }
            if mapped == n.name || new_composes.contains(&mapped) {
                changed = true; // dropped a self-reference or a duplicate edge produced by the remap
            } else {
                new_composes.push(mapped);
            }
        }
        if changed {
            if let Some(raw) = raw_by_id.get(n.id.as_str()) {
                let mut v = (*raw).clone();
                v["composes"] = Value::Array(new_composes.into_iter().map(Value::String).collect());
                repoints.push((n.id.clone(), v));
            }
        }
    }

    MergePlan { groups, repoints }
}

fn analyze_kit(
    kit: &str,
    nodes: &[&Node],
    buildable: &BTreeSet<String>,
    // The importable `@bsc/sounds/…` names for THIS run — the pinned kit's, else the packaged default's.
    sounds: &BTreeSet<String>,
    out: &mut Vec<Finding>,
) {
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

    // What a component's internal (`@/`, `./`) import resolves to when the preview BUILDS it — the Rust
    // mirror of `componentPreviewFiles`'s resolution (#43/#3660): this kit's component `src` paths, the
    // packaged artifact's built-in sources + runtime closure (the app's real modules), AND every graph
    // component's `provides` specifier (a graph-source primitive importing a sibling resolves exactly as the
    // runtime loader does). So a graph-source component composing siblings + app utilities builds — and is
    // scanned as the module it is — instead of being falsely flagged no-implementation (#3112).
    let kit_targets: BTreeSet<String> = {
        let mut t = internal_targets().clone();
        t.extend(nodes.iter().map(|n| n.src.clone()).filter(|s| !s.is_empty()));
        for n in nodes {
            if let Some(base) = resolve_internal_base(&n.provides, "") {
                t.insert(format!("{base}.tsx"));
            }
            // #3897: `@/components/<node-id>` is the loader's SIBLING-BY-ID form — how a migrated page
            // pulls in its panels (`@/components/security-profiles`). It is neither a `src` path nor a
            // registered module, so `securitypage` read as no-implementation while the app mounted it.
            // Injected as a synthetic target so the ordinary resolver finds it.
            t.insert(format!("components/{}.tsx", n.id));
        }
        t
    };

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
        if is_buildable(n, buildable, &kit_targets) {
            continue;
        }
        out.push(Finding {
            category: "no-implementation",
            severity: 3,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` has no buildable implementation — the preview can't render it (a spec, not code): {}",
                n.name,
                no_implementation_reasons(n, &kit_targets).join("; ")
            ),
            suggested_action: format!(
                "author a self-contained module for `{}` (its own `source`/`srcText`) or compose it from built-in kit components",
                n.name
            ),
        });
    }

    // ── hardcoded-color (severity 1, #3704): a component NOT wired to the theme — its own source hardcodes
    // color literals (hex / rgb / hsl / oklch) and references NO `var(--…)` design token, so it won't follow
    // the active theme/preset (the contract is "components reference ONLY semantic tokens, never raw
    // colors"). Built-ins are skipped (their store record is a curated snippet, not the real source). Uses
    // the node's own source (`source` else `srcText`) — independent of buildability, so an unthemed mobile
    // component is flagged whether or not its imports resolve standalone. Mirrors `analyzeGraphHealth` (TS).
    for n in nodes {
        if n.builtin {
            continue;
        }
        let src = if !n.source.trim().is_empty() { n.source.as_str() } else { n.src_text.as_str() };
        if src.trim().is_empty() || uses_theme_token(src) {
            continue;
        }
        let colors = color_literals(src);
        if colors.is_empty() {
            continue;
        }
        let sample = colors.iter().take(4).map(|c| format!("`{c}`")).collect::<Vec<_>>().join(", ");
        let more = if colors.len() > 4 { format!(", +{}", colors.len() - 4) } else { String::new() };
        out.push(Finding {
            category: "hardcoded-color",
            severity: 1,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` hardcodes {} color literal{} ({sample}{more}) and references no theme token — it won't follow the active theme/preset",
                n.name,
                colors.len(),
                if colors.len() == 1 { "" } else { "s" },
            ),
            suggested_action:
                "replace the raw colors with `var(--…)` design tokens (e.g. `var(--fg)`, `var(--bg-panel)`, `var(--accent)`; see `bsc ui tokens`) so it re-themes with the palette".to_string(),
        });
    }

    // ── self-reference (severity 3): an own-module component whose only rendered element is ITSELF
    // (`<Name/>`). It passes the buildability check (it has an `export`, so no-implementation is blind to
    // it) and the write-time syntax gate (it's valid), yet it produces no output and recurses forever —
    // the class the designer hit authoring D3 components as self-calls (#3026).
    for n in nodes {
        if !is_self_referential_stub(n, &kit_targets) {
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
    // was broken). Kinds (#2934 bare, #2954 internal, #3116 library):
    //   • BARE npm (#3696) — a package not among the curated preview externals no longer FAILS: the preview
    //     bundles a local shim/stub for it, so it renders APPROXIMATELY. Emitted as a severity-1
    //     `stubbed-import` NOTE (not the old sev-3 error) so the designer knows the preview isn't the real
    //     package. Only INTERNAL/LIBRARY below are genuine (sev-3 `unresolvable-import`) — they have no stub.
    //   • INTERNAL — a `@/…` or RELATIVE import resolving to NEITHER a kit component NOR a runtime-closure
    //     module → "module not found" (exactly the `Code`→`../typography/type` / `Skeleton`→`./shimmer`
    //     failure #2954 fixed in the packaged closure; this catches any future/user-authored recurrence).
    //   • LIBRARY (#3116) — a `@bsc/<segment>/<name>` cross-graph reference (the THIRD class, neither npm
    //     nor first-party) naming NO real library node. A `@bsc/algorithms/<name>` matching a real algorithm
    //     is a NEW resolvable class (the preview vendors its code), NEVER flagged; only a missing one is.
    // Scanned on own-source components (a built-in's `source`, or a `looks_buildable_module` srcText) — the
    // source the preview actually builds. Resolution uses `kit_targets` (the full build set: artifact +
    // node srcs + `provides`, #43), so a graph-source import resolves here exactly as the build does.
    // Mirrors `graphHealth.ts`.
    for n in nodes {
        let Some(src) = own_module_source(n, &kit_targets) else {
            continue;
        };
        let resolvable = resolvable_specifiers();
        let specs = import_specifiers(src);
        // A `@bsc/…` LIBRARY reference (#3116) is bare-shaped but resolves against the algorithms store, NOT
        // the import-map — so it's excluded from `stubbed` and judged by `resolves_library` (a match ⇒ the
        // preview vendors its code ⇒ clean; a `@bsc/algorithms/<missing>` ⇒ flagged here).
        let mut library: Vec<String> =
            specs.iter().filter(|s| is_library_specifier(s) && !resolves_library(s, sounds)).cloned().collect();
        // A BARE npm specifier that isn't a curated preview external (#3696): it no longer FAILS — the
        // preview bundles a local shim/stub for any such import (react-native → real layout, react-native-svg
        // → real SVG, else a universal passthrough), so nothing throws "Failed to resolve module specifier".
        // It renders APPROXIMATELY (a stub, not the real package) → a severity-1 note, not the old sev-3 error.
        let mut stubbed: Vec<String> = specs
            .iter()
            .filter(|s| is_bare_specifier(s) && !is_library_specifier(s) && !resolvable.contains(*s))
            .cloned()
            .collect();
        let mut internal: Vec<String> = specs
            .iter()
            .filter(|s| is_internal_specifier(s) && !platform_modules().contains(*s) && !resolves_internal(s, &n.src, &kit_targets))
            .cloned()
            .collect();
        for v in [&mut stubbed, &mut library, &mut internal] {
            v.sort();
            v.dedup();
        }
        let fmt = |v: &[String]| v.iter().map(|s| format!("`{s}`")).collect::<Vec<_>>().join(", ");
        // GENUINELY unresolvable (severity 3): a first-party `@/…`/relative module mapping to no kit
        // component or runtime file, or a `@bsc/…` library reference naming no real node. Unlike a bare npm
        // import, these have NO stub fallback — the preview really can't build them.
        if !library.is_empty() || !internal.is_empty() {
            let mut reasons = Vec::new();
            let mut actions = Vec::new();
            if !library.is_empty() {
                reasons.push(format!("{} (no matching node in the library)", fmt(&library)));
                actions.push(format!(
                    "reference an EXISTING library node for {} (e.g. `@bsc/algorithms/fibonacci`), or author it in the library",
                    fmt(&library)
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
        // STUBBED npm imports (severity 1): the component renders, but the package is a local shim/stub, not
        // the real thing — informational so the designer knows the preview is approximate (#3696).
        if !stubbed.is_empty() {
            out.push(Finding {
                category: "stubbed-import",
                severity: 1,
                kit: kit.to_string(),
                node_ids: vec![n.id.clone()],
                node_names: vec![n.name.clone()],
                why: format!(
                    "`{}` imports {} — not a curated preview external, so the preview renders it via a bundled-in local shim/stub (approximate, not the real package)",
                    n.name,
                    fmt(&stubbed)
                ),
                suggested_action: format!(
                    "acceptable for most native/app packages; if {} needs its REAL behaviour in the preview, add it to the curated externals (src-tauri/data/ui/preview-importmap.json)",
                    fmt(&stubbed)
                ),
            });
        }
    }

    // ── reimplemented-component (severity 3, #3892): the SAME "compose, don't recreate" guardrail as
    // `reimplementation` below, one dimension over — an own-source component that DECLARES a name which is
    // already a COMPONENT NODE in this graph. The algorithm version has existed since #3118; the component
    // version did not, which is how 36 of 74 harvested records came to carry a local `function Box` while a
    // `Box` node sat in the same kit. They render — as a STUB Box, not the kit's — so the page looks right
    // and every later revision iterates on the reduced copy (the #3833 failure mode).
    //
    // The provenance is promotion, not harvest: `bsc ui harvest` reports such a candidate as
    // `buildable: false` with the exact unresolved specifiers and never stubs them. This catches the hand
    // "resolution" that satisfies buildability by faking the import.
    //
    // Conservative, matching its sibling: EXACT whole-identifier declaration, on the source the preview
    // builds, never self, and SKIPPED when the source already imports that identifier (a component may
    // legitimately re-export or alias). Mirrors graphHealth.ts.
    {
        for n in nodes {
            let Some(src) = own_module_source(n, &kit_targets) else {
                continue;
            };
            let imported = imported_identifiers(src);
            // SAME-FILE siblings are not stubs (#3895). Several nodes are routinely extracted from ONE
            // module — `AgentFace` and `TeamsCanvas` both come from TeamsCanvas.tsx — so that module's
            // closure legitimately CONTAINS both declarations. Flagging them would demand an import of the
            // file from itself. Only a target from a DIFFERENT source is a re-declaration.
            let mut recoded: Vec<&str> = nodes
                .iter()
                .filter(|t| t.name != n.name && (n.src.is_empty() || t.src != n.src))
                .map(|t| t.name.as_str())
                .filter(|name| declares_symbol(src, name) && !imported.contains(*name))
                .collect();
            if recoded.is_empty() {
                continue;
            }
            recoded.sort_unstable();
            recoded.dedup();
            let list = recoded.iter().map(|x| format!("`{x}`")).collect::<Vec<_>>().join(", ");
            let one = recoded.len() == 1;
            out.push(Finding {
                category: "reimplemented-component",
                severity: 3,
                kit: kit.to_string(),
                node_ids: vec![n.id.clone()],
                node_names: vec![n.name.clone()],
                why: format!(
                    "`{}` declares {} locally, but {} already {} in this graph — the preview renders the LOCAL copy, so this node looks correct while composing a stub instead of the real component",
                    n.name,
                    list,
                    if one { "that name is" } else { "those names are" },
                    if one { "a node" } else { "nodes" },
                ),
                suggested_action: format!(
                    "import the real {} instead of re-declaring {} — if the import could not be resolved at promotion, register it as a platform module rather than stubbing it (`bsc ui harvest` flags an unclosable candidate as buildable:false for exactly this reason)",
                    if one { "component" } else { "components" },
                    if one { "it" } else { "them" },
                ),
            });
        }
    }

    // ── reimplementation (severity 3): the "compose, don't recreate" guardrail (#3118, epic #3114). An
    // own-source component that DECLARES a symbol whose name EXACTLY matches an existing LIBRARY ALGORITHM
    // is RE-CODING what it could import via `@bsc/algorithms/…` — an inline `function fibonacci` while
    // `@bsc/algorithms/fibonacci` already exists. #3116 made those references resolvable + vendorable (the
    // preview runs the library impl); this steers the designer to compose the ONE canonical node instead of
    // forking it. ALGORITHMS-ONLY (see `reimpl_targets`): sounds are excluded — a cue id like `click`
    // collides with common handler names. Conservative (false positives are worse than a miss): EXACT
    // whole-identifier match (`declares_symbol`), on the source the preview builds (`own_module_source`),
    // and SKIPPED when the component already imports that `@bsc/<segment>/<name>` node. Mirrors graphHealth.ts.
    for n in nodes {
        let Some(src) = own_module_source(n, &kit_targets) else {
            continue;
        };
        let specs: BTreeSet<String> = import_specifiers(src).into_iter().collect();
        let mut recoded: Vec<(String, String)> = Vec::new(); // (name, importSpec)
        for (name, segment) in reimpl_targets() {
            let import_spec = format!("@bsc/{segment}/{name}");
            if declares_symbol(src, name) && !specs.contains(&import_spec) {
                recoded.push((name.clone(), import_spec));
            }
        }
        if recoded.is_empty() {
            continue;
        }
        recoded.sort();
        recoded.dedup();
        let one = recoded.len() == 1;
        let list = recoded
            .iter()
            .map(|(name, spec)| format!("`{name}` (import `{spec}`)"))
            .collect::<Vec<_>>()
            .join(", ");
        let names = recoded.iter().map(|(name, _)| format!("`{name}`")).collect::<Vec<_>>().join(", ");
        let imports = recoded.iter().map(|(_, spec)| format!("`{spec}`")).collect::<Vec<_>>().join(", ");
        out.push(Finding {
            category: "reimplementation",
            severity: 3,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` re-codes {}: {} — compose {} from the library instead of re-coding (compose, don't recreate)",
                n.name,
                if one { "a library node that already exists" } else { "library nodes that already exist" },
                list,
                if one { "it" } else { "them" }
            ),
            suggested_action: format!(
                "import {} instead of re-declaring {} inline in `{}`",
                imports, names, n.name
            ),
        });
    }

    // ── unwired-prop (severity 2): a component that declares props its OWN module source never references
    // — a declared interface that does nothing (#2924). Only for a node whose own source is present (a
    // user-authored module: its `source`, or a buildable `srcText`); a built-in (source in the artifact)
    // or a spec (no buildable module) is skipped. Guard: require ≥1 prop REFERENCED (so it uses NAMED
    // props — not a `{...props}` spreader) before flagging the unreferenced ones. Mirrors `graphHealth.ts`.
    for n in nodes {
        let Some(src) = own_module_source(n, &kit_targets) else {
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

    // ── phantom-compose (severity 2): a component that DECLARES `composes` children its own source never
    // renders. The graph draws edges straight from `composes`, so a phantom edge claims a composition that
    // doesn't happen AND masks orphan detection (the phantom in-edge makes the child look used). Only
    // USER-authored components with own-module source: a built-in's store record is a contract catalog
    // (`source` stripped #2794, `srcText` an illustrative snippet), so scanning it would false-positive. A
    // SLOT-SHELL is exempt — its children legitimately arrive via a content slot. Mirrors graphHealth.ts (#3111).
    for n in nodes {
        if n.builtin || n.composes.is_empty() {
            continue;
        }
        let Some(src) = own_module_source(n, &kit_targets) else {
            continue; // no scannable module (a spec) → no-implementation owns it
        };
        if n.props.iter().any(|p| is_node_slot_prop(&p.0, &p.1)) {
            continue; // slot-shell: composes may arrive via a slot
        }
        let rendered = jsx_tag_names(src);
        if rendered.is_empty() {
            continue; // renders no JSX at all → a stub, not a phantom composition
        }
        let phantom: Vec<&str> =
            n.composes.iter().filter(|c| !rendered.contains(c.as_str())).map(String::as_str).collect();
        if phantom.is_empty() {
            continue;
        }
        let it = if phantom.len() == 1 { "it" } else { "them" };
        out.push(Finding {
            category: "phantom-compose",
            severity: 2,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` declares it composes {} but its source never renders {it} — a phantom composition edge (the graph draws a composition that doesn't happen, and the false edge hides the child from orphan detection)",
                n.name,
                phantom.join(", ")
            ),
            suggested_action: format!(
                "render {} in `{}`'s source, or drop {} from its `composes`",
                phantom.join(", "),
                n.name,
                if phantom.len() == 1 { "it" } else { "them" }
            ),
        });
    }

    // ── no-empty-state / no-loading-state / no-error-state (severity 1, INFORMATIONAL, #3135/#3555): the
    // preview's data-state switcher can only SHOW a state a component SUPPORTS. A DATA component (has a
    // collection/array prop), scanned from its own module source, is flagged when it lacks: (a) an EMPTY
    // render — no `EmptyState` and no `Array.isArray`/`.length` empty-guard; (b) a `loading`-family prop;
    // or (c) an `error`-family prop. Guides the designer session to add the missing state. Mirrors
    // `analyzeGraphHealth` (graphHealth.ts).
    for n in nodes {
        let Some(src) = own_module_source(n, &kit_targets) else {
            continue;
        };
        let collections: Vec<&str> =
            n.props.iter().filter(|p| is_collection_prop(&p.1)).map(|p| p.0.as_str()).collect();
        if collections.is_empty() {
            continue;
        }
        if !src.contains("EmptyState") && !src.contains("Array.isArray") && !src.contains(".length") {
            out.push(Finding {
                category: "no-empty-state",
                severity: 1,
                kit: kit.to_string(),
                node_ids: vec![n.id.clone()],
                node_names: vec![n.name.clone()],
                why: format!(
                    "`{}` takes data ({}) but renders no distinct EMPTY state (no EmptyState, no empty-data branch) — its empty preview shows the same as loaded",
                    n.name,
                    collections.join(", ")
                ),
                suggested_action: format!(
                    "add an EmptyState / empty-data render to `{}` so its empty state is viewable",
                    n.name
                ),
            });
        }
        if !n.props.iter().any(|p| is_loading_prop(&p.0, &p.1)) {
            out.push(Finding {
                category: "no-loading-state",
                severity: 1,
                kit: kit.to_string(),
                node_ids: vec![n.id.clone()],
                node_names: vec![n.name.clone()],
                why: format!(
                    "`{}` takes data ({}) but exposes no `loading` prop — the preview can't show its LOADING state",
                    n.name,
                    collections.join(", ")
                ),
                suggested_action: format!("add a boolean `loading` prop to `{}` that renders a skeleton", n.name),
            });
        }
        if !n.props.iter().any(|p| is_error_prop(&p.0, &p.1)) {
            out.push(Finding {
                category: "no-error-state",
                severity: 1,
                kit: kit.to_string(),
                node_ids: vec![n.id.clone()],
                node_names: vec![n.name.clone()],
                why: format!(
                    "`{}` takes data ({}) but exposes no `error` prop — the preview can't show its ERROR state",
                    n.name,
                    collections.join(", ")
                ),
                suggested_action: format!(
                    "add an `error` prop to `{}` (a message string or boolean) that renders an error state",
                    n.name
                ),
            });
        }
    }

    // ── no-analytics (severity 1, INFORMATIONAL, #3810): an INTERACTIVE component (exposes an action/event
    // prop the user can trigger) that declares NO analytics events. Instrumentation is a per-node data
    // CONTRACT — like the behavior/motion a node already carries — so every interactive node should
    // declare what it emits, and any app composed from these nodes is instrumented by construction.
    // Own-module (user-authored) only; built-ins are skipped (packaged separately). Mirrors the frontend
    // `analyzeGraphHealth` (graphHealth.ts).
    for n in nodes {
        if own_module_source(n, &kit_targets).is_none() {
            continue; // built-in / no user source — not the designer's to instrument in-session
        }
        if n.analytics_events > 0 {
            continue; // already declares events
        }
        let actions: Vec<&str> =
            n.props.iter().filter(|p| is_action_prop(&p.0, &p.1)).map(|p| p.0.as_str()).collect();
        if actions.is_empty() {
            continue; // not interactive — nothing to instrument
        }
        out.push(Finding {
            category: "no-analytics",
            severity: 1,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` is interactive ({}) but declares no analytics events — an app composed from it captures nothing when the user acts",
                n.name,
                actions.join(", ")
            ),
            suggested_action: format!(
                "add an `analytics` manifest to `{}` declaring the events it emits (e.g. a `click` event for its action) — data, not code",
                n.name
            ),
        });
    }

    // ── no-tests (severity 1, INFORMATIONAL, #3878): an IMPLEMENTED own-module component that carries no
    // tests. Tests are a per-node data contract — the same shape as the analytics manifest one field over —
    // because once a component's source is a store record compiled at runtime, a test file under `src/**` is
    // no longer beside the thing it tests. #3833 is the cost of that drift: the Skills record ran on a
    // preview-grade transcription for days because the page still LOOKED right and git no longer held what
    // shipped.
    //
    // Deliberately narrow, so this stays a useful suggestion rather than a finding on every node:
    //   · built-ins are skipped — packaged separately, not the designer's to test in-session (as no-analytics);
    //   · a SPEC-ONLY node is skipped — it already earns `no-implementation`, and nagging for tests over code
    //     that does not exist would be a second finding for one cause;
    //   · only INTERACTIVE nodes are flagged, the same line `no-analytics` draws. A component you can ACT on
    //     is one whose behaviour can regress; a pure display primitive is covered by the render/preview
    //     checks instead. Scoping it this way was not the first instinct — flagging every implemented node
    //     lit up essentially the whole graph, which the test suite caught immediately. Widening later (pages
    //     first) is a one-line change if the noise proves worth it.
    for n in nodes {
        if own_module_source(n, &kit_targets).is_none() {
            continue; // built-in, or spec-only — no implementation of ours to cover
        }
        if n.tests > 0 {
            continue; // already carries its tests
        }
        if !n.props.iter().any(|p| is_action_prop(&p.0, &p.1)) {
            continue; // not interactive — nothing actable to regress
        }
        out.push(Finding {
            category: "no-tests",
            severity: 1,
            kit: kit.to_string(),
            node_ids: vec![n.id.clone()],
            node_names: vec![n.name.clone()],
            why: format!(
                "`{}` is interactive and implemented but carries no tests — its source lives in the graph while anything covering it does not, so the node can be revised with nothing to catch a regression",
                n.name
            ),
            suggested_action: format!(
                "add a `tests` manifest to `{}` — an array of `{{ name, src }}`, data alongside the node like its analytics events",
                n.name
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

// ── motion checks (#3163, `bsc ui doctor --motion`) ──────────────────────────────────────────────────
// Four MECHANICAL faults an author used to hand-diagnose from a broken preview, surfaced from the data.
// They scan a component's INLINE animation defs (the object entries of `animations`; a name-ref string
// points at the shared kit library, which the doctor doesn't resolve, so it's skipped) against its
// rendered markup (`source` + `srcText`). The TS twin is `analyzeMotion` (graphHealth.ts) — keep both in
// lockstep (categories, severities, rules, the collision pass). Reported through the SAME `Finding` shape
// as the topology checks, so the CLI merges them under `--motion`.

/// The INLINE animation defs on a component's `animations` array — the object entries with a string
/// `name` (a name-ref string is skipped). Mirrors TS `inlineAnimations`.
fn inline_animations(v: &Value) -> Vec<&Value> {
    v.get("animations")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|e| e.is_object() && e.get("name").and_then(Value::as_str).is_some())
                .collect()
        })
        .unwrap_or_default()
}

/// The class HOOK tokens a `selector` targets — every `.<ident>` (`ident` = `[A-Za-z0-9_-]+`). Mirrors
/// the TS `selectorClasses` regex `/\.([A-Za-z0-9_-]+)/g`. #3163 check (a).
fn selector_classes(selector: &str) -> Vec<String> {
    let bytes = selector.as_bytes();
    let is_tok = |c: u8| (c as char).is_ascii_alphanumeric() || c == b'-' || c == b'_';
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'.' {
            let start = i + 1;
            let mut k = start;
            while k < bytes.len() && is_tok(bytes[k]) {
                k += 1;
            }
            if k > start {
                out.push(selector[start..k].to_string());
            }
            i = k.max(start); // past the token (or the lone `.`)
        } else {
            i += 1;
        }
    }
    out
}

/// The set of CSS declaration PROPERTIES an animation's keyframes touch. Mirrors TS `keyframeProps`.
fn keyframe_props(anim: &Value) -> BTreeSet<String> {
    let mut props = BTreeSet::new();
    if let Some(kf) = anim.get("keyframes").and_then(Value::as_object) {
        for decls in kf.values() {
            if let Some(obj) = decls.as_object() {
                for p in obj.keys() {
                    props.insert(p.clone());
                }
            }
        }
    }
    props
}

/// Whether `markup` contains an SVG `transform=` ATTRIBUTE — the literal `transform`, optional
/// whitespace, then `=` (mirrors the TS `/transform\s*=/`, substring, no word boundary). Distinct from a
/// CSS `transform:` declaration. #3163 check (c).
fn has_transform_attr(markup: &str) -> bool {
    let bytes = markup.as_bytes();
    let needle = b"transform";
    let mut i = 0;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let mut j = i + needle.len();
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'=' {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Analyze components for MOTION-graph faults (#3163) — the `bsc ui doctor --motion` checks, the Rust
/// twin of `analyzeMotion` (graphHealth.ts). Ranked most-severe first (stable name tiebreak). Pure.
/// Four checks: (a) `motion-dead-selector` (an animation `selector` whose class hook the source never
/// renders) · (b) `motion-dash-no-pathlength` (a stroke-dash keyframe on a component with no `pathLength`)
/// · (c) `motion-transform-attr` (a CSS `transform` keyframe on a component using an SVG `transform=`
/// attribute) · (d) `motion-name-collision` (an inline animation NAME declared by 2+ components in a kit).
pub fn analyze_motion(components: &[Value]) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();
    // (d) per-kit collision groups: (kit, animName) → owners [(id, name)], deduped by id, insertion order.
    let mut collisions: BTreeMap<(String, String), Vec<(String, String)>> = BTreeMap::new();

    for v in components {
        let id = match v.get("id").and_then(Value::as_str) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let name = {
            let n = s(v, "name");
            if n.is_empty() {
                id.clone()
            } else {
                n
            }
        };
        let kit = s(v, "kitId");
        let markup = format!("{}\n{}", s(v, "source"), s(v, "srcText"));
        let anims = inline_animations(v);
        if anims.is_empty() {
            continue;
        }
        for anim in &anims {
            let anim_name = s(anim, "name");
            let props = keyframe_props(anim);

            // (a) dead selector hook — the animation targets a class the source never renders.
            if let Some(selector) =
                anim.get("selector").and_then(Value::as_str).filter(|s| !s.is_empty())
            {
                let dead: Vec<String> = selector_classes(selector)
                    .into_iter()
                    .filter(|cls| !markup.contains(cls.as_str()))
                    .collect();
                if !dead.is_empty() {
                    let list = dead.iter().map(|d| format!("`.{d}`")).collect::<Vec<_>>().join(", ");
                    out.push(Finding {
                        category: "motion-dead-selector",
                        severity: 2,
                        kit: kit.clone(),
                        node_ids: vec![id.clone()],
                        node_names: vec![name.clone()],
                        why: format!(
                            "`{name}`'s animation `{anim_name}` targets {list} but its source renders no such element — the animation matches nothing (a dead selector hook)"
                        ),
                        suggested_action: format!(
                            "render the element `{anim_name}` targets in `{name}`'s source, or fix the animation's `selector`"
                        ),
                    });
                }
            }

            // (b) stroke-dash keyframe with no pathLength — a draw-in needs a known geometry length.
            let dash: Vec<&str> = props
                .iter()
                .filter(|p| p.as_str() == "stroke-dashoffset" || p.as_str() == "stroke-dasharray")
                .map(String::as_str)
                .collect();
            if !dash.is_empty() && !markup.to_ascii_lowercase().contains("pathlength") {
                let list = dash.iter().map(|d| format!("`{d}`")).collect::<Vec<_>>().join(", ");
                out.push(Finding {
                    category: "motion-dash-no-pathlength",
                    severity: 1,
                    kit: kit.clone(),
                    node_ids: vec![id.clone()],
                    node_names: vec![name.clone()],
                    why: format!(
                        "`{name}`'s animation `{anim_name}` animates {list} but its source sets no `pathLength` — a stroke-dash draw needs a known path length to animate predictably"
                    ),
                    suggested_action: format!(
                        "set `pathLength` on the animated path in `{name}` so its stroke-dash draw has a stable length"
                    ),
                });
            }

            // (c) CSS transform keyframe on a transform-ATTRIBUTED SVG element — the two don't compose.
            if props.contains("transform") && has_transform_attr(&markup) {
                out.push(Finding {
                    category: "motion-transform-attr",
                    severity: 1,
                    kit: kit.clone(),
                    node_ids: vec![id.clone()],
                    node_names: vec![name.clone()],
                    why: format!(
                        "`{name}`'s animation `{anim_name}` sets a CSS `transform` keyframe, but its source uses an SVG `transform=` ATTRIBUTE — CSS transforms and the SVG transform attribute don't compose (animate the attribute, or drop the attribute and transform via CSS)"
                    ),
                    suggested_action: format!(
                        "move the transform in `{name}` to CSS (drop the SVG `transform=` attribute), or animate the attribute instead of a CSS `transform` keyframe"
                    ),
                });
            }

            // (d) collect this inline name for the cross-component collision pass.
            if !anim_name.is_empty() {
                let owners = collisions.entry((kit.clone(), anim_name.clone())).or_default();
                if !owners.iter().any(|(oid, _)| oid == &id) {
                    owners.push((id.clone(), name.clone()));
                }
            }
        }
    }

    // (d) an inline animation NAME declared by 2+ components in a kit — a cross-component collision.
    for ((kit, anim_name), owners) in &collisions {
        if owners.len() < 2 {
            continue;
        }
        let mut sorted = owners.clone();
        sorted.sort_by(|a, b| a.1.cmp(&b.1));
        let names: Vec<String> = sorted.iter().map(|(_, n)| n.clone()).collect();
        out.push(Finding {
            category: "motion-name-collision",
            severity: 2,
            kit: kit.clone(),
            node_ids: sorted.iter().map(|(i, _)| i.clone()).collect(),
            node_names: names.clone(),
            why: format!(
                "inline animation `{anim_name}` is declared by {} components ({}) — same-named keyframes across components collide; namespace them (#3163) or lift the shared one into the kit's animation library",
                owners.len(),
                names.join(", ")
            ),
            suggested_action: format!(
                "namespace the per-component animations (#3163), or lift `{anim_name}` into the kit's shared animation library and reference it by name from each component"
            ),
        });
    }

    out.sort_by(|a, b| {
        b.severity.cmp(&a.severity).then_with(|| a.node_names.first().cmp(&b.node_names.first()))
    });
    out
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
    fn import_specifiers_ignores_a_from_field_in_object_data_and_a_from_call() {
        // #3687: a `from` OBJECT KEY (graph-edge demo data) or a `.from(` CALL is not an import. Renaming a
        // graph node's `id` used to move this false positive in lockstep (an edge's `from` value == the id),
        // which looked like the scanner keyed on `id`; it actually keyed on the `from` keyword.
        let src = "import React from \"react\";\n\
                   const DEMO_GRAPH = { edges: [{ from: 'agentA', to: 'reviewer-2' }] };\n\
                   const ids = Array.from('n1n2g1');\n\
                   export function View(){ return React.createElement('div'); }";
        let specs = import_specifiers(src);
        assert!(specs.contains(&"react".to_string()), "the real import still resolves");
        assert!(!specs.contains(&"agentA".to_string()), "a `from:` object key is not an import");
        assert!(!specs.contains(&"reviewer-2".to_string()), "the edge's `to` value is not an import");
        assert!(!specs.contains(&"n1n2g1".to_string()), "an `Array.from(` call arg is not an import");
        // The real forms all still capture (guarded alongside so the gate can't over-tighten).
        let real = import_specifiers(
            "import \"./side-effect\";\nexport { a } from \"pkg-a\";\nconst m = import(\"pkg-b\");\nimport X from\"pkg-c\";",
        );
        for want in ["./side-effect", "pkg-a", "pkg-b", "pkg-c"] {
            assert!(real.contains(&want.to_string()), "still captures {want}");
        }
    }

    #[test]
    fn notes_a_bare_npm_miss_as_stubbed_not_an_error() {
        // #3696: d3-scale (NOT a curated external) alongside react + lucide-react (both pinned). A bare npm
        // miss no longer FAILS — the preview bundles a local stub for it → a severity-1 `stubbed-import`
        // NOTE, never the old sev-3 `unresolvable-import` error.
        let comps = [json!({
            "id":"chart", "name":"Chart", "kitId":"k", "role":"composite", "used":2, "composes":[],
            "srcText":"import React from \"react\";\nimport { scaleLinear } from \"d3-scale\";\nimport { Icon } from \"lucide-react\";\nexport function Chart(){ return React.createElement(Icon, null, scaleLinear); }"
        })];
        let fs = analyze(&comps);
        let f = fs.iter().find(|f| f.category == "stubbed-import").expect("noted as stubbed");
        assert_eq!(f.severity, 1);
        assert!(f.why.contains("d3-scale"), "names the stubbed specifier");
        assert!(!f.why.contains("`react`") && !f.why.contains("`lucide-react`"), "pinned externals not listed");
        assert!(f.suggested_action.contains("preview-importmap"));
        assert!(!fs.iter().any(|f| f.category == "unresolvable-import"), "a bare npm miss is no longer an ERROR");
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
    fn an_absolute_url_import_is_clean_and_a_bare_miss_is_only_a_stub_note() {
        // #2963: a full esm.sh URL resolves DIRECTLY in the preview → never flagged. #3696: a bare package
        // missing from the curated externals (d3-scale) is a severity-1 `stubbed-import` NOTE, not an error.
        let comps = [
            json!({ "id":"chart", "name":"Chart", "kitId":"k", "role":"composite", "used":2, "composes":[],
                    "srcText":"import * as d3 from \"https://esm.sh/d3@7\";\nexport function Chart(){ return d3; }" }),
            json!({ "id":"bad", "name":"Bad", "kitId":"k", "role":"composite", "used":2, "composes":[],
                    "srcText":"import { scaleLinear } from \"d3-scale\";\nexport function Bad(){ return scaleLinear; }" }),
        ];
        let fs = analyze(&comps);
        assert!(!fs.iter().any(|f| f.category == "unresolvable-import"), "neither a URL nor a bare miss is an ERROR");
        let stubbed: Vec<_> = fs.iter().filter(|f| f.category == "stubbed-import").collect();
        assert_eq!(stubbed.len(), 1, "only the bare miss gets a stub note, not the esm.sh URL");
        assert_eq!(stubbed[0].node_names, ["Bad"]);
        assert!(stubbed[0].why.contains("d3-scale"));
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

    // ── #3116: the THIRD import class — @bsc/<segment>/<name> LIBRARY references ─────────────────────

    #[test]
    fn algo_library_names_indexes_ts_algorithms_by_name_and_id_only() {
        let json = r#"{"implementations":[
            {"id":"fibonacci.ts","tech":"typescript","role":"algorithm","name":"fibonacci","code":"export function fibonacci(){}"},
            {"id":"typescript.number","tech":"typescript","role":"primitive","name":"number","ref":"number"},
            {"id":"merge.rs","tech":"rust","role":"algorithm","name":"merge","code":"pub fn merge(){}"}
        ]}"#;
        let names = algo_library_names_from(json);
        assert!(names.contains("fibonacci") && names.contains("fibonacci.ts"), "a TS algorithm is indexed by name + id");
        assert!(!names.contains("number"), "a primitive (no code) is not importable → excluded");
        assert!(!names.contains("merge"), "a Rust algorithm is not in the typescript kit");
        assert!(algo_library_names_from("not json").is_empty(), "malformed seed → empty (fail safe)");
    }

    #[test]
    fn resolves_library_recognizes_a_real_algorithm_but_not_a_missing_one() {
        // A `@bsc/algorithms/<name>` reference resolves against the TS algorithm kit (bare name OR exact id);
        // a missing name, a graph with no vendor path here, and a bare npm spec never resolve.
        let sounds = sound_library_names();
        assert!(resolves_library("@bsc/algorithms/fibonacci", sounds), "the seeded TS fibonacci resolves by bare name");
        assert!(resolves_library("@bsc/algorithms/fibonacci.ts", sounds), "…and by exact id");
        assert!(!resolves_library("@bsc/algorithms/nope", sounds), "a missing algorithm does not resolve");
        assert!(!resolves_library("@bsc/ui/Sparkline", sounds), "a graph with no vendor path here does not resolve");
        assert!(!resolves_library("d3-scale", sounds), "a bare npm spec is not a library reference");
        assert!(is_library_specifier("@bsc/algorithms/fibonacci") && !is_library_specifier("@/x") && !is_library_specifier("d3"));
    }

    #[test]
    fn does_not_flag_a_resolvable_library_import_but_flags_a_missing_one() {
        // #3116 acceptance (Rust twin): a component importing @bsc/algorithms/fibonacci is CLEAN; one
        // importing @bsc/algorithms/nope is flagged unresolvable-import with the LIBRARY reason, never a
        // bare import-map miss. Both carry a real module srcText so no-implementation stays out of it.
        let comps = [
            json!({ "id":"fib", "name":"FibCard", "kitId":"react-ui", "role":"composite", "used":2, "composes":[],
                    "srcText":"import { fibonacci } from \"@bsc/algorithms/fibonacci\";\nexport function FibCard(){ return fibonacci(10); }" }),
            json!({ "id":"bad", "name":"BadCard", "kitId":"react-ui", "role":"composite", "used":2, "composes":[],
                    "srcText":"import { nope } from \"@bsc/algorithms/nope\";\nexport function BadCard(){ return nope(); }" }),
        ];
        let fs = analyze(&comps);
        let flagged: Vec<_> = fs.iter().filter(|f| f.category == "unresolvable-import").collect();
        assert_eq!(flagged.len(), 1, "only the missing library ref is flagged: {fs:?}");
        assert_eq!(flagged[0].node_names, ["BadCard"]);
        assert!(flagged[0].why.contains("@bsc/algorithms/nope"), "names the unresolvable library ref");
        assert!(flagged[0].why.contains("no matching node in the library"));
        assert!(!flagged[0].why.contains("import-map"), "a library miss isn't reported as a bare import-map miss");
    }

    #[test]
    fn the_embedded_algorithms_seed_carries_the_ts_fibonacci() {
        // The resolvable-class check reads the SAME algorithms.json the frontend + `bsc graph` embed. If the
        // include path or the seed drifts, the set empties and the flagship @bsc/algorithms/fibonacci would
        // be falsely flagged — guard that the seed still carries it.
        assert!(algo_library_names().contains("fibonacci"), "the packaged seed must carry the TS fibonacci");
    }

    // ── #3117: the SOUNDS arm of the third import class — @bsc/sounds/<id> cue references ─────────────

    #[test]
    fn sound_library_names_indexes_cues_and_voices_but_not_primitives() {
        // Mirrors `soundNodeLookup`: a cue (the playable product) + a voice (a playable patch) are importable
        // by id; a primitive is a raw descriptor with no player → excluded.
        let json = r#"{"id":"signal",
            "primitives":[{"id":"sine","name":"Sine","kind":"osc","waveform":"sine"}],
            "voices":[{"id":"blip","name":"Blip","primitive":"sine","freq":880,"gain":0.3,
                "env":{"attack":0.001,"decay":0.04,"sustain":0,"release":0.03}}],
            "cues":[{"id":"click","name":"Click","category":"ui","layers":[{"voice":"blip","at":0}]}]}"#;
        let names = sound_library_names_from(json);
        assert!(names.contains("click"), "a cue is resolvable by id");
        assert!(names.contains("blip"), "a voice is resolvable by id");
        assert!(!names.contains("sine"), "a primitive (no player) is not importable → excluded");
        assert!(sound_library_names_from("not json").is_empty(), "malformed seed → empty (fail safe)");
    }

    #[test]
    fn resolves_library_recognizes_a_real_sound_cue_but_not_a_missing_one() {
        // An UNPINNED project resolves `@bsc/sounds/<id>` against the packaged default kit (a cue or voice
        // id); a missing name and an empty name never resolve.
        let sounds = sound_library_names();
        assert!(resolves_library("@bsc/sounds/click", sounds), "the seeded default-kit `click` cue resolves by id");
        assert!(resolves_library("@bsc/sounds/blip", sounds), "a voice resolves too (a playable patch)");
        assert!(!resolves_library("@bsc/sounds/nope", sounds), "a missing cue does not resolve");
        assert!(!resolves_library("@bsc/sounds/", sounds), "an empty name does not resolve");
    }

    #[test]
    fn the_embedded_sound_seed_is_the_packaged_default_kit() {
        // LOCKSTEP guard (#3412): the DEFAULT arm embeds the SAME packaged kit the frontend's
        // `SoundKitSelection` default arm uses (`STARTER_KIT`, the first packaged built-in). Deliberately
        // NOT pinned to the literal `signal` any more — which kit resolves is now DATA on both sides (a pin
        // can name any kit), so what must hold in lockstep is that the embed IS the packaged seed and is
        // usable: a well-formed kit whose cues are importable. Changing which kit ships means changing the
        // include path here and `STARTER_KIT` there — that pairing is what this guards.
        let v: Value = serde_json::from_str(SOUND_KIT_JSON).expect("the embedded sound seed parses");
        assert!(
            v.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty()),
            "the embedded default kit names itself",
        );
        assert!(!sound_library_names().is_empty(), "the packaged default kit must expose importable cues");
        assert!(
            v.get("cues").and_then(Value::as_array).is_some_and(|c| !c.is_empty()),
            "a kit with no cues maps to no UI sound",
        );
    }

    /// A minimal kit artifact carrying exactly one cue — the shape a pinned release artifact has.
    fn kit_with_cue(id: &str, cue: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"{id}","primitives":[],"voices":[],
               "cues":[{{"id":"{cue}","name":"{cue}","category":"ui","layers":[]}}]}}"#
        )
    }

    #[test]
    fn a_pinned_kit_replaces_the_default_one_for_resolution() {
        // #3412 core: the PINNED kit — not the packaged default — is the resolution target. A cue only the
        // pin carries resolves; a cue only the DEFAULT carries does not (no cross-kit bleed and no silent
        // per-cue fallback: a kit is adopted wholesale, epic #3071).
        let sounds = sound_library_names_from(&kit_with_cue("acme/neon", "zap"));
        assert!(resolves_library("@bsc/sounds/zap", &sounds), "the PINNED kit's cue resolves");
        assert!(
            !resolves_library("@bsc/sounds/click", &sounds),
            "a cue only the packaged DEFAULT carries must NOT resolve under a pin — no starter bleed",
        );
        // …and the default arm is untouched for an unpinned project (the documented default).
        assert!(resolves_library("@bsc/sounds/click", sound_library_names()), "unpinned still resolves `click`");
    }

    #[test]
    fn analyze_with_flags_a_cue_the_pinned_kit_lacks() {
        // #3412 end-to-end (Rust twin): the SAME component is clean under a kit carrying `zap` and flagged
        // `unresolvable-import` under one that lacks it — proving the pin reaches the ANALYZER, not just
        // `resolves_library`.
        let comps = vec![serde_json::json!({
            "id": "c1", "kitId": "k", "name": "ZapBtn", "role": "primitive", "used": 1,
            "srcText": "import { play } from \"@bsc/sounds/zap\";\nexport function ZapBtn(){ return play(); }"
        })];
        let carries = kit_with_cue("acme/neon", "zap");
        let lacks = kit_with_cue("acme/mute", "other");

        let clean = analyze_with(&comps, &HealthOptions { sound_kit_json: Some(&carries) });
        assert!(
            !clean.iter().any(|f| f.category == "unresolvable-import"),
            "a cue the PINNED kit carries is never flagged: {clean:?}",
        );

        let flagged = analyze_with(&comps, &HealthOptions { sound_kit_json: Some(&lacks) });
        let hit: Vec<_> = flagged.iter().filter(|f| f.category == "unresolvable-import").collect();
        assert_eq!(hit.len(), 1, "a cue the pinned kit LACKS is flagged: {flagged:?}");
        assert!(hit[0].why.contains("@bsc/sounds/zap"), "names the unresolvable ref: {:?}", hit[0].why);
    }

    #[test]
    fn analyze_is_analyze_with_no_pin() {
        // The "no pin → unchanged" acceptance criterion: the legacy entry point and an explicitly-empty
        // options run must agree exactly, so an unpinned project's report is byte-identical to pre-#3412.
        let comps = vec![serde_json::json!({
            "id": "c1", "kitId": "k", "name": "Btn", "role": "primitive", "used": 1,
            "srcText": "import { play } from \"@bsc/sounds/click\";\nexport function Btn(){ return play(); }"
        })];
        assert_eq!(
            analyze(&comps).iter().map(Finding::to_value).collect::<Vec<_>>(),
            analyze_with(&comps, &HealthOptions::default()).iter().map(Finding::to_value).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn does_not_flag_a_resolvable_sound_import_but_flags_a_missing_one() {
        // #3117 acceptance (Rust twin): a component importing @bsc/sounds/click is CLEAN; one importing
        // @bsc/sounds/nope is flagged unresolvable-import with the LIBRARY reason, never a bare import-map
        // miss. Both carry a real module srcText so no-implementation stays out of it.
        let comps = [
            json!({ "id":"play", "name":"PlayBtn", "kitId":"react-ui", "role":"composite", "used":2, "composes":[],
                    "srcText":"import { play } from \"@bsc/sounds/click\";\nexport function PlayBtn(){ return play(); }" }),
            json!({ "id":"bad", "name":"BadBtn", "kitId":"react-ui", "role":"composite", "used":2, "composes":[],
                    "srcText":"import { play } from \"@bsc/sounds/nope\";\nexport function BadBtn(){ return play(); }" }),
        ];
        let fs = analyze(&comps);
        let flagged: Vec<_> = fs.iter().filter(|f| f.category == "unresolvable-import").collect();
        assert_eq!(flagged.len(), 1, "only the missing sound ref is flagged: {fs:?}");
        assert_eq!(flagged[0].node_names, ["BadBtn"]);
        assert!(flagged[0].why.contains("@bsc/sounds/nope"), "names the unresolvable sound ref");
        assert!(flagged[0].why.contains("no matching node in the library"));
        assert!(!flagged[0].why.contains("import-map"), "a library miss isn't reported as a bare import-map miss");
    }

    // ── #3118: the reimplementation guardrail — "compose, don't recreate" ────────────────────────────

    #[test]
    fn is_js_identifier_accepts_identifiers_and_rejects_ids_and_hyphens() {
        assert!(is_js_identifier("fibonacci") && is_js_identifier("click") && is_js_identifier("_x") && is_js_identifier("$"));
        assert!(!is_js_identifier("fibonacci.ts"), "an extension-bearing algo id is not a declarable symbol");
        assert!(!is_js_identifier("bell-lo"), "a hyphenated cue id is not a declarable symbol");
        assert!(!is_js_identifier("") && !is_js_identifier("2fast"));
    }

    #[test]
    fn reimpl_targets_are_algorithms_only_by_bare_name() {
        // ALGORITHMS-ONLY (#3118): the candidate set is the TS algorithm names (by bare name, NOT the `.ts`
        // id), filtered to identifiers. Sounds are DELIBERATELY excluded — a cue id like `click` collides
        // with common handler names (the `@bsc/sounds/…` import path, #3117, is untouched).
        let t = reimpl_targets();
        assert!(t.iter().any(|(n, seg)| n == "fibonacci" && *seg == "algorithms"), "the TS fibonacci is a candidate: {t:?}");
        assert!(!t.iter().any(|(n, _)| n == "fibonacci.ts"), "the extension-bearing id is not a candidate");
        assert!(t.iter().all(|(_, seg)| *seg == "algorithms"), "every candidate is an algorithm — sounds excluded: {t:?}");
        assert!(!t.iter().any(|(n, _)| n == "click"), "a sound cue id is not a reimplementation candidate");
    }

    #[test]
    fn flags_a_node_that_re_declares_a_component_that_already_exists_and_clears_on_an_import() {
        // The harvested-kit failure (#3892): a record carries `function Box` while a `Box` node sits in the
        // same graph, so the preview renders the STUB and the node looks correct while composing nothing
        // real. `used` > 0 on both so neither is a dead-root orphan.
        let comps = [
            json!({ "id":"box", "name":"Box", "kitId":"react-ui", "role":"primitive", "used":9,
                    "srcText":"export function Box({children}){ return <div>{children}</div>; }" }),
            json!({ "id":"agentface", "name":"AgentFace", "kitId":"react-ui", "role":"composite", "used":2,
                    "composes":["Box"],
                    "srcText":"function Box({children}){ return <div>{children}</div>; }
export function AgentFace(){ return <Box>hi</Box>; }" }),
        ];
        let fs = analyze(&comps);
        let f = fs.iter().find(|f| f.category == "reimplemented-component").expect("flagged: {fs:?}");
        assert_eq!(f.severity, 3);
        assert_eq!(f.node_names, ["AgentFace"]);
        assert!(f.why.contains("`Box`"), "names the re-declared component");
        assert!(f.suggested_action.contains("register it as a platform module"), "points at the real fix");
        // The node that legitimately OWNS the name is never flagged for declaring itself.
        assert!(!fs.iter().any(|f| f.category == "reimplemented-component" && f.node_names == ["Box"]));

        // …and IMPORTING it instead clears the finding — the whole point of the guardrail.
        let fixed = [
            comps[0].clone(),
            json!({ "id":"agentface", "name":"AgentFace", "kitId":"react-ui", "role":"composite", "used":2,
                    "composes":["Box"],
                    "srcText":"import { Box } from \"@/shared/ui/layout/Box\";
export function AgentFace(){ return <Box>hi</Box>; }" }),
        ];
        assert!(
            !analyze(&fixed).iter().any(|f| f.category == "reimplemented-component"),
            "importing the real component clears it"
        );
    }

    #[test]
    fn does_not_flag_a_sibling_extracted_from_the_same_module() {
        // #3895: `AgentFace` and `TeamsCanvas` are both lifted from TeamsCanvas.tsx, so that module's
        // closure legitimately CONTAINS both declarations. Flagging it would demand importing the file
        // from itself. Same `src` => not a re-declaration.
        let comps = [
            json!({ "id":"agentface", "name":"AgentFace", "kitId":"harvested", "role":"primitive", "used":3,
                    "src":"src/features/teams/TeamsCanvas.tsx",
                    "srcText":"export function AgentFace(){ return <i/>; }" }),
            json!({ "id":"teamscanvas", "name":"TeamsCanvas", "kitId":"harvested", "role":"composite", "used":2,
                    "src":"src/features/teams/TeamsCanvas.tsx",
                    "srcText":"function AgentFace(){ return <i/>; }
export function TeamsCanvas(){ return <AgentFace/>; }" }),
        ];
        assert!(
            !analyze(&comps).iter().any(|f| f.category == "reimplemented-component"),
            "a same-file extraction is not a stub"
        );
    }

    #[test]
    fn an_ellipsis_in_jsx_text_is_prose_not_an_elision_marker() {
        // #3897: JSX text is not quoted, so the string-skip misses it. ProjectsPage was condemned as
        // "a sketch, not compilable code" over `>Loading projects…</Text>` while the app mounted it.
        assert!(!has_code_elision("export function X(){ return <p>Loading projects…</p>; }"));
        assert!(!has_code_elision("export const s = <b>syncing…</b>;"));
        // …and a REAL marker in code position is still caught.
        assert!(has_code_elision("export function X(){
  …
}"));
        assert!(has_code_elision("const cfg = { … };"));
    }

    #[test]
    fn a_no_implementation_finding_names_why_it_is_unbuildable() {
        // `bsc request` #4: the finding used to say only THAT a component was unbuildable, so the reader
        // had to re-derive the cause. Each distinct defect must be NAMED in the `why`.
        let missing_export = [json!({
            "id":"a", "name":"A", "kitId":"react-ui", "role":"composite", "used":2,
            "src":"src/features/a/A.tsx", "srcText":"function A(){ return <i/>; }"
        })];
        let why = |c: &[serde_json::Value]| {
            analyze(c).into_iter().find(|f| f.category == "no-implementation").expect("flagged").why
        };
        assert!(why(&missing_export).contains("declares no `export`"), "{}", why(&missing_export));

        let elided = [json!({
            "id":"b", "name":"B", "kitId":"react-ui", "role":"composite", "used":2,
            "src":"src/features/b/B.tsx", "srcText":"export function B(){ … }"
        })];
        assert!(why(&elided).contains("code-elision marker"), "{}", why(&elided));

        let unresolved = [json!({
            "id":"c", "name":"C", "kitId":"react-ui", "role":"composite", "used":2,
            "src":"src/features/c/C.tsx",
            "srcText":"import { z } from \"@/features/c/lib/nope\";
export function C(){ return <i>{z}</i>; }"
        })];
        assert!(why(&unresolved).contains("`@/features/c/lib/nope`"), "{}", why(&unresolved));

        // A record with NO source of its own states that, rather than reporting an empty reason list.
        let sourceless = [json!({
            "id":"d", "name":"D", "kitId":"react-ui", "role":"composite", "used":2,
            "src":"src/features/d/D.tsx", "srcText":""
        })];
        assert!(why(&sourceless).contains("no module source of its own"), "{}", why(&sourceless));
    }

    #[test]
    fn a_registered_platform_module_import_is_buildable_not_no_implementation() {
        // #3897: `@/features/security/lib/badgeTone` is a REGISTERED platform module — resolved at runtime
        // by the feature's graphPlatform, and neither an artifact path nor a sibling `src`. Before the
        // manifest, a record honestly importing one read as `no-implementation` while the app mounted it.
        let comps = [json!({
            "id":"profiles", "name":"ProfilesTab", "kitId":"react-ui", "role":"composite", "used":2,
            "src":"src/features/security/ProfilesTab.tsx",
            "srcText":"import { badgeTone } from \"@/features/security/lib/badgeTone\";
export function ProfilesTab(){ return <i>{badgeTone(1)}</i>; }"
        })];
        let fs = analyze(&comps);
        assert!(!fs.iter().any(|f| f.category == "no-implementation"), "buildable: {fs:?}");
        assert!(!fs.iter().any(|f| f.category == "unresolvable-import"), "resolvable: {fs:?}");
    }

    #[test]
    fn an_unregistered_internal_import_is_still_unresolvable() {
        // The other half: the manifest must not make every `@/…` pass.
        let comps = [json!({
            "id":"x", "name":"X", "kitId":"react-ui", "role":"composite", "used":2,
            "src":"src/features/x/X.tsx",
            "srcText":"import { nope } from \"@/features/x/lib/doesNotExist\";
export function X(){ return <i>{nope}</i>; }"
        })];
        let cats: Vec<&str> = analyze(&comps).iter().map(|f| f.category).collect();
        assert!(
            cats.contains(&"unresolvable-import") || cats.contains(&"no-implementation"),
            "an unregistered internal import is still caught: {cats:?}"
        );
    }

    #[test]
    fn flags_an_inline_reimplementation_of_a_library_algorithm() {
        // An own-source component that DECLARES `fibonacci` (no `@bsc/algorithms/fibonacci` import) re-codes
        // the library algorithm — the compose-don't-recreate guardrail. used>0 so it isn't a dead-root
        // orphan; it renders no JSX so it isn't a self-reference — the ONLY finding is reimplementation.
        let comps = [json!({
            "id":"fib", "name":"FibWidget", "kitId":"react-ui", "role":"composite", "used":2, "composes":[],
            "srcText":"export function fibonacci(n){ return n < 2 ? n : fibonacci(n-1) + fibonacci(n-2); }"
        })];
        let fs = analyze(&comps);
        assert_eq!(cats(&fs), ["reimplementation"], "the inline algorithm is flagged, nothing else: {fs:?}");
        let f = &fs[0];
        assert_eq!(f.severity, 3);
        assert_eq!(f.node_names, ["FibWidget"]);
        assert!(f.why.contains("fibonacci"), "names the re-coded symbol");
        assert!(f.why.contains("@bsc/algorithms/fibonacci"), "names the library import to compose instead");
        assert!(f.suggested_action.contains("@bsc/algorithms/fibonacci"));
    }

    #[test]
    fn does_not_flag_a_component_that_imports_the_library_algorithm() {
        // Imports + uses @bsc/algorithms/fibonacci (declares no local `fibonacci`) — it's already composing,
        // not recreating. Clean overall (the library ref resolves, so no unresolvable-import either).
        let comps = [json!({
            "id":"fib", "name":"FibCard", "kitId":"react-ui", "role":"composite", "used":2, "composes":[],
            "srcText":"import { fibonacci } from \"@bsc/algorithms/fibonacci\";\nexport function FibCard(){ return fibonacci(10); }"
        })];
        assert!(analyze(&comps).is_empty(), "an importer of the library node is not flagged: {:?}", analyze(&comps));
    }

    #[test]
    fn does_not_flag_a_declaration_matching_no_library_node() {
        // Declares `Sparkline` — no such library node → never a reimplementation.
        let comps = [json!({
            "id":"sp", "name":"Sparkline", "kitId":"react-ui", "role":"composite", "used":2, "composes":[],
            "srcText":"export function Sparkline(){ return null; }"
        })];
        assert!(!cats(&analyze(&comps)).contains(&"reimplementation"), "a non-library symbol is not flagged");
    }

    #[test]
    fn does_not_flag_a_reimplementation_when_the_component_also_imports_the_node() {
        // Degenerate belt-and-suspenders: a component that both imports @bsc/algorithms/fibonacci AND
        // declares a local `fibonacci` is treated as composing (the import is present) → skipped.
        let comps = [json!({
            "id":"fib", "name":"FibShadow", "kitId":"react-ui", "role":"composite", "used":2, "composes":[],
            "srcText":"import { fibonacci } from \"@bsc/algorithms/fibonacci\";\nexport function fibonacci(n){ return n; }"
        })];
        assert!(!cats(&analyze(&comps)).contains(&"reimplementation"), "the import suppresses the reimplementation flag");
    }

    #[test]
    fn does_not_flag_a_symbol_matching_a_sound_cue_id() {
        // ALGORITHMS-ONLY (#3118): a component declaring `click` (a default-kit sound cue id) is NOT a
        // reimplementation — sound ids collide with common handler names, and you don't re-code a cue as a
        // function. The `@bsc/sounds/…` import resolution + vendoring (#3117) is untouched by this narrowing.
        let comps = [json!({
            "id":"c", "name":"ClickFx", "kitId":"react-ui", "role":"composite", "used":2, "composes":[],
            "srcText":"export function click(){ /* a click handler */ return null; }"
        })];
        assert!(!cats(&analyze(&comps)).contains(&"reimplementation"), "a sound-id-named symbol is not flagged");
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
                // `Row` (a record, not an array) so this stays a pure unwired-prop case — an ARRAY prop
                // would also (correctly) trigger the #3135 no-empty-state/no-loading-state checks.
                { "name": "data", "type": "Row" },
                { "name": "onRefresh", "type": "() => void" }
            ],
            // Declares its event so the #3810 no-analytics check is satisfied — keeps this a PURE
            // unwired-prop case (the `onRefresh` prop is still unused by the source). Same for #3878's
            // no-tests: `onRefresh` makes the node interactive, so an untested fixture would earn a second
            // (legitimate) finding and stop this exact-list assertion from being about unwired-prop.
            "analytics": [{ "event": "refresh" }],
            "tests": [{ "name": "renders the title", "src": "it('renders', () => {})" }]
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

    // ── merge_plan (#3089) — the safe, mechanical byte-identical dedup the optimize command applies ──
    const DUP_SRC: &str = "export function Button(){ return <button/>; }";

    #[test]
    fn merge_plan_folds_byte_identical_dups_into_the_most_used_canonical() {
        let comps = [
            json!({ "id": "btn", "name": "Button", "kitId": "k", "role": "primitive", "used": 9, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
            json!({ "id": "btn2", "name": "Btn2", "kitId": "k", "role": "primitive", "used": 1, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
        ];
        let plan = merge_plan(&comps);
        assert_eq!(plan.groups.len(), 1);
        let g = &plan.groups[0];
        assert_eq!(g.canonical_id, "btn"); // the most-used survives
        assert_eq!(g.canonical_name, "Button");
        assert_eq!(g.removed, vec![("btn2".to_string(), "Btn2".to_string())]);
    }

    #[test]
    fn merge_plan_repoints_composers_from_the_removed_dup_to_the_canonical() {
        let comps = [
            json!({ "id": "btn", "name": "Button", "kitId": "k", "role": "primitive", "used": 9, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
            json!({ "id": "btn2", "name": "Btn2", "kitId": "k", "role": "primitive", "used": 1, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
            json!({ "id": "page", "name": "Page", "kitId": "k", "role": "page", "used": 0, "composes": ["Btn2", "Other"], "srcText": "p", "source": "export const C=()=>null;" }),
        ];
        let plan = merge_plan(&comps);
        assert_eq!(plan.repoints.len(), 1);
        let (id, rec) = &plan.repoints[0];
        assert_eq!(id, "page");
        assert_eq!(rec["composes"], json!(["Button", "Other"])); // Btn2 → Button
    }

    #[test]
    fn merge_plan_dedups_the_edge_when_a_composer_uses_both_canonical_and_dup() {
        let comps = [
            json!({ "id": "btn", "name": "Button", "kitId": "k", "role": "primitive", "used": 9, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
            json!({ "id": "btn2", "name": "Btn2", "kitId": "k", "role": "primitive", "used": 1, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
            json!({ "id": "page", "name": "Page", "kitId": "k", "role": "page", "used": 0, "composes": ["Button", "Btn2"], "srcText": "p", "source": "export const C=()=>null;" }),
        ];
        let (_, rec) = merge_plan(&comps).repoints.into_iter().find(|(id, _)| id == "page").unwrap();
        assert_eq!(rec["composes"], json!(["Button"])); // the Btn2→Button remap collapses onto the existing edge
    }

    #[test]
    fn merge_plan_leaves_same_wraps_but_different_source_alone() {
        // Same intrinsic, DIFFERENT source → a weaker duplicate signal, NOT auto-merged (curator's call).
        let comps = [
            json!({ "id": "btn", "name": "Button", "kitId": "k", "role": "primitive", "used": 9, "composes": [], "wraps": "button", "srcText": "a", "source": "a" }),
            json!({ "id": "btn2", "name": "Btn2", "kitId": "k", "role": "primitive", "used": 1, "composes": [], "wraps": "button", "srcText": "b", "source": "b" }),
        ];
        let plan = merge_plan(&comps);
        assert!(plan.groups.is_empty());
        assert!(plan.repoints.is_empty());
    }

    #[test]
    fn merge_plan_scopes_to_a_kit_and_ties_break_to_the_smallest_id() {
        let comps = [
            json!({ "id": "a2", "name": "A2", "kitId": "k1", "role": "primitive", "used": 5, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
            json!({ "id": "a1", "name": "A1", "kitId": "k1", "role": "primitive", "used": 5, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
            json!({ "id": "b1", "name": "B1", "kitId": "k2", "role": "primitive", "used": 0, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
            json!({ "id": "b2", "name": "B2", "kitId": "k2", "role": "primitive", "used": 3, "composes": [], "srcText": DUP_SRC, "source": DUP_SRC }),
        ];
        let plan = merge_plan(&comps);
        assert_eq!(plan.groups.len(), 2); // one per kit — edges never cross kits
        assert_eq!(plan.groups.iter().find(|g| g.kit == "k1").unwrap().canonical_id, "a1"); // used tie → smallest id
        assert_eq!(plan.groups.iter().find(|g| g.kit == "k2").unwrap().canonical_name, "B2"); // most-used
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

    // ── prune guards (#3087) ─────────────────────────────────────────────────────────────────────

    /// A live-store `page`: a root by definition (nothing composes it) that pulls in its section
    /// components. Before the guard it landed in the prune plan as a "dangling-branch", so `--fix`
    /// proposed deleting the ENTIRE pages tier (#2505) — the regression this test pins.
    #[test]
    fn a_page_is_reported_as_a_dead_root_but_is_never_pruned() {
        let comps = [
            // The usage index IS populated here, so guard 3 can't be what saves the page.
            comp("Button", "primitive", 9, &[]),
            json!({ "id": "invoicespage", "name": "InvoicesPage", "kitId": "k", "role": "page", "used": 0,
                    "composes": ["DataTable"], "srcText": "p", "source": "export const C = () => null;" }),
            json!({ "id": "table", "name": "DataTable", "kitId": "k", "role": "composite", "used": 0,
                    "composes": [], "srcText": "t", "source": "export const C = () => null;" }),
        ];
        // The FINDING survives — the read-only diagnosis is still complete.
        let reported: Vec<String> = analyze(&comps)
            .into_iter()
            .filter(|f| f.category == "dangling-branch")
            .map(|f| f.node_names[0].clone())
            .collect();
        assert_eq!(reported, ["InvoicesPage"], "the dead-root finding is still REPORTED");

        let plan = prune_plan(&comps);
        assert!(
            !plan.prune.iter().any(|p| p.id == "invoicespage"),
            "a page is a root BY DEFINITION — never auto-pruned: {:?}",
            plan.prune,
        );
        let skip = plan.skipped.iter().find(|s| s.id == "invoicespage").expect("held back, not dropped");
        assert!(skip.guard.contains("page"), "the guard names itself: {}", skip.guard);
    }

    /// A packaged built-in seed (the viz kits' demo components, #3194/#3242) is isolated ON PURPOSE.
    /// Pruning one is data loss that the seed reconcile immediately undoes.
    #[test]
    fn a_packaged_builtin_seed_is_reported_but_never_pruned() {
        let comps = [
            comp("Button", "primitive", 9, &[]), // populates the usage index
            json!({ "id": "algocells", "name": "AlgoCells", "kitId": "k", "role": "primitive", "used": 0,
                    "builtin": true, "composes": [], "srcText": "a", "source": "export const C = () => null;" }),
            json!({ "id": "ghost", "name": "Ghost", "kitId": "k", "role": "primitive", "used": 0,
                    "composes": [], "srcText": "g", "source": "export const C = () => null;" }),
        ];
        assert!(
            analyze(&comps).iter().any(|f| f.category == "orphan" && f.node_names[0] == "AlgoCells"),
            "the orphan finding is still REPORTED",
        );

        let plan = prune_plan(&comps);
        let prune_ids: Vec<&str> = plan.prune.iter().map(|p| p.id.as_str()).collect();
        assert!(!prune_ids.contains(&"algocells"), "a builtin seed is never auto-pruned: {prune_ids:?}");
        assert!(prune_ids.contains(&"ghost"), "a plain user orphan still prunes: {prune_ids:?}");
        assert!(plan.skipped.iter().any(|s| s.id == "algocells" && s.guard.contains("built-in")));
    }

    #[test]
    fn a_suppression_tombstone_is_skipped_by_every_doctor_check() {
        // #3725: a `{ id, suppressed: true }` tombstone is not a component — `parse_node` drops it, so it
        // produces NO finding (a source-less record would otherwise be flagged `no-implementation`) and
        // never appears in the prune plan.
        let comps = [comp("Button", "primitive", 5, &[]), json!({ "id": "cost", "suppressed": true })];
        let findings = analyze(&comps);
        assert!(
            !findings.iter().any(|f| f.node_ids.contains(&"cost".to_string())),
            "the tombstone produces no finding: {findings:?}",
        );
        assert!(!prune_plan(&comps).prune.iter().any(|p| p.id == "cost"), "the tombstone is not prunable");
    }

    /// `used` is a reuse count nothing currently increments — the packaged kit ships every component at
    /// `used: 0`. So a store where NOTHING is used has no usage SIGNAL, and `used == 0` there means
    /// UNKNOWN. Half the heuristic being blank must not condemn a node on in-degree alone.
    #[test]
    fn an_unpopulated_usage_index_is_unknown_not_unused() {
        let comps = [
            comp("Ghost", "primitive", 0, &[]),
            json!({ "id": "shell", "name": "DeadShell", "kitId": "k", "role": "layout", "used": 0,
                    "composes": ["Widget"], "srcText": "a" }),
            json!({ "id": "widget", "name": "Widget", "kitId": "k", "role": "composite", "used": 0,
                    "composes": [], "srcText": "b" }),
        ];
        assert!(!usage_index_populated(&comps), "nothing carries used > 0");
        // Both dead roots are still REPORTED …
        assert_eq!(
            analyze(&comps).iter().filter(|f| matches!(f.category, "orphan" | "dangling-branch")).count(),
            2,
        );
        // … and NOTHING is proposed for removal.
        let plan = prune_plan(&comps);
        assert!(plan.prune.is_empty(), "no usage signal ⇒ nothing auto-pruned: {:?}", plan.prune);
        assert_eq!(plan.skipped.len(), 2, "both are held back, each with its guard");
        assert!(plan.skipped.iter().all(|s| s.guard.contains("usage index")));

        // One real usage count anywhere restores the signal — and the same nodes prune again.
        let mut with_signal = comps.to_vec();
        with_signal.push(comp("Button", "primitive", 4, &[]));
        assert!(usage_index_populated(&with_signal));
        let ids: Vec<String> = prunable(&with_signal).into_iter().map(|p| p.id).collect();
        assert!(ids.contains(&"Ghost".to_string()) && ids.contains(&"shell".to_string()), "{ids:?}");
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
    fn a_user_component_that_composes_a_sibling_is_buildable() {
        // #3112: a user-kit component whose `srcText` imports a SIBLING (by its `src` path) is a real,
        // buildable module — the preview vendors the sibling — so it is NOT flagged no-implementation, and
        // its `@/` import resolves to the kit sibling (not unresolvable-import).
        let frame = json!({ "id": "cf", "name": "ChartFrame", "kitId": "d3", "role": "layout", "used": 1,
            "composes": [], "src": "d3/ChartFrame.tsx", "source": "",
            "srcText": "export function ChartFrame() { return null; }" });
        let bar = json!({ "id": "bar", "name": "BarChart", "kitId": "d3", "role": "composite", "used": 1,
            "composes": ["ChartFrame"], "src": "d3/BarChart.tsx", "source": "",
            "srcText": "import { ChartFrame } from \"@/d3/ChartFrame\";\nexport function BarChart() { return <ChartFrame/>; }" });
        let fs = analyze(&[frame, bar]);
        assert!(fs.is_empty(), "a composing sibling-importer + its sibling are both clean: {fs:?}");
    }

    #[test]
    fn a_user_component_importing_a_missing_sibling_is_not_buildable() {
        // #3112: an internal import that resolves to NO sibling → not a buildable module → the honest
        // no-implementation (mirrors `componentPreviewFiles` → null / `isPreviewBuildable` false).
        let bar = json!({ "id": "bar", "name": "BarChart", "kitId": "d3", "role": "composite", "used": 1,
            "composes": [], "src": "d3/BarChart.tsx", "source": "",
            "srcText": "import { Nope } from \"@/d3/Nope\";\nexport function BarChart() { return null; }" });
        let fs = analyze(&[bar]);
        assert!(
            fs.iter().any(|f| f.category == "no-implementation"),
            "an import resolving to no sibling is not buildable: {fs:?}"
        );
    }

    #[test]
    fn a_graph_source_primitive_importing_artifact_and_provides_siblings_is_buildable() {
        // #43/#3660: a `provides` component (a shared/ui primitive migrated into the graph, #3604) whose
        // srcText imports an artifact RUNTIME util (`@/shared/ui/layout/space`) AND a SIBLING it provides
        // (`@/shared/ui/feedback/Skeleton`) is a real, buildable module — resolved via the artifact + the
        // graph's `provides`, exactly as the runtime loader does — so it is NOT falsely flagged
        // no-implementation. Before #43 the buildability check saw neither and reported it "a spec, not code".
        let box_c = json!({ "id":"box", "name":"Box", "kitId":"base-studio-code", "role":"primitive",
            "used":2, "composes":[], "src":"src/shared/ui/layout/Box.tsx", "source":"",
            "provides":"@/shared/ui/layout/Box",
            "srcText":"import { space } from \"@/shared/ui/layout/space\";\nimport { Skeleton } from \"@/shared/ui/feedback/Skeleton\";\nexport function Box(){ return space || Skeleton ? null : null; }" });
        let skeleton = json!({ "id":"skeleton", "name":"Skeleton", "kitId":"base-studio-code", "role":"primitive",
            "used":2, "composes":[], "src":"src/shared/ui/feedback/Skeleton.tsx", "source":"",
            "provides":"@/shared/ui/feedback/Skeleton",
            "srcText":"export function Skeleton(){ return null; }" });
        let fs = analyze(&[box_c, skeleton]);
        assert!(!fs.iter().any(|f| f.category == "no-implementation"),
            "a graph-source primitive importing an artifact util + a provides-sibling is buildable: {fs:?}");
        assert!(!fs.iter().any(|f| f.category == "unresolvable-import"),
            "its @/ imports resolve (artifact + provides), not unresolvable: {fs:?}");
    }

    #[test]
    fn jsx_text_escape_leaks_flags_code_position_escapes_not_string_ones() {
        // #3709: the exact designer bug. NOTE: every `\\u…` below is the literal 6-char escape TEXT
        // `\u…` in the source string — NOT a real glyph — since that text between JSX tags is the leak.
        // A `·` / `↻` typed between JSX tags (code position) is a leak.
        let leaked = "export function FleetPage(){ return (<span>{count} workers \\u00b7 {count} running \\u21bb</span>); }";
        let got = jsx_text_escape_leaks(leaked);
        assert_eq!(got, vec!["\\u00b7".to_string(), "\\u21bb".to_string()], "both JSX-text escapes: {got:?}");

        // Correct forms — the same escape inside a JS string / template / comment, or a real glyph — clean.
        assert!(jsx_text_escape_leaks("const dot = \"\\u00b7\";").is_empty(), "escape in a string literal");
        assert!(jsx_text_escape_leaks("return (<span>{\"\\u00b7\"}</span>);").is_empty(), "escape in a JSX string expr");
        assert!(jsx_text_escape_leaks("// separator \\u00b7 between counts").is_empty(), "escape in a line comment");
        assert!(jsx_text_escape_leaks("const t = `a \\u00b7 b`;").is_empty(), "escape in a template literal");
        assert!(jsx_text_escape_leaks("return (<span>{count} · {count}</span>);").is_empty(), "a real UTF-8 glyph is fine");

        // Both other escape shapes are caught in code position.
        assert_eq!(jsx_text_escape_leaks("<b>\\u{1F600}</b>"), vec!["\\u{1F600}".to_string()], "the `\\u{{…}}` form");
        assert_eq!(jsx_text_escape_leaks("<b>\\xb7</b>"), vec!["\\xb7".to_string()], "the `\\xHH` form");
        // A bare `\u` with no hex digits is a syntax error the write gate rejects — not reported here.
        assert!(jsx_text_escape_leaks("<b>\\u</b>").is_empty(), "an incomplete escape is not flagged");
    }

    #[test]
    fn color_literals_finds_hex_and_color_functions_not_short_refs() {
        let lits = color_literals("color:#e8ecf4; background:rgba(0,0,0,.5); border:#0b0e14ff; issue #219 var(--fg)");
        assert!(lits.contains(&"#e8ecf4".to_string()), "6-digit hex");
        assert!(lits.contains(&"#0b0e14ff".to_string()), "8-digit hex");
        assert!(lits.iter().any(|c| c == "rgba"), "an rgba() function");
        assert!(!lits.iter().any(|c| c.contains("219")), "a 3-digit ref like #219 is not a color");
        assert!(uses_theme_token("x var(--fg) y") && !uses_theme_token("color:#fff"));
    }

    #[test]
    fn flags_a_component_not_wired_to_the_theme_as_hardcoded_color() {
        // #3704: a component that hardcodes colors and references NO `var(--…)` token isn't wired to the
        // theme → a severity-1 `hardcoded-color` note. One that uses a token, and a built-in, are clean.
        let unwired = json!({ "id":"card", "name":"WorkerCard", "kitId":"mobile-studio-code", "role":"composite",
            "used":2, "composes":[], "src":"WorkerCard.tsx",
            "srcText":"export function WorkerCard(){ const s={ color:\"#e8ecf4\", background:\"#161b26\", accent:\"#7aa2ff\" }; return s ? null : null; }" });
        let themed = json!({ "id":"btn", "name":"Btn", "kitId":"base-studio-code", "role":"primitive",
            "used":2, "composes":[], "src":"Btn.tsx",
            "srcText":"export function Btn(){ const s={ color:\"var(--fg)\", background:\"var(--btn-bg)\" }; return s ? null : null; }" });
        let builtin = json!({ "id":"bi", "name":"BuiltIn", "kitId":"react-ui", "role":"primitive", "used":2,
            "composes":[], "src":"BuiltIn.tsx", "builtin": true,
            "srcText":"export function BuiltIn(){ const s={ color:\"#ffffff\" }; return s ? null : null; }" });
        let fs = analyze(&[unwired, themed, builtin]);
        let hc: Vec<_> = fs.iter().filter(|f| f.category == "hardcoded-color").collect();
        assert_eq!(hc.len(), 1, "only the unwired component is flagged: {fs:?}");
        assert_eq!(hc[0].node_names, ["WorkerCard"]);
        assert_eq!(hc[0].severity, 1);
        assert!(hc[0].why.contains("#e8ecf4"), "names a sample literal: {}", hc[0].why);
        assert!(hc[0].suggested_action.contains("var(--"), "points at design tokens");
    }

    #[test]
    fn flags_a_declared_composition_the_source_never_renders_as_phantom_compose() {
        // #3111: a chart that DECLARES it composes ChartFrame/Axis but redraws them inline (renders only
        // raw SVG) — a phantom edge the graph would draw, and the false in-edge would mask orphan detection.
        let chart = json!({ "id": "bar", "name": "BarChart", "kitId": "d3", "role": "composite", "used": 2,
            "composes": ["ChartFrame", "Axis"], "src": "d3/BarChart.tsx",
            "source": "export function BarChart(){ return <svg><rect/></svg>; }" });
        let frame = json!({ "id": "cf", "name": "ChartFrame", "kitId": "d3", "role": "layout", "used": 1,
            "composes": [], "src": "d3/ChartFrame.tsx", "source": "export function ChartFrame(){ return null; }" });
        let axis = json!({ "id": "ax", "name": "Axis", "kitId": "d3", "role": "primitive", "used": 1,
            "composes": [], "src": "d3/Axis.tsx", "source": "export function Axis(){ return null; }" });
        let fs = analyze(&[chart, frame, axis]);
        let f = fs.iter().find(|f| f.category == "phantom-compose").expect("phantom-compose flagged");
        assert_eq!(f.severity, 2);
        assert_eq!(f.node_names, vec!["BarChart"]);
        assert!(f.why.contains("ChartFrame, Axis"), "names the phantom edges: {}", f.why);
    }

    #[test]
    fn does_not_flag_phantom_compose_for_a_real_render_slot_shell_stub_or_builtin() {
        let comps = [
            // renders <ChartFrame> → a real composition.
            json!({ "id": "line", "name": "LineChart", "kitId": "d3", "role": "composite", "used": 2,
                "composes": ["ChartFrame"], "src": "d3/LineChart.tsx",
                "source": "export function LineChart(){ return <ChartFrame><path/></ChartFrame>; }" }),
            // a slot-shell (composes + a ReactNode slot) — the child arrives via the slot.
            json!({ "id": "pg", "name": "AnalyticsPage", "kitId": "d3", "role": "page", "used": 2,
                "composes": ["BarChart"], "src": "d3/AnalyticsPage.tsx",
                "props": [{ "name": "range", "type": "ReactNode" }],
                "source": "export function AnalyticsPage({ range }){ return <div>{range}</div>; }" }),
            // renders NO JSX (a stub, ambiguous) → not flagged.
            json!({ "id": "stub", "name": "Stub", "kitId": "d3", "role": "composite", "used": 2,
                "composes": ["ChartFrame"], "src": "d3/Stub.tsx", "source": "export function Stub(){ return null; }" }),
            // a BUILT-IN: its store srcText is an illustrative snippet, not the real module → exempt.
            json!({ "id": "chip", "name": "Chip", "kitId": "d3", "role": "composite", "used": 5, "builtin": true,
                "composes": ["StatusDot"], "src": "d3/Chip.tsx",
                "srcText": "export function Chip({ children }){ return <span>{children}</span>; }" }),
            json!({ "id": "cf", "name": "ChartFrame", "kitId": "d3", "role": "layout", "used": 3, "composes": [],
                "src": "d3/ChartFrame.tsx", "source": "export function ChartFrame(){ return null; }" }),
            json!({ "id": "bar", "name": "BarChart", "kitId": "d3", "role": "composite", "used": 3,
                "composes": ["ChartFrame"], "src": "d3/BarChart.tsx",
                "source": "export function BarChart(){ return <ChartFrame/>; }" }),
            json!({ "id": "sd", "name": "StatusDot", "kitId": "d3", "role": "primitive", "used": 9, "composes": [],
                "src": "d3/StatusDot.tsx", "source": "export function StatusDot(){ return null; }" }),
        ];
        assert!(
            analyze(&comps).iter().all(|f| f.category != "phantom-compose"),
            "real render / slot-shell / stub / built-in are not phantom: {:?}",
            analyze(&comps)
        );
    }

    #[test]
    fn flags_a_data_component_lacking_empty_loading_or_error_state() {
        // #3135/#3555: a chart with a data array rendered raw — no EmptyState/empty-guard, no `loading`
        // prop, no `error` prop.
        let chart = json!({ "id": "bar", "name": "BarChart", "kitId": "d3", "role": "composite", "used": 2,
            "composes": [], "src": "d3/BarChart.tsx",
            "source": "export function BarChart({ data }){ return <svg>{data.map((d) => <rect key={d} />)}</svg>; }",
            "props": [{ "name": "data", "type": "Datum[]" }] });
        let fs = analyze(&[chart]);
        assert!(fs.iter().any(|f| f.category == "no-empty-state"), "flags no-empty-state: {fs:?}");
        assert!(fs.iter().any(|f| f.category == "no-loading-state"), "flags no-loading-state: {fs:?}");
        assert!(fs.iter().any(|f| f.category == "no-error-state"), "flags no-error-state: {fs:?}");
    }

    #[test]
    fn does_not_flag_data_states_when_empty_handled_and_loading_error_present_or_no_data_prop() {
        let comps = [
            // handles empty (Array.isArray) + a `loading` prop + an `error` prop → supports every state.
            json!({ "id": "good", "name": "Good", "kitId": "d3", "role": "composite", "used": 2, "composes": [],
                "src": "d3/Good.tsx",
                "source": "export function Good({ data, loading, error }){ if (error) return <span/>; if (loading) return <span/>; return <svg>{Array.isArray(data) ? data.map((d) => <rect key={d} />) : null}</svg>; }",
                "props": [{ "name": "data", "type": "Datum[]" }, { "name": "loading", "type": "boolean" }, { "name": "error", "type": "string" }] }),
            // no collection prop at all → not a data component.
            json!({ "id": "btn", "name": "Button", "kitId": "d3", "role": "primitive", "used": 5, "composes": [],
                "src": "d3/Button.tsx", "source": "export function Button({ label }){ return <button>{label}</button>; }",
                "props": [{ "name": "label", "type": "string" }] }),
        ];
        let fs = analyze(&comps);
        assert!(
            fs.iter().all(|f| f.category != "no-empty-state" && f.category != "no-loading-state" && f.category != "no-error-state"),
            "empty-handled + loading-prop + error-prop / no-data-prop are not flagged: {fs:?}"
        );
    }

    #[test]
    fn flags_an_interactive_component_without_tests_and_clears_on_a_manifest() {
        // #3878: tests as a per-node data contract, the same shape as `analytics` one field over.
        let base = |extra: serde_json::Value| {
            let mut v = json!({ "id": "pk", "name": "Picker", "kitId": "ui", "role": "composite", "used": 3,
                "composes": [], "src": "ui/Picker.tsx",
                "source": "export function Picker({ onPick }){ return <button onClick={onPick}/>; }",
                "props": [{ "name": "onPick", "type": "() => void" }] });
            if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
                for (k, val) in e { o.insert(k.clone(), val.clone()); }
            }
            v
        };
        assert!(analyze(&[base(json!({}))]).iter().any(|f| f.category == "no-tests"),
                "flags an interactive, implemented component carrying no tests");

        // Carrying tests clears it.
        let tested = base(json!({ "tests": [{ "name": "picks", "src": "it('picks', () => {})" }] }));
        assert!(analyze(&[tested]).iter().all(|f| f.category != "no-tests"), "a tests manifest clears it");

        // NOT interactive → never flagged. This is the line that keeps the check a suggestion rather than a
        // finding on every node — flagging every implemented component lit the whole graph up.
        let display = json!({ "id": "txt", "name": "Label", "kitId": "ui", "role": "primitive", "used": 5, "composes": [],
            "src": "ui/Label.tsx", "source": "export function Label({ text }){ return <span>{text}</span>; }",
            "props": [{ "name": "text", "type": "string" }] });
        assert!(analyze(&[display]).iter().all(|f| f.category != "no-tests"), "a display-only component is not flagged");

        // A SPEC-ONLY node is skipped — it already earns `no-implementation`; one cause must not raise two.
        let spec = json!({ "id": "sk", "name": "Sketch", "kitId": "ui", "role": "composite", "used": 2,
            "composes": [], "src": "ui/Sketch.tsx", "source": "", "srcText": "",
            "props": [{ "name": "onPick", "type": "() => void" }] });
        let fs = analyze(&[spec]);
        assert!(fs.iter().all(|f| f.category != "no-tests"), "a spec-only node is not nagged for tests");
        assert!(fs.iter().any(|f| f.category == "no-implementation"), "…it earns no-implementation instead");
    }

    #[test]
    fn flags_an_interactive_component_without_analytics_and_clears_on_a_manifest() {
        // #3810: a user-authored interactive component (an `onClick` action prop) with no `analytics`.
        let bare = json!({ "id": "btn", "name": "IconButton", "kitId": "ui", "role": "primitive", "used": 3,
            "composes": [], "src": "ui/IconButton.tsx",
            "source": "export function IconButton({ onClick, label }){ return <button onClick={onClick}>{label}</button>; }",
            "props": [{ "name": "onClick", "type": "() => void" }, { "name": "label", "type": "string" }] });
        assert!(analyze(&[bare]).iter().any(|f| f.category == "no-analytics"), "flags an uninstrumented interactive component");

        // Declaring an events manifest clears it.
        let instrumented = json!({ "id": "btn", "name": "IconButton", "kitId": "ui", "role": "primitive", "used": 3,
            "composes": [], "src": "ui/IconButton.tsx",
            "source": "export function IconButton({ onClick, label }){ return <button onClick={onClick}>{label}</button>; }",
            "props": [{ "name": "onClick", "type": "() => void" }, { "name": "label", "type": "string" }],
            "analytics": [{ "event": "click", "props": [{ "name": "label", "type": "string" }] }] });
        assert!(analyze(&[instrumented]).iter().all(|f| f.category != "no-analytics"), "a declared manifest clears it");

        // A DISPLAY-only component (no action prop) is never flagged.
        let display = json!({ "id": "txt", "name": "Label", "kitId": "ui", "role": "primitive", "used": 5, "composes": [],
            "src": "ui/Label.tsx", "source": "export function Label({ text }){ return <span>{text}</span>; }",
            "props": [{ "name": "text", "type": "string" }] });
        assert!(analyze(&[display]).iter().all(|f| f.category != "no-analytics"), "a display-only component is not flagged");

        // A built-in (no own source) is skipped — packaged instrumentation is a separate concern.
        let builtin = json!({ "id": "b", "name": "Btn", "kitId": "ui", "role": "primitive", "used": 9, "composes": [],
            "src": "ui/Btn.tsx", "builtin": true, "srcText": "<button onClick={onClick}/>",
            "props": [{ "name": "onClick", "type": "() => void" }] });
        assert!(analyze(&[builtin]).iter().all(|f| f.category != "no-analytics"), "a built-in is skipped");
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
    fn module_defects_names_every_reason_and_is_the_predicates_reasons() {
        // A real module has NO defects — and the bool is exactly `defects.is_empty()`.
        let ok = "import * as d3 from \"d3\";\nexport function Foo() { return null; }";
        assert!(module_defects(ok).is_empty(), "{:?}", module_defects(ok));
        assert!(looks_buildable_module(ok));

        // #3470 row 3 — the source LEAST like a module: it keeps its `@/` imports. It must be reported
        // (and the reason must NAME the specifiers), not silently skipped.
        let spec = "import { Card } from \"@/shared/ui/data/Card\";\nimport { Row } from '@/shared/ui/layout/Row';\nexport function X() { return null; }";
        let why = module_defects(spec);
        assert_eq!(why.len(), 1, "exactly the import defect: {why:?}");
        assert!(why[0].contains("@/shared/ui/data/Card"), "names the first import: {why:?}");
        assert!(why[0].contains("@/shared/ui/layout/Row"), "names the second import: {why:?}");
        assert!(!looks_buildable_module(spec));

        // Every defect is reported, not just the first — a usage snippet trips all three at once.
        let snippet = "import { B } from \"@/x\";\n<B label={…} />";
        let why = module_defects(snippet);
        assert_eq!(why.len(), 3, "export + elision + import: {why:?}");
        assert!(why.iter().any(|r| r.contains("export")), "{why:?}");
        assert!(why.iter().any(|r| r.contains('…')), "{why:?}");
        assert!(why.iter().any(|r| r.contains("@/x")), "{why:?}");

        // A record with no source is NOT a defect — "carries no srcText" is a different, legit state
        // every caller checks first.
        assert!(module_defects("").is_empty());
        assert!(module_defects("   \n  ").is_empty());
        assert!(!looks_buildable_module("   \n  "), "…but it is still not a module");
    }

    #[test]
    fn an_ellipsis_in_copy_or_a_comment_is_not_a_code_elision() {
        // A MEASURED false positive, not a hypothetical (#3470): the plain `contains('…')` test this
        // replaced condemned 13 real components in this repo's own `src/shared/ui`, because `…` is
        // ordinary UI copy and ordinary doc-comment prose. Those are real modules and must gate as such.
        assert!(has_code_elision("export function A() { … }"), "a genuine code elision");
        assert!(!has_code_elision(r#"export const A = () => <input placeholder="Select…" />;"#), "UI copy");
        assert!(!has_code_elision("// mentions …\nexport function A() { return null; }"), "line comment");
        assert!(!has_code_elision("/* block … */\nexport function A() { return null; }"), "block comment");
        assert!(!has_code_elision("export const A = () => <b>{`tpl …`}</b>;"), "template literal");
        assert!(!has_code_elision("export const A = () => <b title='an …' />;"), "single-quoted");
        assert!(!has_code_elision("export const A = \"\\\"…\";"), "an escaped quote doesn't end the literal");
        // The scanner must RESUME scanning as code once a literal closes, or a real elision could hide
        // behind any earlier piece of copy. (Mirrors the TS case of the same name, #3486.)
        assert!(
            has_code_elision("const s = \"Select…\"; export function A() { … }"),
            "a marker after a string that contains one is still found"
        );

        // …so the predicate itself no longer mis-flags a component whose only `…` is in its copy.
        assert!(looks_buildable_module(r#"export const A = () => <input placeholder="Select…" />;"#));
        assert!(!looks_buildable_module("export function X() { return <Card>…</Card>; }"), "JSX text is code");
    }

    #[test]
    fn the_preview_predicate_uses_the_context_aware_scanner_too() {
        // #3486: `is_preview_buildable` deliberately kept the PLAIN `contains('…')` test while the TS
        // `isPreviewBuildable` still had one, so that `doctor` could never be more permissive than the
        // preview it reports on. Once the TS side ported the context-aware scanner, keeping the plain
        // test here inverted the bug: `doctor` would report a `no-implementation` finding for a
        // component the preview renders perfectly well. The two must move together, so this pins that
        // a copy-only ellipsis is preview-buildable on BOTH sides.
        let targets = BTreeSet::new();
        let copy_only = r#"export const A = () => <input placeholder="Select…" />;"#;
        assert!(
            is_preview_buildable(copy_only, "shared/ui/A.tsx", &targets),
            "an ellipsis in placeholder COPY must not read as omitted code"
        );
        assert!(
            !is_preview_buildable("export function A() { … }", "shared/ui/A.tsx", &targets),
            "a genuine code elision must still fail"
        );

        // And the consequence that motivated the issue: such a component reports NO defect, so it is
        // not surfaced as a no-implementation finding.
        assert!(module_defects(copy_only).is_empty(), "{:?}", module_defects(copy_only));
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

    // ── motion checks (#3163) — the Rust twin of `analyzeMotion` (graphHealth.ts) ────────────────────

    fn motion_cats(fs: &[Finding]) -> Vec<&str> {
        fs.iter().map(|f| f.category).collect()
    }

    #[test]
    fn motion_helpers_mirror_the_ts_twin() {
        assert_eq!(selector_classes(".bar .cell rect"), vec!["bar".to_string(), "cell".to_string()]);
        assert_eq!(selector_classes(".foo.bar"), vec!["foo".to_string(), "bar".to_string()]);
        assert!(selector_classes("rect").is_empty(), "a bare tag selector has no class hook");
        // `transform=` (attribute) is detected; a CSS `transform:` declaration is NOT.
        assert!(has_transform_attr("<g transform=\"translate(1,2)\">"));
        assert!(has_transform_attr("<g transform = \"x\">")); // optional whitespace like /transform\\s*=/
        assert!(!has_transform_attr("style={{ transform: 'rotate(1deg)' }}"));
    }

    #[test]
    fn flags_a_dead_animation_selector_hook_but_not_a_rendered_one() {
        // (a) `spin` targets `.bar`, but the source renders no such class → dead selector.
        let dead = json!({ "id": "chart", "name": "Chart", "kitId": "k",
            "source": "export function Chart(){ return <svg><rect/></svg>; }", "srcText": "",
            "animations": [{ "name": "spin", "selector": ".bar", "keyframes": { "from": { "transform": "scale(1)" } } }] });
        let fs = analyze_motion(std::slice::from_ref(&dead));
        assert!(motion_cats(&fs).contains(&"motion-dead-selector"), "flags a dead selector: {fs:?}");
        let f = fs.iter().find(|f| f.category == "motion-dead-selector").unwrap();
        assert_eq!(f.severity, 2);
        assert!(f.why.contains("`.bar`"), "names the dead class hook: {}", f.why);
        // A component that DOES render the `.bar` hook is not flagged.
        let live = json!({ "id": "chart2", "name": "Chart2", "kitId": "k",
            "source": "export function Chart2(){ return <svg><rect className=\"bar\"/></svg>; }", "srcText": "",
            "animations": [{ "name": "spin", "selector": ".bar", "keyframes": { "from": { "transform": "scale(1)" } } }] });
        assert!(!motion_cats(&analyze_motion(std::slice::from_ref(&live))).contains(&"motion-dead-selector"));
    }

    #[test]
    fn flags_a_stroke_dash_keyframe_without_pathlength() {
        // (b) a draw-in animating stroke-dashoffset, but the source sets no pathLength.
        let draw = json!({ "id": "p", "name": "Path", "kitId": "k",
            "source": "export function Path(){ return <svg><path d=\"M0 0\"/></svg>; }", "srcText": "",
            "animations": [{ "name": "draw", "keyframes": { "from": { "stroke-dashoffset": "100" }, "to": { "stroke-dashoffset": "0" } } }] });
        assert!(motion_cats(&analyze_motion(std::slice::from_ref(&draw))).contains(&"motion-dash-no-pathlength"));
        let f = analyze_motion(std::slice::from_ref(&draw));
        assert_eq!(f.iter().find(|f| f.category == "motion-dash-no-pathlength").unwrap().severity, 1);
        // With pathLength set, it is fine.
        let ok = json!({ "id": "p2", "name": "Path2", "kitId": "k",
            "source": "export function Path2(){ return <svg><path pathLength={1} d=\"M0 0\"/></svg>; }", "srcText": "",
            "animations": [{ "name": "draw", "keyframes": { "from": { "stroke-dashoffset": "100" } } }] });
        assert!(!motion_cats(&analyze_motion(std::slice::from_ref(&ok))).contains(&"motion-dash-no-pathlength"));
    }

    #[test]
    fn flags_a_css_transform_keyframe_fighting_an_svg_transform_attribute() {
        // (c) a CSS transform keyframe on a component that uses an SVG transform= ATTRIBUTE.
        let clash = json!({ "id": "g", "name": "Group", "kitId": "k",
            "source": "export function Group(){ return <svg><g transform=\"translate(4,4)\"><rect/></g></svg>; }", "srcText": "",
            "animations": [{ "name": "rot", "keyframes": { "from": { "transform": "rotate(0)" }, "to": { "transform": "rotate(90deg)" } } }] });
        assert!(motion_cats(&analyze_motion(std::slice::from_ref(&clash))).contains(&"motion-transform-attr"));
        // A CSS-only transform (no SVG transform attribute) is fine.
        let css_only = json!({ "id": "b", "name": "Box", "kitId": "k",
            "source": "export function Box(){ return <div className=\"box\"/>; }", "srcText": "",
            "animations": [{ "name": "rot", "keyframes": { "from": { "transform": "rotate(0)" } } }] });
        assert!(!motion_cats(&analyze_motion(std::slice::from_ref(&css_only))).contains(&"motion-transform-attr"));
    }

    #[test]
    fn flags_a_cross_component_inline_name_collision_but_not_a_shared_name_ref() {
        // (d) two components in one kit each declare an INLINE `draw` → a cross-component collision.
        let a = json!({ "id": "bar", "name": "Bar", "kitId": "k",
            "animations": [{ "name": "draw", "keyframes": { "from": { "opacity": "0" }, "to": { "opacity": "1" } } }] });
        let b = json!({ "id": "line", "name": "Line", "kitId": "k",
            "animations": [{ "name": "draw", "keyframes": { "from": { "opacity": "0" }, "to": { "opacity": "1" } } }] });
        let fs = analyze_motion(&[a, b]);
        let c = fs.iter().find(|f| f.category == "motion-name-collision").expect("collision flagged");
        assert_eq!(c.severity, 2);
        assert_eq!(c.node_names, vec!["Bar", "Line"]);
        assert_eq!(c.node_ids, vec!["bar", "line"]);
        assert!(c.why.contains("`draw`"), "names the colliding animation: {}", c.why);
        // Two components that NAME-REF the same kit animation (strings) are SHARING, not colliding.
        let x = json!({ "id": "x", "name": "X", "kitId": "k", "animations": ["draw"] });
        let y = json!({ "id": "y", "name": "Y", "kitId": "k", "animations": ["draw"] });
        assert!(!motion_cats(&analyze_motion(&[x, y])).contains(&"motion-name-collision"));
        // …and the collision is per-KIT — the same inline name in two DIFFERENT kits does not collide.
        let k1 = json!({ "id": "k1", "name": "K1", "kitId": "kit1", "animations": [{ "name": "draw", "keyframes": { "from": { "opacity": "0" } } }] });
        let k2 = json!({ "id": "k2", "name": "K2", "kitId": "kit2", "animations": [{ "name": "draw", "keyframes": { "from": { "opacity": "0" } } }] });
        assert!(!motion_cats(&analyze_motion(&[k1, k2])).contains(&"motion-name-collision"));
    }

    #[test]
    fn analyze_motion_is_empty_for_name_refs_or_no_animations() {
        let none = json!({ "id": "x", "name": "X", "kitId": "k", "source": "export const C = () => null;" });
        assert!(analyze_motion(std::slice::from_ref(&none)).is_empty());
        let refs = json!({ "id": "y", "name": "Y", "kitId": "k", "animations": ["fade-in", "pulse"] });
        assert!(analyze_motion(std::slice::from_ref(&refs)).is_empty(), "name-refs alone raise no motion finding");
    }

    #[test]
    fn render_error_findings_reports_each_errored_component_and_skips_the_unknown() {
        let comps = vec![
            json!({ "id": "bsc-keyvaluelist", "name": "BscKeyValueList", "kitId": "harvested",
                    "srcText": "export const BscKeyValueList = () => null;" }),
            json!({ "id": "bsc-dropdown", "name": "BscDropdown", "kitId": "harvested",
                    "srcText": "export const BscDropdown = () => null;" }),
        ];
        let errors = vec![
            ("bsc-keyvaluelist".to_string(), "Cannot read properties of undefined (reading 'map')".to_string()),
            ("bsc-dropdown".to_string(), "trace line 1\n  at foo\n  at bar".to_string()),
            ("ghost".to_string(), "not in the store — must be dropped".to_string()),
        ];
        let f = render_error_findings(&comps, &errors);
        assert_eq!(f.len(), 2, "the stale `ghost` error is dropped");
        for x in &f {
            assert_eq!(x.category, "render-error");
            assert_eq!(x.severity, 5, "sorts above every static finding");
            assert_eq!(x.kit, "harvested");
        }
        let kvl = f.iter().find(|x| x.node_ids == ["bsc-keyvaluelist"]).unwrap();
        assert!(kvl.why.contains("reading 'map'"), "carries the real throw message");
        assert!(kvl.suggested_action.contains("bsc ui preview-props bsc-keyvaluelist"));
        // A multi-line stack trace is collapsed to one line in the summary.
        let dd = f.iter().find(|x| x.node_ids == ["bsc-dropdown"]).unwrap();
        assert!(!dd.why.contains('\n'), "the trace is flattened for the one-line finding");
    }

    #[test]
    fn render_error_findings_drops_a_stale_error_for_an_empty_srctext_component() {
        // #3737: a component reduced to an empty spec can't have a LIVE render error (the preview shows
        // no-implementation, not a throw), so a persisted error there is stale by definition. A non-empty
        // component keeps its recorded error.
        let comps = vec![
            json!({ "id": "empty", "name": "Empty", "kitId": "k", "srcText": "   " }),
            json!({ "id": "real", "name": "Real", "kitId": "k", "srcText": "export const Real = () => null;" }),
        ];
        let errors = vec![
            ("empty".to_string(), "no export Empty in @/x".to_string()),
            ("real".to_string(), "threw at render".to_string()),
        ];
        let f = render_error_findings(&comps, &errors);
        let ids: Vec<&str> = f.iter().flat_map(|x| x.node_ids.iter().map(String::as_str)).collect();
        assert!(!ids.contains(&"empty"), "the empty-srcText render-error is dropped as stale: {ids:?}");
        assert!(ids.contains(&"real"), "the non-empty component keeps its error: {ids:?}");
    }

    #[test]
    fn render_error_findings_is_empty_with_no_errors() {
        let comps = vec![json!({ "id": "a", "name": "A", "kitId": "k", "srcText": "export const A = () => null;" })];
        assert!(render_error_findings(&comps, &[]).is_empty());
    }

    #[test]
    fn render_error_findings_distinguishes_a_build_failure_from_a_render_throw() {
        let comps = vec![
            // Both carry a NON-EMPTY srcText on purpose: #3737 drops a persisted preview-error for a
            // component whose current srcText is empty (an empty spec can't have a live render error), so
            // a spec-only fixture here would be filtered as stale and this test would never reach the
            // build-vs-render prose it exists to pin.
            json!({ "id": "workspaceshellpage", "name": "WorkspaceShellPage", "kitId": "harvested",
                    "srcText": "export const WorkspaceShellPage = () => null;" }),
            json!({ "id": "bsc-dropdown", "name": "BscDropdown", "kitId": "harvested",
                    "srcText": "export const BscDropdown = () => null;" }),
        ];
        let errors = vec![
            // A `build:`-prefixed message (#3549) — the scan records esbuild failures too now.
            (
                "workspaceshellpage".to_string(),
                "build: Build failed with 1 error: mem:src/shared/ui/layouts:2:12: ERROR: Expected \"from\" but found \"{\"".to_string(),
            ),
            ("bsc-dropdown".to_string(), "render: Cannot read properties of undefined".to_string()),
        ];
        let f = render_error_findings(&comps, &errors);
        let ws = f.iter().find(|x| x.node_ids == ["workspaceshellpage"]).unwrap();
        assert!(ws.why.contains("failed to BUILD"), "build failures read as a build error, not a render throw");
        assert!(!ws.why.contains("build:"), "the kind prefix is stripped from the display message");
        assert!(ws.why.contains("Expected"), "carries the real esbuild message");
        assert!(ws.suggested_action.contains("--field srcText"), "build suggestion points at the source, not props");
        // The `render:`-prefixed one keeps the runtime prose + prop suggestion, prefix stripped.
        let dd = f.iter().find(|x| x.node_ids == ["bsc-dropdown"]).unwrap();
        assert!(dd.why.contains("threw when the preview rendered it"));
        assert!(!dd.why.contains("render:"), "the kind prefix is stripped");
        assert!(dd.suggested_action.contains("bsc ui preview-props"));
    }
}
