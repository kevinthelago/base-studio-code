//! Tests for the record-backed command surface (#spike-load-the-json-store-cli-spec-from-a-record).
//!
//! Weighted toward the FALLBACK path rather than the happy one. A surface that loads correctly
//! announces itself the moment you run a verb; a surface that silently reverts to the compiled spec
//! looks exactly like one that was never written — and that is the failure that costs an hour.

use crate::cli::CliSpec;
use crate::surface::{resolve_spec, spec_from_json, spec_to_json};
use bsc_cli_util::CmdDoc;

const COMMANDS: &[CmdDoc] = &[
    CmdDoc { name: "list", summary: "every record", usage: "bsc thing list" },
    CmdDoc { name: "get", summary: "one record", usage: "bsc thing get <id>" },
];

const SPEC: CliSpec = CliSpec {
    noun: "thing",
    dir_env: "BSC_THING_DIR",
    dir_segment: "things",
    tagline: "the thing store",
    commands: COMMANDS,
    meta_fields: &["id", "name"],
    graph_fields: &["id", "kind"],
    field_aliases: &[("folder", "group")],
};

/// A compiled spec must survive a trip through the record format unchanged. This is what makes the
/// record EDITABLE — you dump the real surface, change one line, and the rest is guaranteed to come
/// back identical rather than subtly lossy.
#[test]
fn a_spec_round_trips_through_the_record_format() {
    let back = spec_from_json(&spec_to_json(&SPEC)).expect("the dumped spec must parse");
    assert_eq!(back.noun, SPEC.noun);
    assert_eq!(back.dir_env, SPEC.dir_env);
    assert_eq!(back.dir_segment, SPEC.dir_segment);
    assert_eq!(back.tagline, SPEC.tagline);
    assert_eq!(back.meta_fields, SPEC.meta_fields);
    assert_eq!(back.graph_fields, SPEC.graph_fields);
    assert_eq!(back.field_aliases, SPEC.field_aliases);
    assert_eq!(back.commands.len(), SPEC.commands.len());
    for (a, b) in back.commands.iter().zip(SPEC.commands) {
        assert_eq!((a.name, a.summary, a.usage), (b.name, b.summary, b.usage));
    }
}

/// The point of the whole spike: a verb's surface changes by EDITING THE RECORD, with no rebuild.
#[test]
fn editing_the_record_changes_the_surface() {
    let mut v = spec_to_json(&SPEC);
    v["tagline"] = serde_json::json!("the thing store, reworded without a compiler");
    v["meta_fields"] = serde_json::json!(["id", "name", "owner"]);
    v["commands"].as_array_mut().unwrap().push(serde_json::json!({
        "name": "remove", "summary": "delete by id", "usage": "bsc thing remove <id>",
    }));

    let spec = spec_from_json(&v).expect("an edited record must parse");
    assert_eq!(spec.tagline, "the thing store, reworded without a compiler");
    assert_eq!(spec.meta_fields, &["id", "name", "owner"]);
    assert_eq!(spec.commands.len(), 3);
    assert_eq!(spec.commands[2].name, "remove");
}

/// Every shape error must NAME its field. A record rejected with "invalid" tells the author nothing,
/// and the fallback means they will not see a crash to investigate either.
#[test]
fn a_malformed_record_is_rejected_with_the_field_named() {
    let cases: &[(serde_json::Value, &str)] = &[
        (serde_json::json!({}), "noun"),
        (serde_json::json!({ "noun": "t", "dir_env": "E", "dir_segment": "s", "tagline": "t" }), "commands"),
        (
            serde_json::json!({
                "noun": "t", "dir_env": "E", "dir_segment": "s", "tagline": "t",
                "commands": [{ "name": "list", "summary": "s" }],
            }),
            "usage",
        ),
        (
            serde_json::json!({
                "noun": "t", "dir_env": "E", "dir_segment": "s", "tagline": "t",
                "commands": [{ "name": "list", "summary": "s", "usage": "u" }],
                "meta_fields": [1, 2],
            }),
            "meta_fields",
        ),
        (
            serde_json::json!({
                "noun": "t", "dir_env": "E", "dir_segment": "s", "tagline": "t",
                "commands": [{ "name": "list", "summary": "s", "usage": "u" }],
                "field_aliases": [["only-one"]],
            }),
            "field_aliases",
        ),
    ];
    for (v, expect) in cases {
        let err = spec_from_json(v).expect_err("a malformed record must be rejected");
        assert!(err.contains(expect), "error must name `{expect}`, got: {err}");
    }
}

