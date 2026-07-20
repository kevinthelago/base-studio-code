//! The GENERAL node validator — `{ type, props, children }` over the full primitive registry (#3485).
//!
//! This is the Rust FACE of the validator whose TypeScript face is `src/shared/ui/spec/generalNode.ts`.
//! Both derive their rules from the SAME generated contract (`src-tauri/data/ui/primitives.json`,
//! emitted from `shared/ui/manifest.ts`), so neither hand-maintains a copy of the vocabulary.
//!
//! ## Why two implementations, and what keeps them honest
//!
//! `bsc ui validate` is a standalone Rust CLI — it cannot import TypeScript — but it is also the
//! surface agents actually author against, so the general form has to be enforced *here* or it is not
//! really enforced at all. Two independent validators is a real risk: drifting apart is worse than
//! having one, because callers trust the agreement precisely where it is most likely to quietly break.
//!
//! So the agreement is TESTED, not asserted: `src-tauri/data/ui/node-validation.fixtures.json` is run
//! by both sides (see [`tests::shared_fixtures_match_the_typescript_validator`] and
//! `nodeValidationFixtures.test.ts`). The error MESSAGES are deliberately identical too — the fixtures
//! assert on message content, so a divergence in wording fails rather than passing quietly.

use serde_json::{Map, Value};

/// The structured prop contract, embedded at compile time. GENERATED from `shared/ui/manifest.ts`
/// (`UPDATE_KITS=1 npx vitest run primitives.gen`), which is why `react-ui.json` is no use here: it
/// flattens each prop's type to a TypeScript type STRING, losing the structured `type` + `values`.
pub const PRIMITIVES_JSON: &str = include_str!("../../../src-tauri/data/ui/primitives.json");

/// The parsed primitive contract, as a name → spec map.
fn primitives() -> Map<String, Value> {
    let parsed: Value = serde_json::from_str(PRIMITIVES_JSON).unwrap_or(Value::Null);
    let mut by_name = Map::new();
    if let Some(list) = parsed.get("primitives").and_then(Value::as_array) {
        for p in list {
            if let Some(name) = p.get("name").and_then(Value::as_str) {
                by_name.insert(name.to_string(), p.clone());
            }
        }
    }
    by_name
}

/// Every primitive name the contract defines — the closed `type` vocabulary.
pub fn primitive_names() -> Vec<String> {
    primitives().keys().cloned().collect()
}

fn is_object(v: &Value) -> bool {
    v.is_object()
}

/// A node-ish value: a general node (`type`) or a legacy kind node (`kind`).
fn is_node_like(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str).is_some() || v.get("kind").and_then(Value::as_str).is_some()
}

