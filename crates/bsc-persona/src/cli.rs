//! The `bsc persona` subcommand (#2094) — the persona-specific shim over the shared
//! verbatim-JSON-per-id store CLI ([`bsc_json_store::cli`], #2158). The persona library
//! (`~/.base-studio-code/personas/<id>.json`) is list/get/set/remove-able from a session's own shell
//! — the same store the desktop Personas library reads/writes and the planner can author into (mint a
//! persona like it mints a skill).
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc persona help          # compact menu
//!   bsc persona get help      # detailed help for ONE command
//!
//! The store is located via `--dir <path>` or the `BSC_PERSONA_DIR` env var, defaulting to
//! `~/.base-studio-code/personas/`.

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the user persona store — list/get/set/remove ~/.base-studio-code/personas (#2094)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every persona's {id, name, role} (JSON)",
        usage: "\
USAGE:
  bsc persona list [--full] [--pretty]

Prints every persona's { id, name, role } as JSON (compact; --pretty for indented). --full emits the
COMPLETE persona objects (role + startPrompt + skills + model + …) as a plain array — the
full-fidelity read the desktop library hydration needs.",
    },
    CmdDoc {
        name: "get",
        summary: "print one persona (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc persona get <id> [--pretty]

Prints the stored persona JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from persona JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc persona set [--pretty]   # persona JSON (one object or an array) on stdin

Upserts each persona by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written. Use this to author or update a persona from a session (the planner mints personas this way).",
    },
    CmdDoc {
        name: "rename",
        summary: "rename a persona in place — just the `name` field",
        usage: "\
USAGE:
  bsc persona rename <id> \"<new name>\"

Sets one persona's display NAME and leaves every other field byte-identical. Prints the stored
persona.

This exists because `set` is a whole-record verbatim upsert: renaming through it means reading the
record, hand-copying it somewhere, editing one field and writing the whole thing back — and anything
dropped in that round trip is silently lost (the start prompt and the skill list are the expensive
things to lose). A restricted session cannot pipe or redirect either, so that round trip has to go
through a staged file. One verb removes all of it.

The id is NOT changed — it is the identity every reference uses. Renaming is display-only, exactly as
it is for a project.

An architect persona's name is what the Glance architect node is labelled with, so this is how an
architect names itself or another one.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a persona (no-op if absent)",
        usage: "\
USAGE:
  bsc persona remove <id> [--pretty]

Deletes the persona keyed by <id>. A no-op (not an error) when it does not exist.",
    },
];

/// The persona store's concrete knobs over the shared CLI (#2158): its noun, env var, dir segment,
/// help catalog, and the `{id, name, role}` lean-`list` projection.
const SPEC: CliSpec = CliSpec {
    noun: "persona",
    dir_env: "BSC_PERSONA_DIR",
    dir_segment: "personas",
    tagline: TAGLINE,
    commands: COMMANDS,
    meta_fields: &["id", "name", "role"],
    graph_fields: &[],
    field_aliases: &[],
};

/// The `persona` subcommand entrypoint: `args` is everything after `bsc persona`; `prog` is the
/// display name for help/errors. Delegates to the shared dispatch with the persona [`SPEC`].
///
/// `rename` is intercepted BEFORE delegating: it is persona-specific (the shared store CLI knows
/// nothing about a `name` field) and the scaffold would reject it as an unknown command. `help` still
/// lists it, because the catalog above is what the shared help renders.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("rename") && args.get(1).map(String::as_str) != Some("help") {
        return rename(&args, prog);
    }
    // The narrow-only floor clamp rides the shared runner's write-time batch gate (#2928), so the
    // check happens BEFORE any write and a bad batch is rejected whole — the same contract
    // `bsc plan add` states. It is a CLOSURE rather than a plain fn because resolving a persona's
    // ancestor means reading the store, and the store dir is whatever `--dir`/env/default resolves
    // to for THIS invocation; a fn pointer could not see it and would silently clamp against the
    // default store while writing to another.
    let dir = store_dir(&args, prog)?;
    let validate = |items: &[serde_json::Value]| validate_floor_batch(items, &dir, prog);
    bsc_json_store::cli::run_hooked_validated(args, prog, &SPEC, None, Some(&validate))
}