/// An EMPTY command list parses as valid JSON and would replace a working surface with one that
/// dispatches nothing — present, plausible, and useless. Rejected explicitly.
#[test]
fn a_surface_with_no_verbs_is_refused_rather_than_installed() {
    let v = serde_json::json!({
        "noun": "t", "dir_env": "E", "dir_segment": "s", "tagline": "t", "commands": [],
    });
    let err = spec_from_json(&v).expect_err("an empty surface must be refused");
    assert!(err.contains("empty"), "the reason must say so: {err}");
}

/// The three outcomes of resolution, in one place because they share the env var.
///
/// The middle one is the reason this test exists: a record that is present and broken must fall back
/// to the compiled spec AND say so, never take the surface down and never revert in silence.
#[test]
fn resolution_falls_back_to_the_compiled_spec_and_never_panics() {
    let dir = std::env::temp_dir().join(format!("bsc-surface-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("BSC_SURFACE_DIR", &dir);

    // 1. No record at all — the normal case for every store today. Compiled, silently.
    assert_eq!(resolve_spec(&SPEC).tagline, SPEC.tagline);

    // 2. A valid record — it wins.
    let mut v = spec_to_json(&SPEC);
    v["tagline"] = serde_json::json!("from the record");
    std::fs::write(dir.join("thing.json"), v.to_string()).unwrap();
    assert_eq!(resolve_spec(&SPEC).tagline, "from the record");

    // 3. Present but broken — compiled, and the caller keeps working.
    std::fs::write(dir.join("thing.json"), "{ not json at all").unwrap();
    assert_eq!(resolve_spec(&SPEC).tagline, SPEC.tagline, "a broken record must not take the surface down");

    // ...including structurally-valid JSON that is not a spec.
    std::fs::write(dir.join("thing.json"), r#"{"noun":"thing"}"#).unwrap();
    assert_eq!(resolve_spec(&SPEC).tagline, SPEC.tagline);

    std::env::remove_var("BSC_SURFACE_DIR");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The boundary the spike found: the SURFACE is data, the OPERATIONS are code.
///
/// Adding a `count` verb by record edit put it in `bsc persona help` while `bsc persona count` answered
/// `unknown command 'count'` — a help catalog promising something dispatch cannot deliver, which is
/// worse than not having the feature, because a help catalog is what an agent reads to decide what it
/// may call.
#[test]
fn a_verb_with_no_implementation_is_refused_rather_than_advertised() {
    let mut v = spec_to_json(&SPEC);
    v["commands"].as_array_mut().unwrap().push(serde_json::json!({
        "name": "count", "summary": "how many", "usage": "bsc thing count",
    }));
    let err = spec_from_json(&v).expect_err("an undispatchable verb must be refused");
    assert!(err.contains("count"), "the error must name the offending verb: {err}");
    assert!(err.contains("no implementation"), "and say why: {err}");

    // The verbs that DO dispatch are accepted, including a wrapper-intercepted one (`bsc persona
    // rename` is handled by the wrapper crate before it ever reaches this runner).
    for name in ["list", "get", "set", "remove", "help", "rename"] {
        let mut ok = spec_to_json(&SPEC);
        ok["commands"] = serde_json::json!([{ "name": name, "summary": "s", "usage": "u" }]);
        assert!(spec_from_json(&ok).is_ok(), "`{name}` must be accepted");
    }
}
