//! Preview-harness prop sampler (#3165) — the Rust mirror of the Design Studio's `samplePropValue` +
//! bootstrap prop assembly (`src/features/designs/lib/componentPreview.ts`). It computes EXACTLY the
//! props the build-and-iframe preview passes a component in each data-state (loaded / empty / loading),
//! so `bsc ui preview-props <id>` can print them from a session's shell — making the harness inspectable
//! (schema-derived sample values caused black bars + a NaN-collapsed ChartFrame, invisible from the CLI).
//!
//! Each sampled value is a JS-SOURCE literal/expression (what the iframe evaluates), NOT a JSON value —
//! e.g. `() => {}`, `window.innerWidth`, `Math.min(window.innerWidth, window.innerHeight)`, or a
//! `JSON.stringify`'d string like `"var(--accent)"`. This MUST stay byte-for-byte in lockstep with the TS
//! sampler; a shared golden fixture (`src/features/designs/lib/previewProps.fixtures.json`) is asserted on
//! BOTH sides (the TS `previewProps.test.ts` and the `#[cfg(test)]` block below) so drift is caught.

use serde_json::{json, Value};

/// One public prop of a component — the sampler's input (name + loose `type` + required). Mirrors the
/// `PropSpec` fields the TS sampler reads (`desc` is irrelevant here).
pub struct Prop {
    pub name: String,
    pub ty: String,
    pub req: bool,
}