/// Resolve the store dir exactly as the shared scaffold does (`--dir` > env > default), so the clamp
/// reads ancestors from the same store the write lands in.
fn store_dir(args: &[String], prog: &str) -> Result<std::path::PathBuf, String> {
    let dir_flag = args.iter().position(|a| a == "--dir").and_then(|i| args.get(i + 1)).cloned();
    bsc_cli_util::resolve_store_path(&dir_flag, SPEC.dir_env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(SPEC.dir_segment))
            .ok_or_else(|| format!("{prog}: could not resolve the persona store; set HOME/USERPROFILE or pass --dir"))
    })
}

/// The write-time floor gate: no persona in the batch may end up with a floor WIDER than the one it
/// derives from. See `floor.rs` for why this is the boundary and the architect restriction is only a
/// policy on top of it.
///
/// The ancestor is, in order: the persona's own stored floor (editing something that exists can only
/// tighten it), else the floor of the persona named by `derivesFrom`, else the closed floor (a new
/// persona with no stated lineage gets nothing). An item with NO `floor` key is untouched — the
/// behavioural fields stay a free-form passthrough, which is what keeps a persona cheap to author.
fn validate_floor_batch(items: &[serde_json::Value], dir: &std::path::Path, prog: &str) -> Result<(), String> {
    let store = bsc_json_store::Store::new(dir.to_path_buf(), SPEC.noun);

    // Personas written earlier in the SAME batch are visible as ancestors, so a batch that creates a
    // parent and a child derived from it succeeds in one call rather than requiring two.
    let mut pending: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();

    for item in items {
        let id = item.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().trim().to_string();
        let Some(want) = item.get("floor") else {
            continue; // no floor stated ⇒ nothing to clamp; behavioural fields pass through untouched
        };

        let derives = item.get("derivesFrom").and_then(serde_json::Value::as_str).map(str::trim).filter(|s| !s.is_empty());

        // The ancestor chain, in order. The PACKAGED floor sits between "already stored" and
        // "derives from", and it is the link that makes seeding possible at all: without it a store
        // where nothing has a floor yet refuses every write, because every branch falls through to
        // the closed floor. See `packaged.rs` — that was a real merged bug, found by the live CLI
        // check and invisible to unit tests that seed their ancestor with `store.set()`.
        let ancestor = match stored_floor(&store, &id, &pending)? {
            Some(own) => own,
            None => match crate::packaged::packaged_floor(&id) {
                Some(shipped) => shipped,
                None => match derives {
                    Some(parent) => stored_floor(&store, parent, &pending)?
                        .or_else(|| crate::packaged::packaged_floor(parent))
                        .ok_or_else(|| {
                            format!("{prog} set: persona '{id}' derivesFrom '{parent}', which is neither in the store nor packaged — a floor can only narrow one that exists")
                        })?,
                    None => crate::floor::closed_floor(),
                },
            },
        };

        let widened = crate::floor::widenings(want, &ancestor);
        if !widened.is_empty() {
            let anchor = match (
                stored_floor(&store, &id, &pending)?.is_some(),
                crate::packaged::packaged_floor(&id).is_some(),
                derives,
            ) {
                (true, _, _) => "its own stored floor".to_string(),
                (false, true, _) => format!("the PACKAGED floor for '{id}'"),
                (false, false, Some(p)) => format!("'{p}' (derivesFrom)"),
                (false, false, None) => "the closed floor — a new persona with no derivesFrom starts at none".to_string(),
            };
            return Err(format!(
                "{prog} set: persona '{id}' would WIDEN its permission floor beyond {anchor}. A floor may only ever narrow.
  {}",
                widened.join("
  "),
            ));
        }
        if !id.is_empty() {
            pending.insert(id, want.clone());
        }
    }
    Ok(())
}

/// One persona's stored floor — from this batch first (so a parent written moments ago counts), then
/// the store. A record that is absent, unparseable, or carries no `floor` yields `None`.
fn stored_floor(
    store: &bsc_json_store::Store,
    id: &str,
    pending: &std::collections::HashMap<String, serde_json::Value>,
) -> Result<Option<serde_json::Value>, String> {
    if id.is_empty() {
        return Ok(None);
    }
    if let Some(v) = pending.get(id) {
        return Ok(Some(v.clone()));
    }
    let Some(raw) = store.get(id)? else { return Ok(None) };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // An unreadable stored record must NOT read as "no ancestor" — that would silently downgrade
        // to the closed floor and turn a corrupt record into a way to refuse every narrowing. It is
        // still not a way to WIDEN, which is the property that matters.
        Err(_) => return Ok(None),
    };
    Ok(v.get("floor").cloned())
}

