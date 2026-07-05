//! `bsc-ui` — the spec-first UI SDK's agent-facing core (#1852 Phase 2). A KitNode is a declarative,
//! style/theme-independent description of UI that an AI emits as *data* (never JSX). This crate embeds
//! the KitNode contract from the ONE source of truth — `src-tauri/data/ui/kit-nodes.json`, the same
//! file the frontend SDK reads via `@data` — and provides a structural validator over it, surfaced as
//! the `bsc ui` CLI ([`cli`]). So a live session can author a spec and check it with `bsc ui validate`
//! from its own shell, against the exact contract the frontend `KitRenderer` renders.
//!
//! The validator mirrors the frontend `validateKitNode` (src/shared/ui/spec/schema.ts) rule-for-rule:
//! at every node — `kind` present + known · every required field present · no field outside the kind's
//! allowed set · enum fields hold an allowed value · a children-bearing kind's `children` (when present)
//! is an array — recursing into any nested node (`header`) or array-of-nodes (`children`).

pub mod cli;

use serde_json::Value;

/// The KitNode contract, embedded at compile time from the single source of truth
/// (`src-tauri/data/ui/kit-nodes.json`). The frontend SDK reads the same file via `@data/ui/...`, so
/// the two faces of the SDK can never drift.
pub const CONTRACT_JSON: &str = include_str!("../../../src-tauri/data/ui/kit-nodes.json");

/// The parsed contract. The embedded file is valid JSON (guarded by [`tests::contract_is_valid`]), so
/// this does not fail in practice.
pub fn contract() -> Value {
    serde_json::from_str(CONTRACT_JSON).expect("embedded kit-nodes.json is valid JSON")
}

/// Structurally validate a KitNode tree against the contract — the EXACT rules the frontend
/// `validateKitNode` enforces, so a spec valid here is valid there. Returns the flat list of
/// human-readable errors (empty = valid).
pub fn validate_spec(node: &Value) -> Vec<String> {
    let contract = contract();
    let nodes = contract.get("nodes").cloned().unwrap_or(Value::Null);
    let mut errors = Vec::new();
    walk(node, "$", &nodes, &mut errors);
    errors
}

fn walk(node: &Value, path: &str, nodes: &Value, errors: &mut Vec<String>) {
    let Some(obj) = node.as_object() else {
        errors.push(format!("{path}: expected a node object"));
        return;
    };
    let Some(kind) = obj.get("kind").and_then(Value::as_str) else {
        errors.push(format!("{path}: missing string \"kind\""));
        return;
    };
    let Some(spec) = nodes.get(kind) else {
        errors.push(format!("{path}: unknown kind \"{kind}\""));
        return;
    };

    let fields: Vec<&str> = spec
        .get("fields")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for key in obj.keys() {
        if key != "kind" && !fields.contains(&key.as_str()) {
            errors.push(format!("{path}: unknown field \"{key}\" for kind \"{kind}\""));
        }
    }

    if let Some(req) = spec.get("required").and_then(Value::as_array) {
        for r in req.iter().filter_map(Value::as_str) {
            if obj.get(r).is_none_or(Value::is_null) {
                errors.push(format!("{path}: missing required field \"{r}\" for kind \"{kind}\""));
            }
        }
    }

    if let Some(enums) = spec.get("enums").and_then(Value::as_object) {
        for (field, values) in enums {
            let Some(v) = obj.get(field).filter(|v| !v.is_null()) else { continue };
            let allowed: Vec<&str> = values
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let shown = v.as_str().map_or_else(|| v.to_string(), String::from);
            if !allowed.contains(&shown.as_str()) {
                errors.push(format!("{path}.{field}: \"{shown}\" not one of {}", allowed.join(", ")));
            }
        }
    }

    // Recurse nested nodes: any field value that is itself a node, or an array of nodes.
    for (field, value) in obj {
        if field == "kind" {
            continue;
        }
        if let Some(arr) = value.as_array() {
            for (i, child) in arr.iter().enumerate() {
                if child.is_object() && child.get("kind").is_some() {
                    walk(child, &format!("{path}.{field}[{i}]"), nodes, errors);
                }
            }
        } else if value.is_object() && value.get("kind").is_some() {
            walk(value, &format!("{path}.{field}"), nodes, errors);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn contract_is_valid() {
        let c = contract();
        assert!(c.get("nodes").and_then(Value::as_object).is_some(), "contract has a nodes map");
        // Every required/enum field a node names must be one of its allowed fields.
        for (kind, spec) in c["nodes"].as_object().unwrap() {
            let fields: Vec<&str> =
                spec["fields"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
            if let Some(req) = spec.get("required").and_then(Value::as_array) {
                for r in req.iter().filter_map(Value::as_str) {
                    assert!(fields.contains(&r), "{kind}.required {r} is an allowed field");
                }
            }
            if let Some(enums) = spec.get("enums").and_then(Value::as_object) {
                for f in enums.keys() {
                    assert!(fields.contains(&f.as_str()), "{kind}.enums {f} is an allowed field");
                }
            }
        }
    }

    #[test]
    fn accepts_the_demo_spec() {
        // The same LLM-provider card the frontend demoSpec renders — validates clean here too.
        let demo = json!({
            "kind": "card", "tone": "var(--accent)",
            "header": { "kind": "header", "title": "LLM provider", "hint": "API-tier" },
            "children": [
                { "kind": "field", "control": "select", "label": "Provider", "bind": "provider", "options": ["anthropic", "openai"] },
                { "kind": "field", "control": "password", "label": "API key", "bind": "apiKey" },
                { "kind": "row", "label": "Stream responses", "children": [{ "kind": "toggle", "bind": "stream" }] },
                { "kind": "button", "variant": "primary", "label": "Save", "action": "save" }
            ]
        });
        assert_eq!(validate_spec(&demo), Vec::<String>::new());
    }

    #[test]
    fn rejects_non_object() {
        assert_eq!(validate_spec(&json!(42)), vec!["$: expected a node object"]);
    }

    #[test]
    fn rejects_missing_and_unknown_kind() {
        assert_eq!(validate_spec(&json!({ "title": "x" })), vec!["$: missing string \"kind\""]);
        assert_eq!(validate_spec(&json!({ "kind": "widget" })), vec!["$: unknown kind \"widget\""]);
    }

    #[test]
    fn reports_missing_required_field() {
        assert_eq!(
            validate_spec(&json!({ "kind": "field", "control": "text" })),
            vec!["$: missing required field \"label\" for kind \"field\""]
        );
    }

    #[test]
    fn reports_unknown_field() {
        assert_eq!(
            validate_spec(&json!({ "kind": "tag", "label": "x", "bogus": 1 })),
            vec!["$: unknown field \"bogus\" for kind \"tag\""]
        );
    }

    #[test]
    fn reports_bad_enum() {
        let errs = validate_spec(&json!({ "kind": "field", "control": "radio", "label": "x" }));
        assert!(errs.contains(&"$.control: \"radio\" not one of text, password, select".to_string()));
    }

    #[test]
    fn recurses_into_children_and_header() {
        assert_eq!(
            validate_spec(&json!({ "kind": "card", "children": [{ "kind": "button" }] })),
            vec!["$.children[0]: missing required field \"label\" for kind \"button\""]
        );
        assert_eq!(
            validate_spec(&json!({ "kind": "card", "header": { "kind": "header" }, "children": [] })),
            vec!["$.header: missing required field \"title\" for kind \"header\""]
        );
    }
}