/// Extract the `props` array of a stored component record into [`Prop`]s (missing/odd fields default to
/// empty/false, matching the lenient TS read). Absent `props` ⇒ an empty vec.
pub fn props_from_record(rec: &Value) -> Vec<Prop> {
    rec.get("props")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|p| Prop {
                    name: p.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    ty: p.get("type").and_then(Value::as_str).unwrap_or_default().to_string(),
                    req: p.get("req").and_then(Value::as_bool).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The inspectable props the harness passes `comp_name`'s component in EVERY state — the structured twin
/// of what `bootstrapSource` mounts. Shape: `{ loaded, empty, loading }`, each `{ props: [{name, value}],
/// child }`, where `props` is in schema order (children excluded) and `child` is the (state-independent)
/// child text (`null` when the component has no `children` prop). Mirrors `previewProps` (componentPreview.ts).
pub fn preview_props_states(comp_name: &str, props: &[Prop]) -> Value {
    let child = preview_child(comp_name, props);
    // #84 — state-independent (untypeability is a fact about the TYPE), but carried on every state so a
    // caller reading ONE state (what `--state` narrows to) still sees it.
    let unsampled: Vec<Value> = unsampled_required_props(props).into_iter().map(|p| json!(p.name)).collect();
    let state = |s: &str| json!({
        "props": preview_prop_list(props, s),
        "child": child,
        "unsampled": Value::Array(unsampled.clone()),
    });
    json!({ "loaded": state("loaded"), "empty": state("empty"), "loading": state("loading") })
}

/// Can the sampler produce a value for `name`/`ty` FROM ITS TYPE at all, or does the type match no branch
/// of [`sample_prop_value`]? Mirrors `cannotTypeProp` (componentPreview.ts).
///
/// The distinction is the point (#84). A prop is absent from a sampled state for one of two reasons and
/// only one is a problem: a loading/error-family prop and a data container are omitted BY DESIGN (their own
/// state supplies them, or the component's own demo does), while an UNTYPEABLE prop is omitted because the
/// type STRING matched nothing — `ModelId`/`ViewKey` are NAMED ALIASES over string-literal unions, so even
/// the last-resort inline-union regex finds no quoted literal. A required prop in the second group is
/// dropped silently and the component mounts with `undefined` where its contract promised a value.
pub fn cannot_type_prop(name: &str, ty: &str) -> bool {
    if is_loading_prop(name, ty) || is_error_prop(name, ty) {
        return false; // set in their own state, by design
    }
    let t = ty.to_lowercase();
    if t.contains("=>") || t.contains("function") || t.contains("void") || starts_on_upper(name) {
        return false;
    }
    if is_collection_prop(ty) || is_record_type(&t) || is_set_type(&t) || is_map_type(&t) {
        return false; // the container rule
    }
    if t.contains("node") || t.contains("string") || t.contains("number") || t.contains("boolean") {
        return false;
    }
    first_string_literal(ty).is_none()
}

/// The REQUIRED props the sampler cannot type, in schema order — the preview's own report that a component
/// is mounted without part of its contract. `children` is excluded (it is passed as the element's child,
/// never as a prop). Mirrors `unsampledRequiredProps` (componentPreview.ts).
pub fn unsampled_required_props(props: &[Prop]) -> Vec<&Prop> {
    props
        .iter()
        .filter(|p| p.req && p.name != "children" && cannot_type_prop(&p.name, &p.ty))
        .collect()
}

/// The props (name + sampled JS-source value) the bootstrap passes in `state`, in schema order — each
/// non-`children` prop that samples to a non-`null` value. Mirrors `previewPropList` (componentPreview.ts).
fn preview_prop_list(props: &[Prop], state: &str) -> Value {
    let mut out: Vec<Value> = Vec::new();
    for p in props {
        if p.name == "children" {
            continue;
        }
        if let Some(v) = sample_prop_value(&p.name, &p.ty, p.req, state) {
            out.push(json!({ "name": p.name, "value": v }));
        }
    }
    Value::Array(out)
}

/// The child text (`JSON.stringify(prettyName(name))`) when the component declares a `children` prop,
/// else JSON `null`. Mirrors `previewChild` (componentPreview.ts).
fn preview_child(comp_name: &str, props: &[Prop]) -> Value {
    if props.iter().any(|p| p.name == "children") {
        Value::String(json_string(&pretty_name(comp_name)))
    } else {
        Value::Null
    }
}

/// A best-effort sample value (as JS source) for a prop, or `None` to omit it — the Rust twin of
/// `samplePropValue`. `state` drives the data-state: `loading` turns a loading-family boolean on; `empty`
/// passes the typed EMPTY literal for a data container (`[]` array, `{}` Record, `new Set()`, `new Map()`);
/// `loaded`/`loading` OMIT a container so the component's own default demo renders (the demo-on-undefined
/// convention — the same path object props like `gh` already take, #3693). `req` no longer forces a value:
/// a required container omits in loaded exactly as a required object prop already does.
fn sample_prop_value(name: &str, ty: &str, _req: bool, state: &str) -> Option<String> {
    if is_loading_prop(name, ty) {
        return if state == "loading" { Some("true".into()) } else { None };
    }
    let t = ty.to_lowercase();
    let is_fn = t.contains("=>") || t.contains("function") || t.contains("void") || starts_on_upper(name);
    // #3555 — an ERROR-family prop is set ONLY in the `error` state, and omitted in loaded/empty/loading
    // so the component renders normally. The `error` state itself is TS-only and outside this contract, so
    // here the prop simply always omits, which is exactly what the TS twin does for the three states this
    // contract DOES cover.
    //
    // This branch was MISSING, and nothing caught it: no fixture case carried an error-family prop, so the
    // twins silently disagreed — Rust fell through to the string branch and sampled `error` as `"Error"`
    // while TS omitted it. Found by adding the #84 case below, which needs one to prove an error-family
    // prop is not reported as unsampled.
    if is_error_prop(name, ty) {
        return None;
    }
    if is_fn {
        return Some("() => {}".into());
    }
    // Data-container props (#3693): omitted in loaded/loading so the component's own default demo shows; the
    // empty state passes the typed EMPTY literal. Checked BEFORE the string/number branches because a
    // `Record<string, number>` / `Set<string>` type STRING contains "string"/"number" and would otherwise be
    // sampled as a title-cased string — rendering NaN nonsense (`Object.values("Lang Totals")`) or crashing
    // an optional-Set consumer (`"Highlight".has(k)` — a string has no `.has()`; `?.` guards only undefined).
    if is_collection_prop(ty) {
        return if state == "empty" { Some("[]".into()) } else { None };
    }
    if is_record_type(&t) {
        return if state == "empty" { Some("{}".into()) } else { None };
    }
    if is_set_type(&t) {
        return if state == "empty" { Some("new Set()".into()) } else { None };
    }
    if is_map_type(&t) {
        return if state == "empty" { Some("new Map()".into()) } else { None };
    }
    if t.contains("reactnode") || t.contains("node") {
        return Some(json_string(&pretty_name(name)));
    }
    if t == "string" || t.contains("string") {
        return Some(json_string(&sample_string(name)));
    }
    if t == "number" || t.contains("number") {
        return Some(number_sample(name));
    }
    if t == "boolean" || t.contains("boolean") {
        return Some("true".into());
    }
    // enum-like unions ("a" | "b") → the first literal.
    first_string_literal(ty).map(|lit| json_string(&lit))
}

/// Is `name`/`ty` a LOADING-family boolean (`loading`/`busy`/`pending`/`isLoading`)? Mirrors `isLoadingProp`.
fn is_loading_prop(name: &str, ty: &str) -> bool {
    let t = ty.to_lowercase();
    let is_bool = t == "boolean" || t.contains("boolean");
    is_bool && matches!(name.to_lowercase().as_str(), "loading" | "busy" | "pending" | "isloading")
}

/// Is `name`/`ty` an ERROR-family prop (`error`/`err`/`isError`/`hasError`)? Mirrors `isErrorProp`.
///
/// The `error` STATE (#3555) is TS-only and deliberately outside this cross-language contract, so
/// `sample_prop_value` has no error branch. The predicate is still needed here: an error-family prop is
/// absent from loaded/empty/loading BY DESIGN, so [`cannot_type_prop`] must not report it as missing. A
/// callback like `onError` is not one — the function-name shape excludes it, as it does in the TS twin.
fn is_error_prop(name: &str, ty: &str) -> bool {
    let t = ty.to_lowercase();
    let is_fn = t.contains("=>") || t.contains("function") || t.contains("void") || starts_on_upper(name);
    !is_fn && matches!(name.to_lowercase().as_str(), "error" | "err" | "iserror" | "haserror")
}

/// Is `ty` a COLLECTION prop (`Row[]`, `array`)? Case-insensitive substring. Mirrors `isCollectionProp`.
fn is_collection_prop(ty: &str) -> bool {
    let t = ty.to_lowercase();
    t.contains("[]") || t.contains("array")
}

/// Is `t` (a LOWERCASED type) a `Record<K, V>` map object — a data container whose empty literal is `{}`
/// (distinct from an array's `[]`)? Mirrors `isRecordType`.
fn is_record_type(t: &str) -> bool {
    t.starts_with("record<")
}

/// Is `t` (LOWERCASED) a `Set<T>` / `ReadonlySet<T>`? Its empty literal is `new Set()`. The `set<` boundary
/// (or an exact bare `set`) keeps `offset`/`dataset`/`subset` out. Mirrors `isSetType`.
fn is_set_type(t: &str) -> bool {
    t == "set" || t.starts_with("set<") || t.starts_with("readonlyset<")
}

/// Is `t` (LOWERCASED) a `Map<K, V>` / `ReadonlyMap<K, V>`? Its empty literal is `new Map()`. Mirrors `isMapType`.
fn is_map_type(t: &str) -> bool {
    t == "map" || t.starts_with("map<") || t.starts_with("readonlymap<")
}

/// Does `name` match `/^on[A-Z]/` — an `onFoo` handler by convention? Case-sensitive `on` + an ASCII
/// uppercase letter (mirrors the TS regex).
fn starts_on_upper(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() >= 3 && &b[0..2] == b"on" && (b[2] as char).is_ascii_uppercase()
}

/// A readable placeholder from a name (`whenUse` → `When Use`). Mirrors `prettyName`: space before each
/// ASCII-uppercase char, `-`/`_` → space, trim, uppercase the first char.
fn pretty_name(name: &str) -> String {
    let mut spaced = String::with_capacity(name.len() + 4);
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            spaced.push(' ');
            spaced.push(c);
        } else if c == '-' || c == '_' {
            spaced.push(' ');
        } else {
            spaced.push(c);
        }
    }
    let trimmed = spaced.trim();
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A plausible string sample — a color token for color-ish props, a login for user-ish props, else the
/// pretty name. Mirrors `sampleString`.
fn sample_string(name: &str) -> String {
    let n = name.to_lowercase();
    if ["color", "colour", "tone", "accent", "fill", "stroke"].iter().any(|k| n.contains(k)) {
        return "var(--accent)".into();
    }
    if ["login", "user", "author"].iter().any(|k| n.contains(k)) {
        return "octocat".into();
    }
    pretty_name(name)
}

/// A number sample as JS source. CANVAS-dimension names (width/height/size/extent) sample with the frame
/// size (`window.innerWidth`/…) so a sized d3 component fills the frame; STYLE dimensions (stroke/border/
/// font/…) are guarded out. A LAYOUT-COLUMN width/height (`rail`/`aside`/`sidebar`/`drawer`/`panel`/`col`)
/// is a fixed `240` — a `flex: none` sidebar sized to the viewport otherwise eats the whole preview frame
/// (#3693). Ratio-ish names → `0.6`, else `3`. Mirrors `numberSample`.
fn number_sample(name: &str) -> String {
    let n = name.to_lowercase();
    let style_dim = ["stroke", "border", "font", "line", "gap", "margin", "pad", "spacing", "weight", "gutter", "inset", "offset"]
        .iter()
        .any(|k| n.contains(k));
    let layout_dim = ["rail", "aside", "sidebar", "drawer", "panel", "col"].iter().any(|k| n.contains(k));
    if !style_dim {
        let is_w = n == "w" || n == "width" || n.ends_with("width");
        let is_h = n == "h" || n == "height" || n.ends_with("height");
        if layout_dim && (is_w || is_h) {
            return "240".into();
        }
        if is_w {
            return "window.innerWidth".into();
        }
        if is_h {
            return "window.innerHeight".into();
        }
        if n == "size" || n == "extent" {
            return "Math.min(window.innerWidth, window.innerHeight)".into();
        }
    }
    if ["value", "fraction", "ratio", "progress", "percent", "opacity"].iter().any(|k| n.contains(k)) {
        "0.6".into()
    } else {
        "3".into()
    }
}

/// The first `"…"` string literal in `ty` (the first enum member of a union), or `None`. Mirrors the TS
/// `type.match(/"([^"]+)"/)` — the leftmost quote pair enclosing at least one non-quote char.
fn first_string_literal(ty: &str) -> Option<String> {
    let b = ty.as_bytes();
    let n = b.len();
    let mut i = 0;
    while i < n {
        if b[i] == b'"' {
            let mut j = i + 1;
            while j < n && b[j] != b'"' {
                j += 1;
            }
            if j < n && j > i + 1 {
                return Some(ty[i + 1..j].to_string());
            }
        }
        i += 1;
    }
    None
}

/// Serialize `s` as a JSON string literal — the Rust twin of `JSON.stringify(<string>)` (quotes + escapes).
fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("{s:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The SHARED golden fixture, also asserted by the TS `previewProps.test.ts` — the one contract that
    /// keeps the Rust sampler and the TS harness byte-for-byte in lockstep. (`include_str!` reaches into
    /// the frontend tree like `graph_health.rs` does for the packaged artifact; renaming/moving the
    /// fixture means updating this path + the TS import in lockstep.)
    const FIXTURES: &str = include_str!("../../../src/features/designs/lib/previewProps.fixtures.json");

    #[test]
    fn preview_props_matches_the_ts_parity_fixture() {
        let root: Value = serde_json::from_str(FIXTURES).expect("fixture is valid JSON");
        let cases = root.get("cases").and_then(Value::as_array).expect("fixture has cases[]");
        assert!(!cases.is_empty(), "fixture must carry cases");
        for case in cases {
            let comp = case.get("comp").expect("case.comp");
            let name = comp.get("name").and_then(Value::as_str).expect("comp.name");
            let props = props_from_record(comp);
            let got = preview_props_states(name, &props);
            let expected = case.get("expected").expect("case.expected");
            let desc = case.get("desc").and_then(Value::as_str).unwrap_or("");
            assert_eq!(&got, expected, "preview-props parity drift — case: {desc}");
        }
    }

    #[test]
    fn pretty_name_mirrors_the_ts_twin() {
        assert_eq!(pretty_name("whenUse"), "When Use");
        assert_eq!(pretty_name("label"), "Label");
        assert_eq!(pretty_name("my-chart"), "My chart");
        assert_eq!(pretty_name(""), "");
    }

    #[test]
    fn first_string_literal_finds_the_leftmost_nonempty_pair() {
        assert_eq!(first_string_literal("\"a\" | \"b\"").as_deref(), Some("a"));
        assert_eq!(first_string_literal("\"neutral\" | \"danger\"").as_deref(), Some("neutral"));
        assert_eq!(first_string_literal("string"), None);
        assert_eq!(first_string_literal("\"\""), None); // empty pair — no non-empty capture
    }

    #[test]
    fn number_sample_canvas_vs_style_dimensions() {
        assert_eq!(number_sample("width"), "window.innerWidth");
        assert_eq!(number_sample("chartWidth"), "window.innerWidth");
        assert_eq!(number_sample("height"), "window.innerHeight");
        assert_eq!(number_sample("size"), "Math.min(window.innerWidth, window.innerHeight)");
        assert_eq!(number_sample("strokeWidth"), "3"); // style dim — never the viewport size
        assert_eq!(number_sample("railWidth"), "240"); // #3693 layout column — a fixed px, not the viewport
        assert_eq!(number_sample("asideWidth"), "240");
        assert_eq!(number_sample("sidebarHeight"), "240");
        assert_eq!(number_sample("opacity"), "0.6");
        assert_eq!(number_sample("count"), "3");
    }

    #[test]
    fn sample_prop_value_data_state_threading() {
        // optional collection: omitted in loaded/loading, `[]` in empty.
        assert_eq!(sample_prop_value("data", "Row[]", false, "loaded"), None);
        assert_eq!(sample_prop_value("data", "Row[]", false, "empty"), Some("[]".into()));
        assert_eq!(sample_prop_value("data", "Row[]", false, "loading"), None);
        // #3693: a REQUIRED collection now also omits in loaded/loading (only `empty` passes `[]`), so the
        // component's own default demo data renders in loaded instead of an empty list identical to `empty`.
        assert_eq!(sample_prop_value("items", "array", true, "loaded"), None);
        assert_eq!(sample_prop_value("items", "array", true, "loading"), None);
        assert_eq!(sample_prop_value("items", "array", true, "empty"), Some("[]".into()));
        // #3693: Record / Set / Map containers omit in loaded, and pass the TYPED empty literal in `empty`
        // — never a title-cased string (which rendered NaN nonsense / crashed `x?.has()`).
        assert_eq!(sample_prop_value("langTotals", "Record<string, number>", true, "loaded"), None);
        assert_eq!(sample_prop_value("langTotals", "Record<string, number>", true, "empty"), Some("{}".into()));
        assert_eq!(sample_prop_value("highlight", "Set<string>", false, "loaded"), None);
        assert_eq!(sample_prop_value("highlight", "Set<string>", false, "empty"), Some("new Set()".into()));
        assert_eq!(sample_prop_value("byId", "Map<string, Row>", false, "empty"), Some("new Map()".into()));
        assert_eq!(sample_prop_value("offset", "number", false, "loaded"), Some("3".into())); // not a Set
        // loading-family boolean: `true` only in loading.
        assert_eq!(sample_prop_value("loading", "boolean", false, "loading"), Some("true".into()));
        assert_eq!(sample_prop_value("loading", "boolean", false, "loaded"), None);
        // name-based handler + JSON-string samples.
        assert_eq!(sample_prop_value("onClick", "MouseEventHandler", false, "loaded"), Some("() => {}".into()));
        assert_eq!(sample_prop_value("color", "string", false, "loaded"), Some("\"var(--accent)\"".into()));
        assert_eq!(sample_prop_value("login", "string", false, "loaded"), Some("\"octocat\"".into()));
    }

    /// #3555 — an ERROR-family prop is omitted in the three states this contract covers. The branch was
    /// MISSING and no fixture case carried such a prop, so Rust sampled `error` as the string `"Error"`
    /// while TS omitted it, and the twins disagreed silently.
    #[test]
    fn an_error_family_prop_omits_in_every_state_this_contract_covers() {
        for state in ["loaded", "empty", "loading"] {
            assert_eq!(sample_prop_value("error", "string", true, state), None, "error in {state}");
            assert_eq!(sample_prop_value("hasError", "boolean", false, state), None);
            assert_eq!(sample_prop_value("err", "string", false, state), None);
        }
        // A CALLBACK is not an error prop — the function-name shape excludes it, as in the TS twin.
        assert_eq!(sample_prop_value("onError", "() => void", false, "loaded"), Some("() => {}".into()));
        // A merely error-ISH name is not one either.
        assert_eq!(sample_prop_value("errorCount", "number", false, "loaded"), Some("3".into()));
    }

    /// THE REPORT (#84). A required prop whose type the sampler cannot read is NAMED, so it stops being a
    /// mystery render-error — `PaneMenu` reported `Cannot read properties of null (reading 'find')` and its
    /// whole dependency chain was searched for a null `.find()` that was never there.
    #[test]
    fn unsampled_reports_only_the_props_the_sampler_cannot_type() {
        let p = |name: &str, ty: &str, req: bool| Prop { name: name.into(), ty: ty.into(), req };

        // A named alias over a string-literal union carries no quoted literal, so nothing matches.
        assert!(cannot_type_prop("model", "ModelId"));
        assert!(cannot_type_prop("active", "ViewKey"));
        // An object type and a bare generic are the same case — measured, they are most of it.
        assert!(cannot_type_prop("vp", "GraphViewport"));
        assert!(cannot_type_prop("value", "T"));
        // Everything the sampler CAN type, and every DELIBERATE omission, is not reported.
        for (n, t) in [
            ("tone", "\"neutral\" | \"danger\""), // an INLINE union — the last-resort regex finds it
            ("label", "string"), ("count", "number"), ("open", "boolean"), ("body", "ReactNode"),
            ("onPick", "(v) => void"), ("onChange", "ChangeHandler"), // fn by type, then by name shape
            ("rows", "Row[]"), ("byId", "Record<string, number>"), ("tags", "Set<string>"), // containers
            ("loading", "boolean"), ("error", "string"), // state-driven families
        ] {
            assert!(!cannot_type_prop(n, t), "{n}: {t} must NOT be reported");
        }

        // Only REQUIRED props are reported (an optional one is allowed to be absent), and `children` never
        // is — it is passed as the element's child, not as a prop.
        let props = vec![
            p("model", "ModelId", true),
            p("hint", "AliasedButOptional", false),
            p("children", "Unknown", true),
            p("vp", "GraphViewport", true),
        ];
        let got: Vec<&str> = unsampled_required_props(&props).iter().map(|p| p.name.as_str()).collect();
        assert_eq!(got, vec!["model", "vp"]);
    }
}