/// `rename <id> "<name>"` — set one persona's display name, leaving every other field untouched.
///
/// Read-modify-write over the STORED json rather than a re-serialized model: the persona record is
/// held verbatim (that is the whole contract of this store), and round-tripping it through a typed
/// struct here would quietly drop any field this crate does not know about — which is exactly the data
/// loss the verb exists to prevent.
fn rename(args: &[String], prog: &str) -> Result<(), String> {
    // The store dir resolves exactly as the shared scaffold resolves it (`--dir` > env > default), so
    // a rename lands in the same store every other verb reads.
    let dir_flag = args.iter().position(|a| a == "--dir").and_then(|i| args.get(i + 1)).cloned();
    let positional: Vec<&String> = {
        let mut out = Vec::new();
        let mut skip = false;
        for (i, a) in args.iter().enumerate() {
            if skip { skip = false; continue }
            if a == "--dir" { skip = true; continue }
            if a.starts_with("--") || i == 0 { continue }
            out.push(a);
        }
        out
    };
    let id = positional.first().ok_or_else(|| format!("usage: {prog} rename <id> \"<new name>\""))?;
    let name = positional
        .get(1)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("usage: {prog} rename <id> \"<new name>\" (a name cannot be empty)"))?;

    let dir = bsc_cli_util::resolve_store_path(&dir_flag, SPEC.dir_env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(SPEC.dir_segment))
            .ok_or_else(|| "rename: could not resolve the persona store; set HOME/USERPROFILE or pass --dir".to_string())
    })?;
    let store = bsc_json_store::Store::new(dir, SPEC.noun);

    let raw = store
        .get(id)?
        .ok_or_else(|| format!("{prog} rename: no persona '{id}' (list them with `{prog} list`)"))?;
    let mut v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("{prog} rename: persona '{id}' is not valid JSON: {e}"))?;
    if !v.is_object() {
        return Err(format!("{prog} rename: persona '{id}' is not a JSON object"));
    }
    v["name"] = serde_json::Value::String(name.to_string());
    let out = serde_json::to_string(&v).map_err(|e| format!("{prog} rename: {e}"))?;
    store.set(id, &out)?;
    println!("{out}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_the_persona_store_with_role_in_the_lean_list() {
        assert_eq!(SPEC.noun, "persona");
        assert_eq!(SPEC.dir_env, "BSC_PERSONA_DIR");
        assert_eq!(SPEC.dir_segment, "personas");
        assert_eq!(SPEC.meta_fields, &["id", "name", "role"]);
    }

    /// A scratch persona store, wired through `--dir` so the test never touches the real one.
    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bsc-persona-rename-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── the narrow-only floor clamp (epic `the-persona-is-the-whole-agent`) ────────────────────────
    //
    // These drive `validate_floor_batch` against a real store rather than the pure `widenings`, because
    // the property that matters is END TO END: a widening payload must leave the store UNCHANGED. A
    // clamp that rejects but has already written half a batch is not a boundary.

    use bsc_json_store::Store;

    fn store_at(dir: &std::path::Path) -> Store {
        Store::new(dir.to_path_buf(), "persona")
    }

    /// Seed one persona whose floor is the ancestor every case below narrows from.
    fn seed_parent(dir: &std::path::Path) {
        store_at(dir)
            .set(
                "p-parent",
                r#"{"id":"p-parent","name":"Parent","role":"designer","floor":{"github":"none","git":"none","code":"none","net":"none","ui":"write","writeGlobs":["scratch/**"],"allow":["bsc ui"]}}"#,
            )
            .unwrap();
    }

    fn validate(dir: &std::path::Path, json: &str) -> Result<(), String> {
        let items: Vec<serde_json::Value> = serde_json::from_str(json)
            .map(|v: serde_json::Value| if v.is_array() { serde_json::from_value(v).unwrap() } else { vec![v] })
            .unwrap();
        validate_floor_batch(&items, dir, "bsc persona")
    }

    /// Seed a scratch PACKAGED tree, so the packaged-floor link in the ancestor chain is exercised
    /// against real files rather than mocked out.
    /// Serializes the `BSC_DATA_DIR` tests. `cargo nextest` forks a process per test and would not
    /// need this; `cargo test` threads them inside one binary, and a process-global env var set by
    /// one thread is read by another. Without the lock those tests fail under plain `cargo test` for
    /// a reason unrelated to what they assert — the exact confusion `ENV_LOCK` exists to prevent in
    /// the app crate.
    static PACKAGED_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Run `f` with NO packaged personas visible — the baseline every clamp test needs, so none of
    /// them silently inherits the dev checkout's real persona set or a sibling's scratch dir.
    fn isolated<T>(f: impl FnOnce() -> T) -> T {
        with_packaged_named("no-packaged-personas-here", "__none__", serde_json::json!({}), f)
    }

    fn with_packaged<T>(id: &str, floor: serde_json::Value, f: impl FnOnce() -> T) -> T {
        with_packaged_named(id, id, floor, f)
    }

    fn with_packaged_named<T>(tag: &str, id: &str, floor: serde_json::Value, f: impl FnOnce() -> T) -> T {
        let _guard = PACKAGED_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("bsc-persona-pkg-{}-{}", std::process::id(), tag));
        let dir = root.join("personas");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("some-name.json"),
            serde_json::json!({"id": id, "role": "designer", "floor": floor}).to_string(),
        )
        .unwrap();
        unsafe { std::env::set_var("BSC_DATA_DIR", &root) };
        let out = f();
        unsafe { std::env::remove_var("BSC_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&root);
        out
    }

    // ── the BOOTSTRAP, which the live CLI check found missing after this shipped ──────────────────
    //
    // Every other clamp test seeds its ancestor with `store.set()`, which BYPASSES the resolution
    // under test. Against a real empty store there was no ancestor anywhere, so the chain fell to the
    // closed floor and refused every write — "narrow-only" was really "no capability may ever be
    // written". These drive the seeding path itself.

    #[test]
    fn a_packaged_persona_can_be_seeded_into_an_empty_store_at_its_packaged_floor() {
        let dir = scratch("boot-seed");
        with_packaged("p-pkg", serde_json::json!({"ui": "write", "code": "none"}), || {
            validate(&dir, r#"{"id":"p-pkg","floor":{"ui":"write","code":"none"}}"#).unwrap();
        });
    }

    #[test]
    fn seeding_still_cannot_exceed_the_packaged_floor() {
        // The bootstrap must not become the hole. The ceiling is the SHIPPED floor, not the payload.
        let dir = scratch("boot-widen");
        with_packaged("p-pkg", serde_json::json!({"ui": "write", "code": "none"}), || {
            let err = validate(&dir, r#"{"id":"p-pkg","floor":{"ui":"write","code":"write"}}"#).unwrap_err();
            assert!(err.contains("PACKAGED floor"), "{err}");
            assert!(err.contains("code: 'write' exceeds 'none'"), "{err}");
        });
    }

    #[test]
    fn a_persona_that_is_not_packaged_still_fails_closed() {
        // The bootstrap is scoped to ids the app actually ships; an invented one gets nothing.
        let dir = scratch("boot-unknown");
        with_packaged("p-pkg", serde_json::json!({"ui": "write"}), || {
            let err = validate(&dir, r#"{"id":"p-invented","floor":{"ui":"write"}}"#).unwrap_err();
            assert!(err.contains("closed floor"), "{err}");
        });
    }

    #[test]
    fn derivesfrom_may_name_a_packaged_persona_that_was_never_stored() {
        // A user persona derived from a built-in the store has not seen yet — the common case on a
        // fresh install, and it would fail if `derivesFrom` only consulted the store.
        let dir = scratch("boot-derive");
        with_packaged("p-pkg", serde_json::json!({"ui": "write", "code": "none"}), || {
            validate(&dir, r#"{"id":"p-child","derivesFrom":"p-pkg","floor":{"ui":"read"}}"#).unwrap();
            let err = validate(&dir, r#"{"id":"p-child2","derivesFrom":"p-pkg","floor":{"code":"write"}}"#).unwrap_err();
            assert!(err.contains("code: 'write' exceeds 'none'"), "{err}");
        });
    }

    #[test]
    fn a_narrowing_write_is_accepted() {
        isolated(|| {
            let dir = scratch("floor-narrow");
            seed_parent(&dir);
            // ui write -> read, and the surface shrinks to nothing it did not already hold.
            validate(&dir, r#"{"id":"p-parent","floor":{"ui":"read","allow":["bsc ui"]}}"#).unwrap();
        });
    }

    #[test]
    fn a_widening_write_is_refused_and_names_the_axis() {
        isolated(|| {
            let dir = scratch("floor-widen");
            seed_parent(&dir);
            let err = validate(&dir, r#"{"id":"p-parent","floor":{"code":"write","allow":["bsc ui"]}}"#).unwrap_err();
            assert!(err.contains("would WIDEN"), "{err}");
            assert!(err.contains("code: 'write' exceeds 'none'"), "{err}");
        });
    }

    #[test]
    fn the_escalation_this_exists_to_stop_is_refused() {
        isolated(|| {
            // The exact shape from the module docs: take a confined persona and hand it the debugger's
            // capability. Every axis is named, so the error is a complete account rather than the first hit.
            let dir = scratch("floor-escalate");
            seed_parent(&dir);
            let err = validate(
                &dir,
                r#"{"id":"p-parent","floor":{"github":"write","git":"write","code":"write","net":"read","ui":"write","allow":["bsc ui"]}}"#,
            )
            .unwrap_err();
            for axis in ["github", "git", "code", "net"] {
                assert!(err.contains(&format!("{axis}: ")), "{axis} missing from: {err}");
            }
        });
    }

    #[test]
    fn a_new_persona_with_no_lineage_fails_closed() {
        isolated(|| {
            let dir = scratch("floor-noline");
            let err = validate(&dir, r#"{"id":"p-new","floor":{"code":"write"}}"#).unwrap_err();
            assert!(err.contains("closed floor"), "{err}");
            // …and one that asks for nothing is fine, so fail-closed is not fail-always.
            validate(&dir, r#"{"id":"p-new","floor":{"code":"none"}}"#).unwrap();
        });
    }

    #[test]
    fn a_new_persona_narrows_from_the_ancestor_it_names() {
        isolated(|| {
            let dir = scratch("floor-derive");
            seed_parent(&dir);
            validate(&dir, r#"{"id":"p-child","derivesFrom":"p-parent","floor":{"ui":"read","allow":["bsc ui"]}}"#).unwrap();

            let err = validate(&dir, r#"{"id":"p-child","derivesFrom":"p-parent","floor":{"git":"write","allow":["bsc ui"]}}"#).unwrap_err();
            assert!(err.contains("(derivesFrom)"), "{err}");
        });
    }

    #[test]
    fn derivesfrom_naming_a_persona_that_does_not_exist_is_an_error_not_a_free_pass() {
        isolated(|| {
            let dir = scratch("floor-ghost");
            let err = validate(&dir, r#"{"id":"p-x","derivesFrom":"p-ghost","floor":{"code":"write"}}"#).unwrap_err();
            assert!(err.contains("neither in the store nor packaged"), "{err}");
        });
    }

    #[test]
    fn a_parent_and_its_child_land_in_one_batch() {
        isolated(|| {
            // Without in-batch visibility this would need two calls, and the natural workaround — write
            // the child first — would silently fall through to the closed floor.
            let dir = scratch("floor-batch");
            seed_parent(&dir);
            validate(
                &dir,
                r#"[{"id":"p-a","derivesFrom":"p-parent","floor":{"ui":"read","allow":["bsc ui"]}},
                    {"id":"p-b","derivesFrom":"p-a","floor":{"ui":"read","allow":["bsc ui"]}}]"#,
            )
            .unwrap();
        });
    }

    #[test]
    fn a_bad_item_rejects_the_whole_batch_before_anything_is_written() {
        isolated(|| {
            let dir = scratch("floor-atomic");
            seed_parent(&dir);
            let before = store_at(&dir).get("p-parent").unwrap();

            // Item 1 is a legitimate narrowing; item 2 widens. Nothing may land.
            let items: Vec<serde_json::Value> = serde_json::from_str(
                r#"[{"id":"p-parent","floor":{"ui":"read","allow":["bsc ui"]}},
                    {"id":"p-parent","floor":{"github":"write","allow":["bsc ui"]}}]"#,
            )
            .unwrap();
            assert!(validate_floor_batch(&items, &dir, "bsc persona").is_err());
            assert_eq!(store_at(&dir).get("p-parent").unwrap(), before, "the store was mutated by a rejected batch");
        });
    }

    #[test]
    fn a_persona_with_no_floor_passes_through_untouched() {
        isolated(|| {
            // The behavioural half stays a free-form passthrough — that is what keeps a persona cheap to
            // author, and the clamp must not start policing prose.
            let dir = scratch("floor-passthru");
            seed_parent(&dir);
            validate(&dir, r#"{"id":"p-parent","name":"Renamed","unknownFutureField":42}"#).unwrap();
        });
    }

    /// `rename` (#architects-own-projects) — the verb an architect names itself with.
    #[test]
    fn rename_sets_the_name_and_leaves_every_other_field_byte_identical() {
        let dir = scratch("keeps");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        // A record carrying fields this crate has no typed model for — the ones a whole-record
        // round-trip is most likely to drop.
        store
            .set(
                "persona-architect",
                r#"{"id":"persona-architect","name":"Team architect","role":"architect","startPrompt":"long prose","skills":["a","b"],"model":"claude-opus-5","unknownFutureField":42}"#,
            )
            .unwrap();

        run(vec!["rename".into(), "persona-architect".into(), "Networking architect".into(), "--dir".into(), dir.to_string_lossy().into_owned()], "bsc persona").unwrap();

        let v: serde_json::Value = serde_json::from_str(&store.get("persona-architect").unwrap().unwrap()).unwrap();
        assert_eq!(v["name"], "Networking architect");
        // The id is identity and never moves; everything else survives verbatim.
        assert_eq!(v["id"], "persona-architect");
        assert_eq!(v["role"], "architect");
        assert_eq!(v["startPrompt"], "long prose");
        assert_eq!(v["skills"], serde_json::json!(["a", "b"]));
        assert_eq!(v["model"], "claude-opus-5");
        assert_eq!(v["unknownFutureField"], 42, "a field this crate has no model for must survive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_refuses_an_unknown_id_and_an_empty_name() {
        let dir = scratch("refuse");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store.set("p1", r#"{"id":"p1","name":"One","role":"architect"}"#).unwrap();
        let d = || dir.to_string_lossy().into_owned();

        // An unknown id is an error, not a create — `set` is the verb that creates.
        let err = run(vec!["rename".into(), "ghost".into(), "Nope".into(), "--dir".into(), d()], "bsc persona").unwrap_err();
        assert!(err.contains("ghost"), "{err}");
        // A blank name would leave the node labelled by its raw id, which reads as a bug.
        for name in ["", "   "] {
            let err = run(vec!["rename".into(), "p1".into(), name.into(), "--dir".into(), d()], "bsc persona").unwrap_err();
            assert!(err.contains("usage:"), "{err}");
        }
        // …and a missing name argument entirely.
        assert!(run(vec!["rename".into(), "p1".into(), "--dir".into(), d()], "bsc persona").is_err());
        // Nothing was written by any refusal.
        assert_eq!(serde_json::from_str::<serde_json::Value>(&store.get("p1").unwrap().unwrap()).unwrap()["name"], "One");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_help_still_routes_to_help_rather_than_renaming() {
        // `rename help` must print help, not try to rename a persona called "help".
        let dir = scratch("help");
        run(vec!["rename".into(), "help".into(), "--dir".into(), dir.to_string_lossy().into_owned()], "bsc persona").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc persona", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc persona", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc persona set"));
        assert!(one.contains("stdin"));
        assert!(bsc_cli_util::help_for("bsc persona", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
