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
use std::collections::HashSet;

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

/// The component's own implementation source — `source` (the verbatim `.tsx`) preferred over the `srcText`
/// usage snippet, the same precedence the TS build scan uses. Empty when the record carries neither.
pub fn source_from_record(rec: &Value) -> String {
    for field in ["source", "srcText"] {
        if let Some(s) = rec.get(field).and_then(Value::as_str) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// The inspectable props the harness passes `comp_name`'s component in EVERY state — the structured twin
/// of what `bootstrapSource` mounts. Shape: `{ loaded, empty, loading }`, each `{ props: [{name, value}],
/// child }`, where `props` is in schema order (children excluded) and `child` is the (state-independent)
/// child text (`null` when the component has no `children` prop). Mirrors `previewProps` (componentPreview.ts).
///
/// `src` is the component's own implementation source ([`source_from_record`]); the props it DEFAULTS are
/// read from it once here, since that is the only thing that makes omitting a required container safe.
pub fn preview_props_states(comp_name: &str, props: &[Prop], src: &str) -> Value {
    let child = preview_child(comp_name, props);
    let defaulted = props_with_own_default(src, comp_name);
    let state = |s: &str| json!({ "props": preview_prop_list(props, s, &defaulted), "child": child });
    json!({ "loaded": state("loaded"), "empty": state("empty"), "loading": state("loading") })
}

/// The props (name + sampled JS-source value) the bootstrap passes in `state`, in schema order — each
/// non-`children` prop that samples to a non-`null` value. Mirrors `previewPropList` (componentPreview.ts).
fn preview_prop_list(props: &[Prop], state: &str, defaulted: &HashSet<String>) -> Value {
    let mut out: Vec<Value> = Vec::new();
    for p in props {
        if p.name == "children" {
            continue;
        }
        if let Some(v) = sample_prop_value(&p.name, &p.ty, p.req, state, defaulted.contains(&p.name)) {
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
/// convention — the same path object props like `gh` already take, #3693).
///
/// `has_own_default` says the component's OWN signature defaults this prop, which is what makes that
/// omission safe; callers derive it with [`props_with_own_default`]. A REQUIRED container whose component
/// does not default it gets the empty literal in every state instead of being dropped — omitting it mounts
/// the component with `undefined` where its contract promised a value.
fn sample_prop_value(name: &str, ty: &str, req: bool, state: &str, has_own_default: bool) -> Option<String> {
    if is_loading_prop(name, ty) {
        return if state == "loading" { Some("true".into()) } else { None };
    }
    let t = ty.to_lowercase();
    let is_fn = t.contains("=>") || t.contains("function") || t.contains("void") || starts_on_upper(name);
    if is_fn {
        return Some("() => {}".into());
    }
    // Data-container props (#3693): omitted in loaded/loading so the component's own default demo shows; the
    // empty state passes the typed EMPTY literal. Checked BEFORE the string/number branches because a
    // `Record<string, number>` / `Set<string>` type STRING contains "string"/"number" and would otherwise be
    // sampled as a title-cased string — rendering NaN nonsense (`Object.values("Lang Totals")`) or crashing
    // an optional-Set consumer (`"Highlight".has(k)` — a string has no `.has()`; `?.` guards only undefined).
    if is_collection_prop(ty) {
        return container_sample(req, state, "[]", has_own_default);
    }
    if is_record_type(&t) {
        return container_sample(req, state, "{}", has_own_default);
    }
    if is_set_type(&t) {
        return container_sample(req, state, "new Set()", has_own_default);
    }
    if is_map_type(&t) {
        return container_sample(req, state, "new Map()", has_own_default);
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

/// The typed EMPTY literal a data container samples to, or `None` to omit the prop — the shared tail of
/// the four container branches. Mirrors `containerSample` (componentPreview.ts).
///
/// `empty` always passes the literal. `loaded`/`loading` OMIT it so a demo-on-undefined component renders
/// its own default demo rather than a state indistinguishable from `empty` (#3693) — but ONLY when the
/// component HAS such a default. Without one, omitting a REQUIRED container mounts the component with
/// `undefined` and it throws on its first unguarded read (`Object.values(langTotals)`, `prs.length`). An
/// OPTIONAL container still omits either way: its contract allows `undefined`.
fn container_sample(req: bool, state: &str, empty_literal: &str, has_own_default: bool) -> Option<String> {
    if state == "empty" || (req && !has_own_default) {
        Some(empty_literal.into())
    } else {
        None
    }
}

/// The prop names `comp_name`'s own signature supplies a DEFAULT for — `{ workers = DEMO_WORKERS, loading =
/// false }` → `{workers, loading}`. The demo-on-undefined convention (#3693) is only safe for these. The
/// props metadata cannot express it (`req` says what the CONTRACT requires, not what the implementation
/// defaults), so it is read from the source and nowhere else. Mirrors `propsWithOwnDefault`.
///
/// Deliberately conservative — an unparsed signature yields an EMPTY set, which makes a required container
/// sample as its empty literal. That direction is the safe one: a component that wanted its demo shows an
/// empty state instead, where the reverse (a default wrongly detected) mounts `undefined` and throws.
pub fn props_with_own_default(src: &str, comp_name: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    if src.is_empty() || !is_ident(comp_name) {
        return out;
    }
    let chars: Vec<char> = src.chars().collect();
    // The declaration of THIS component (not a sibling helper that might default a same-named prop).
    let Some(decl_end) = find_declaration(&chars, comp_name) else { return out };
    let Some(open_paren) = (decl_end..chars.len()).find(|&i| chars[i] == '(') else { return out };
    let mut i = open_paren + 1;
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    if i >= chars.len() || chars[i] != '{' {
        return out; // a non-destructured param — nothing to read
    }
    for seg in destructured_segments(&chars, i) {
        let Some(eq) = assignment_eq(&seg) else { continue };
        // `{ a: b = 1 }` renames — the PROP is `a`, the binding `b`; the sampler keys on the prop.
        let head: String = seg[..eq].split(':').next().unwrap_or("").trim().to_string();
        if is_ident(&head) {
            out.insert(head);
        }
    }
    out
}

/// The index just past `function|const|let|var <name>` in `chars`, requiring word boundaries on both the
/// keyword and the name so `functionX`/`MyCardHeader` never match for `Card`.
fn find_declaration(chars: &[char], name: &str) -> Option<usize> {
    let name: Vec<char> = name.chars().collect();
    for kw in ["function", "const", "let", "var"] {
        let kw: Vec<char> = kw.chars().collect();
        let mut i = 0;
        while i + kw.len() < chars.len() {
            if chars[i..].starts_with(&kw)
                && (i == 0 || !is_ident_char(chars[i - 1]))
                && chars.get(i + kw.len()).is_some_and(|c| c.is_whitespace())
            {
                let mut j = i + kw.len();
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if chars[j..].starts_with(&name) && !chars.get(j + name.len()).is_some_and(|&c| is_ident_char(c)) {
                    return Some(j + name.len());
                }
            }
            i += 1;
        }
    }
    None
}

/// The comma-separated entries of the destructuring block opening at `chars[open]` (`{`), split at the
/// block's OWN depth so a nested `{}`/`()`/`[]` in a default value (`onOpen = () => {}`) never splits it.
/// Strings/templates are skipped whole. Mirrors `destructuredSegments`.
fn destructured_segments(chars: &[char], open: usize) -> Vec<String> {
    let (mut segs, mut depth, mut paren, mut bracket, mut seg_start) = (Vec::new(), 0i32, 0i32, 0i32, open + 1);
    let mut j = open;
    while j < chars.len() {
        let ch = chars[j];
        if ch == '"' || ch == '\'' || ch == '`' {
            j = skip_quoted(chars, j) + 1;
            continue;
        }
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    segs.push(chars[seg_start..j].iter().collect());
                    break;
                }
            }
            _ if depth != 1 => {}
            '(' => paren += 1,
            ')' => paren -= 1,
            '[' => bracket += 1,
            ']' => bracket -= 1,
            ',' if paren == 0 && bracket == 0 => {
                segs.push(chars[seg_start..j].iter().collect());
                seg_start = j + 1;
            }
            _ => {}
        }
        j += 1;
    }
    segs
}

/// The byte index of the `=` that makes `seg` a DEFAULT, or `None`. Skips the comparison/arrow forms
/// (`=>`, `==`, `>=`, `<=`, `!=`). Mirrors `assignmentEq`.
fn assignment_eq(seg: &str) -> Option<usize> {
    let chars: Vec<char> = seg.chars().collect();
    let mut j = 0;
    while j < chars.len() {
        if chars[j] == '=' {
            if matches!(chars.get(j + 1), Some('=') | Some('>')) {
                j += 2;
                continue;
            }
            if !matches!(chars.get(j.wrapping_sub(1)), Some('=') | Some('!') | Some('<') | Some('>')) || j == 0 {
                // The char index is the byte index too for the ASCII prefix any identifier head has.
                return Some(chars[..j].iter().map(|c| c.len_utf8()).sum());
            }
        }
        j += 1;
    }
    None
}

/// The index of the closing quote of the string/template starting at `chars[i]` (escapes honoured; a
/// template's `${…}` spans are skipped whole). Returns the last index when unterminated. Mirrors `skipQuoted`.
fn skip_quoted(chars: &[char], i: usize) -> usize {
    let quote = chars[i];
    let mut j = i + 1;
    while j < chars.len() {
        if chars[j] == '\\' {
            j += 2;
            continue;
        }
        if quote == '`' && chars[j] == '$' && chars.get(j + 1) == Some(&'{') {
            let mut depth = 1;
            j += 2;
            while j < chars.len() && depth > 0 {
                match chars[j] {
                    '{' => depth += 1,
                    '}' => depth -= 1,
                    _ => {}
                }
                j += 1;
            }
            continue;
        }
        if chars[j] == quote {
            return j;
        }
        j += 1;
    }
    chars.len().saturating_sub(1)
}

/// Is `s` a plain JS identifier (`[A-Za-z_$][\w$]*`)? The guard on both the component name and a parsed
/// prop head, so a malformed parse never contributes a bogus name.
fn is_ident(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$') && cs.all(is_ident_char)
}

/// Is `c` legal INSIDE an identifier (a leading digit is excluded by [`is_ident`]'s first-char check)?
fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// Is `name`/`ty` a LOADING-family boolean (`loading`/`busy`/`pending`/`isLoading`)? Mirrors `isLoadingProp`.
fn is_loading_prop(name: &str, ty: &str) -> bool {
    let t = ty.to_lowercase();
    let is_bool = t == "boolean" || t.contains("boolean");
    is_bool && matches!(name.to_lowercase().as_str(), "loading" | "busy" | "pending" | "isloading")
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
            let got = preview_props_states(name, &props, &source_from_record(comp));
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
        // optional collection: omitted in loaded/loading, `[]` in empty — regardless of a default, since
        // its contract already allows `undefined`.
        assert_eq!(sample_prop_value("data", "Row[]", false, "loaded", false), None);
        assert_eq!(sample_prop_value("data", "Row[]", false, "empty", false), Some("[]".into()));
        assert_eq!(sample_prop_value("data", "Row[]", false, "loading", false), None);
        // #3693: a REQUIRED collection the component DEFAULTS omits in loaded/loading, so its own demo data
        // renders instead of an empty list identical to `empty`.
        assert_eq!(sample_prop_value("items", "array", true, "loaded", true), None);
        assert_eq!(sample_prop_value("items", "array", true, "loading", true), None);
        assert_eq!(sample_prop_value("items", "array", true, "empty", true), Some("[]".into()));
        // Record / Set / Map containers take the same path, and pass the TYPED empty literal in `empty` —
        // never a title-cased string (which rendered NaN nonsense / crashed `x?.has()`).
        assert_eq!(sample_prop_value("langTotals", "Record<string, number>", true, "loaded", true), None);
        assert_eq!(sample_prop_value("langTotals", "Record<string, number>", true, "empty", true), Some("{}".into()));
        assert_eq!(sample_prop_value("highlight", "Set<string>", false, "loaded", false), None);
        assert_eq!(sample_prop_value("highlight", "Set<string>", false, "empty", false), Some("new Set()".into()));
        assert_eq!(sample_prop_value("byId", "Map<string, Row>", false, "empty", false), Some("new Map()".into()));
        assert_eq!(sample_prop_value("offset", "number", false, "loaded", false), Some("3".into())); // not a Set
        // loading-family boolean: `true` only in loading.
        assert_eq!(sample_prop_value("loading", "boolean", false, "loading", false), Some("true".into()));
        assert_eq!(sample_prop_value("loading", "boolean", false, "loaded", false), None);
        // name-based handler + JSON-string samples.
        assert_eq!(sample_prop_value("onClick", "MouseEventHandler", false, "loaded", false), Some("() => {}".into()));
        assert_eq!(sample_prop_value("color", "string", false, "loaded", false), Some("\"var(--accent)\"".into()));
        assert_eq!(sample_prop_value("login", "string", false, "loaded", false), Some("\"octocat\"".into()));
    }

    /// THE REGRESSION. A REQUIRED container the component does NOT default was dropped from `loaded`, so
    /// the component mounted with `undefined` and threw on its first unguarded read — `LanguageMix` on
    /// `Object.values(langTotals)`, `OpenPRsAllRepos` on `prs.length`. It gets the empty literal instead.
    #[test]
    fn a_required_container_with_no_own_default_is_supplied_in_every_state() {
        for state in ["loaded", "loading", "empty"] {
            assert_eq!(
                sample_prop_value("langTotals", "Record<string, number>", true, state, false),
                Some("{}".into()),
                "langTotals must be supplied in {state}"
            );
            assert_eq!(sample_prop_value("prs", "OpenPR[]", true, state, false), Some("[]".into()));
            assert_eq!(sample_prop_value("highlight", "Set<string>", true, state, false), Some("new Set()".into()));
            assert_eq!(sample_prop_value("byId", "Map<string, Row>", true, state, false), Some("new Map()".into()));
        }
    }

    #[test]
    fn props_with_own_default_reads_the_components_own_signature() {
        // The #3693 exemplars — these DO default, so omitting them is right.
        let worker_board = "export function WorkerBoard({ workers = DEMO_WORKERS, onOpen = () => {}, loading = false }: Props) {";
        let got = props_with_own_default(worker_board, "WorkerBoard");
        assert_eq!(got, ["workers", "onOpen", "loading"].map(String::from).into_iter().collect());
        // The reported components — no defaults anywhere, so nothing may be omitted.
        let lang_mix = "export function LanguageMix({ langTotals, repoCount, totalRepos, loading }: {\n  langTotals: Record<string, number>;\n}) {";
        assert!(props_with_own_default(lang_mix, "LanguageMix").is_empty());
        // A RENAMED binding with a default reports the PROP name, not the binding.
        assert!(props_with_own_default("function C({ contributors: list = [] }) {}", "C").contains("contributors"));
        // A rename with NO default contributes nothing.
        assert!(props_with_own_default("function C({ contributors: list }) {}", "C").is_empty());
        // An arrow component is the same shape.
        assert!(props_with_own_default("export const Card = ({ rows = [] }) => null;", "Card").contains("rows"));
    }

    #[test]
    fn props_with_own_default_is_conservative_when_it_cannot_parse() {
        // No declaration, a non-destructured param, and an empty source all yield NOTHING — which makes a
        // required container sample as its empty literal. That is the safe direction: a wrongly DETECTED
        // default omits the prop and the component throws.
        assert!(props_with_own_default("function Other({ rows = [] }) {}", "Card").is_empty());
        assert!(props_with_own_default("function Card(props) { const rows = props.rows ?? []; }", "Card").is_empty());
        assert!(props_with_own_default("", "Card").is_empty());
        // A name that only appears as a SUBSTRING of another declaration is not a match.
        assert!(props_with_own_default("function CardHeader({ rows = [] }) {}", "Card").is_empty());
        // A comma or brace inside a string default cannot desync the segment walk.
        let tricky = "function Card({ sep = \"a, b\", tpl = `x${ {y:1} }z`, rows = [1, 2], cb = (a, b) => ({ a }) }) {}";
        let got = props_with_own_default(tricky, "Card");
        assert_eq!(got, ["sep", "tpl", "rows", "cb"].map(String::from).into_iter().collect());
        // An arrow default's `=>` is not read as the assignment, and a comparison is not a default at all.
        assert!(props_with_own_default("function Card({ a, onPick = (x) => x === 1 }) {}", "Card").contains("onPick"));
        assert!(!props_with_own_default("function Card({ a, onPick = (x) => x === 1 }) {}", "Card").contains("a"));
    }

    #[test]
    fn source_from_record_prefers_the_verbatim_implementation() {
        let rec = json!({ "source": "the impl", "srcText": "the snippet" });
        assert_eq!(source_from_record(&rec), "the impl");
        assert_eq!(source_from_record(&json!({ "srcText": "the snippet" })), "the snippet");
        assert_eq!(source_from_record(&json!({ "source": "", "srcText": "the snippet" })), "the snippet");
        assert_eq!(source_from_record(&json!({})), "");
    }
}