/// Check one prop VALUE against its declared type. `None` = acceptable.
///
/// Mirrors `checkValue` in `generalNode.ts` arm for arm, including the wording. Note `function`:
/// in a data tree a handler is the NAME of a host action, never a literal — a stricter and more
/// meaningful rule than a type check, since a tree carrying a function has stopped being data.
fn check_value(ty: &str, values: Option<&Vec<Value>>, v: &Value) -> Option<String> {
    match ty {
        "string" => (!v.is_string()).then(|| "expected a string".to_string()),
        "number" => (!v.is_number()).then(|| "expected a number".to_string()),
        "boolean" => (!v.is_boolean()).then(|| "expected a boolean".to_string()),
        "enum" => {
            let allowed: Vec<&str> = values
                .map(|vs| vs.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if allowed.is_empty() {
                return None; // an enum with no declared set constrains nothing
            }
            let got = v.as_str().unwrap_or("");
            if allowed.contains(&got) {
                None
            } else {
                let shown = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                Some(format!("\"{shown}\" is not one of {}", allowed.join(", ")))
            }
        }
        "node" => {
            if v.is_string() || v.is_number() {
                return None;
            }
            if let Some(arr) = v.as_array() {
                return (!arr.iter().all(is_node_like)).then(|| "expected nodes or text".to_string());
            }
            (!is_node_like(v)).then(|| "expected a node, a list of nodes, or text".to_string())
        }
        "function" => (!v.is_string()).then(|| {
            "expected an action NAME (a string) — a data tree binds handlers by name, it cannot carry a function"
                .to_string()
        }),
        "color" => (!v.is_string()).then(|| "expected a color string (token or CSS color)".to_string()),
        "space" | "fontSize" => (!(v.is_number() || v.is_string()))
            .then(|| "expected a rung name or a number".to_string()),
        "tracks" => (!(v.is_number() || v.is_string()))
            .then(|| "expected a track count (number) or a template string".to_string()),
        "style" => (!is_object(v)).then(|| "expected a style object".to_string()),
        // Contents deliberately unchecked — the manifest keeps array/object shapes in prose, so there
        // is no schema to check against. The container is verified and no further; that gap is stated
        // in `VALIDATION_COVERAGE` rather than left for a caller to discover.
        "array" => (!v.is_array()).then(|| "expected an array".to_string()),
        "object" => (!is_object(v)).then(|| "expected an object".to_string()),
        _ => None,
    }
}

/// Structurally validate a general node tree against the primitive contract. Returns a flat list of
/// human-readable errors (empty = valid), identical to the TypeScript validator's output.
pub fn validate_general_node(node: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    let by_name = primitives();
    walk_general(node, "$", &by_name, &mut errors);
    errors
}

fn walk_general(node: &Value, path: &str, by_name: &Map<String, Value>, errors: &mut Vec<String>) {
    if !is_object(node) {
        errors.push(format!("{path}: expected a node object"));
        return;
    }
    let Some(ty) = node.get("type").and_then(Value::as_str) else {
        errors.push(format!("{path}: missing string \"type\""));
        return;
    };
    let Some(spec) = by_name.get(ty) else {
        errors.push(format!("{path}: unknown primitive \"{ty}\""));
        return;
    };

    let props = node.get("props");
    if let Some(p) = props {
        if !is_object(p) {
            errors.push(format!("{path}.props: expected an object"));
            return;
        }
    }

    // Node-level `children` is SUGAR for the `children` PROP — the contract models children as React
    // does (a `node` prop, required on containers), but authoring `props: { children: … }` at every
    // level is miserable. Normalise so both forms validate identically.
    let mut given: Map<String, Value> =
        props.and_then(Value::as_object).cloned().unwrap_or_default();
    let wrote_children_at_node_level = node.get("children").is_some();
    if let Some(c) = node.get("children") {
        given.insert("children".into(), c.clone());
    }

    let empty = Vec::new();
    let declared = spec.get("props").and_then(Value::as_array).unwrap_or(&empty);
    let passthrough = spec.get("passthrough").and_then(Value::as_bool).unwrap_or(false);

    // Unknown props — skipped for a passthrough primitive, which forwards arbitrary DOM props by
    // design. Flagging those would be a false positive, and a validator that cries wolf gets ignored.
    if !passthrough {
        for key in given.keys() {
            let known = declared
                .iter()
                .any(|d| d.get("name").and_then(Value::as_str) == Some(key.as_str()));
            if !known {
                errors.push(format!("{path}.props.{key}: unknown prop for \"{ty}\""));
            }
        }
    }

    for d in declared {
        let Some(name) = d.get("name").and_then(Value::as_str) else { continue };
        let required = d.get("required").and_then(Value::as_bool).unwrap_or(false);
        let value = given.get(name).filter(|v| !v.is_null());
        let Some(value) = value else {
            if required {
                errors.push(format!("{path}.props.{name}: missing required prop for \"{ty}\""));
            }
            continue; // an absent optional prop takes the component's default
        };
        let d_ty = d.get("type").and_then(Value::as_str).unwrap_or("");
        let values = d.get("values").and_then(Value::as_array);
        if let Some(err) = check_value(d_ty, values, value) {
            errors.push(format!("{path}.props.{name}: {err}"));
        }
    }

    // The node-level actions map (#3496): prop name → host action name. Exists because `passthrough`
    // primitives forward arbitrary DOM props, so their handlers are UNDECLARED and the manifest gives
    // no way to infer them — and inferring from the prop's NAME is exactly what this design avoids.
    if let Some(actions) = node.get("actions") {
        match actions.as_object() {
            None => errors.push(format!("{path}.actions: expected an object of prop → action name")),
            Some(map) => {
                for (prop_name, action_name) in map {
                    let ok = action_name.as_str().map(|s| !s.is_empty()).unwrap_or(false);
                    if !ok {
                        errors.push(format!(
                            "{path}.actions.{prop_name}: expected a non-empty action name (a string)"
                        ));
                    }
                    let declared = declared
                        .iter()
                        .find(|d| d.get("name").and_then(Value::as_str) == Some(prop_name.as_str()));
                    match declared {
                        Some(d) => {
                            let d_ty = d.get("type").and_then(Value::as_str).unwrap_or("");
                            if d_ty != "function" {
                                errors.push(format!(
                                    "{path}.actions.{prop_name}: \"{prop_name}\" is declared as {d_ty}, not a handler, on \"{ty}\""
                                ));
                            }
                        }
                        // Undeclared is legitimate only where undeclared props are (a passthrough
                        // primitive) — that is the whole reason this map exists.
                        None if !passthrough => {
                            errors.push(format!("{path}.actions.{prop_name}: unknown prop for \"{ty}\""));
                        }
                        None => {}
                    }
                }
            }
        }
    }

    // Recurse into every node-valued prop (a slot) — `children` included, since it was normalised.
    // The path reports where the value was WRITTEN, so a message points at the author's own source.
    for (name, value) in &given {
        let is_node_prop = declared.iter().any(|d| {
            d.get("name").and_then(Value::as_str) == Some(name.as_str())
                && d.get("type").and_then(Value::as_str) == Some("node")
        });
        if !is_node_prop {
            continue;
        }
        let where_ = if name == "children" && wrote_children_at_node_level {
            format!("{path}.children")
        } else {
            format!("{path}.props.{name}")
        };
        if let Some(arr) = value.as_array() {
            for (i, child) in arr.iter().enumerate() {
                if is_node_like(child) {
                    walk_any(child, &format!("{where_}[{i}]"), by_name, errors);
                }
            }
        } else if is_node_like(value) {
            walk_any(value, &where_, by_name, errors);
        }
    }
}

/// Dispatch while the general form and the legacy kinds coexist (removed in 3c, #3484).
fn walk_any(node: &Value, path: &str, by_name: &Map<String, Value>, errors: &mut Vec<String>) {
    if node.get("kind").and_then(Value::as_str).is_some() {
        return; // a legacy node — `validate_spec` owns it
    }
    walk_general(node, path, by_name, errors);
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES_JSON: &str =
        include_str!("../../../src-tauri/data/ui/node-validation.fixtures.json");

    #[test]
    fn the_embedded_contract_parses_and_covers_the_registry() {
        let names = primitive_names();
        assert!(names.len() > 50, "expected the full primitive registry, got {}", names.len());
        for expected in ["Text", "Stack", "Card", "Row", "Button"] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    /// THE cross-language guard. Both validators run these fixtures; the error messages are identical
    /// by construction, so a divergence in wording fails here rather than passing quietly. A case
    /// added to the JSON is automatically enforced on both sides.
    #[test]
    fn shared_fixtures_match_the_typescript_validator() {
        let parsed: Value = serde_json::from_str(FIXTURES_JSON).expect("fixtures are valid JSON");
        let cases = parsed.get("cases").and_then(Value::as_array).expect("cases array");
        assert!(cases.len() > 10, "a silently-empty fixture set would make this guard vacuous");

        for case in cases {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("<unnamed>");
            let node = case.get("node").expect("case has a node");
            let want = case.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
            let errors = validate_general_node(node);

            assert_eq!(
                errors.len(),
                want,
                "case \"{name}\": expected {want} error(s), got {:?}",
                errors
            );
            if let Some(contains) = case.get("contains").and_then(Value::as_array) {
                for needle in contains.iter().filter_map(Value::as_str) {
                    assert!(
                        errors.iter().any(|e| e.contains(needle)),
                        "case \"{name}\": no error contained \"{needle}\" — got {:?}",
                        errors
                    );
                }
            }
        }
    }

    #[test]
    fn a_passthrough_primitive_does_not_flag_unknown_props() {
        // Guarded separately from the fixtures because the two validators BRANCH on this flag — a
        // wrong value in the generated contract would make them disagree silently.
        let node = serde_json::json!({
            "type": "Text", "children": "x", "props": { "data-testid": "t" }
        });
        assert!(validate_general_node(&node).is_empty());
    }

    #[test]
    fn a_legacy_kind_child_is_left_to_the_legacy_validator() {
        // While both vocabularies coexist, a `kind` node nested under a general one must not be
        // reported as an unknown primitive — it belongs to `validate_spec`.
        let node = serde_json::json!({
            "type": "Stack", "children": [{ "kind": "text", "text": "hi" }]
        });
        assert!(validate_general_node(&node).is_empty(), "{:?}", validate_general_node(&node));
    }
}
