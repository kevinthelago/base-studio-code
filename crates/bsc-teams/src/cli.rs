//! The `bsc teams` subcommand (#2193, renamed from `bsc org` in #2700 — `bsc org` remains a deprecated
//! alias) — the teams-specific shim over the shared verbatim-JSON-per-id store CLI
//! ([`bsc_json_store::cli`], #2158). The teams library (`~/.base-studio-code/orgs/<id>.json`) is
//! list/get/set/remove-able from a session's own shell — the same store the desktop Team designer
//! reads/writes and the planner can compose into (wire a fleet's positions + relationships).
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc teams help          # compact menu
//!   bsc teams get help      # detailed help for ONE command
//!
//! The store is located via `--dir <path>` or the `BSC_ORG_DIR` env var, defaulting to
//! `~/.base-studio-code/orgs/` — both KEPT unchanged (a rename would orphan existing saved data, #2700).

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the user teams store — list/get/set/remove ~/.base-studio-code/orgs (#2193/#2700)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every team's {id, name} (JSON)",
        usage: "\
USAGE:
  bsc teams list [--full] [--pretty]

Prints every team's { id, name } as JSON (compact; --pretty for indented). --full emits the COMPLETE
team objects (positions + relationships + …) as a plain array — the full-fidelity read the desktop
Team-designer hydration needs.",
    },
    CmdDoc {
        name: "get",
        summary: "print one team (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc teams get <id> [--pretty]

Prints the stored team JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from team JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc teams set [--pretty]   # team JSON (one object or an array) on stdin

Upserts each team by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written. Use this to author or update a team from a session (the planner composes a fleet this way).",
    },
    CmdDoc {
        name: "model",
        summary: "set (or clear) the LLM tier ONE placement launches on",
        usage: "\
USAGE:
  bsc teams model <team-id> <node-id> <tier>    # haiku-4.5 | sonnet-4.5 | opus-4.5
  bsc teams model <team-id> <node-id> --clear   # back to the persona's own default

Sets the model on one agent POSITION and leaves the rest of the team byte-identical. Prints the
stored team. At fleet launch that tier wins over the persona's default, so the same persona can run
opus in one team and haiku in another WITHOUT cloning it — cloning would fork the start prompt and
the skill list, which were the reason to share the persona in the first place.

The precedence, nearest first: a fleet stream's own model > this placement's > the persona's default >
Claude Code's own default (no `--model` at all).

  --clear   remove the override; the placement falls back to the persona's model

Refused, rather than silently stored: an unknown tier (the error names the ones that exist), an
unknown team or node id, and a node that is not an `agent` — an external actor or a resource never
launches a session, so a model on one would look set and do nothing.

Use `bsc persona model` instead to move a persona's default everywhere it is placed.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a team (no-op if absent)",
        usage: "\
USAGE:
  bsc teams remove <id> [--pretty]

Deletes the team keyed by <id>. A no-op (not an error) when it does not exist.",
    },
];

/// The teams store's concrete knobs over the shared CLI (#2158): its noun, env var, dir segment, help
/// catalog, and the `{id, name}` lean-`list` projection. NOTE (#2700): `noun`/`dir_env`/`dir_segment`
/// stay `org`/`BSC_ORG_DIR`/`orgs` — the on-disk store keeps its birth name so existing users' saved
/// data is not orphaned; only the crate + the `bsc teams` verb are renamed.
const SPEC: CliSpec = CliSpec {
    noun: "org",
    dir_env: "BSC_ORG_DIR",
    dir_segment: "orgs",
    tagline: TAGLINE,
    commands: COMMANDS,
    meta_fields: &["id", "name"],
    graph_fields: &[],
    field_aliases: &[],
};

/// The `teams` subcommand entrypoint: `args` is everything after `bsc teams` (or the deprecated
/// `bsc org`); `prog` is the display name for help/errors. Delegates to the shared dispatch with the
/// teams [`SPEC`].
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    // `model` is intercepted BEFORE delegating: it patches ONE position inside the team's own shape,
    // which the shared store CLI knows nothing about, and the scaffold would reject it as an unknown
    // command. `help` still lists it — the catalog above is what the shared help renders.
    if args.first().map(String::as_str) == Some("model") && args.get(1).map(String::as_str) != Some("help") {
        return set_model(&args, prog);
    }
    bsc_json_store::cli::run(args, prog, &SPEC)
}

/// `model <team> <node> <tier>` / `model <team> <node> --clear` — set (or remove) the model override
/// on ONE agent position, leaving the rest of the team untouched.
///
/// Read-modify-write over the STORED json rather than a re-serialized model: a team is held verbatim
/// (that is the whole contract of this store), and round-tripping it through a typed struct here
/// would quietly drop any field this crate has no model for — the canvas coordinates and the
/// relationship bows among them.
///
/// ## Why the override lives on the PLACEMENT
/// A persona carries a default model, and a persona is shared across teams by design. So making one
/// team cheap to test by editing its personas moves every other team that places them. The override
/// is per-placement for exactly that reason; the persona's default is untouched and still applies
/// everywhere it is not overridden.
///
/// ## What is refused
/// An unknown tier (validated against [`bsc_util::MODEL_TIERS`], the same table the launch maps
/// through), an unknown team or node, and a non-`agent` position. The last one matters: an `external`
/// actor or a `resource` never launches a session, so a model stored on one would read as configured
/// and do nothing at all.
fn set_model(args: &[String], prog: &str) -> Result<(), String> {
    let usage = format!(
        "usage: {prog} model <team-id> <node-id> <tier> | {prog} model <team-id> <node-id> --clear   (tiers: {})",
        bsc_util::model_id_list()
    );
    let mut clear = false;
    let mut dir_flag: Option<String> = None;
    let mut positional: Vec<&str> = Vec::new();
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--clear" => clear = true,
            "--dir" => dir_flag = Some(it.next().ok_or("--dir needs a value")?.clone()),
            "--pretty" | "--json" => {}
            other if other.starts_with("--") => return Err(format!("{prog} model: unknown flag {other}")),
            other => positional.push(other),
        }
    }
    let team_id = positional.first().copied().ok_or_else(|| usage.clone())?;
    let node_id = positional.get(1).copied().ok_or_else(|| usage.clone())?;
    let tier = positional.get(2).copied().map(str::trim).filter(|t| !t.is_empty());
    if clear && tier.is_some() {
        return Err(format!("{prog} model: --clear takes no tier — pass one or the other"));
    }
    if !clear && tier.is_none() {
        return Err(usage);
    }
    if let Some(t) = tier {
        if !bsc_util::is_model_id(t) {
            return Err(format!(
                "{prog} model: '{t}' is not a model tier. Pick one of: {}\n  \
                 (or `{prog} model {team_id} {node_id} --clear` to fall back to the persona's default)",
                bsc_util::model_id_list()
            ));
        }
    }

    let dir = bsc_cli_util::resolve_store_path(&dir_flag, SPEC.dir_env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(SPEC.dir_segment))
            .ok_or_else(|| format!("{prog} model: could not resolve the teams store; set HOME/USERPROFILE or pass --dir"))
    })?;
    let store = bsc_json_store::Store::new(dir, SPEC.noun);
    let raw = store
        .get(team_id)?
        .ok_or_else(|| format!("{prog} model: no team '{team_id}' (list them with `{prog} list`)"))?;
    let mut v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("{prog} model: team '{team_id}' is not valid JSON: {e}"))?;
    let positions = v
        .get_mut("positions")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| format!("{prog} model: team '{team_id}' has no positions array"))?;

    // The error names the agent nodes that DO exist — a nodeId is minted by the designer and is not
    // guessable from the team's name, so "no such node" without them is a dead end.
    let mut agents: Vec<String> = Vec::new();
    let mut found: Option<&mut serde_json::Value> = None;
    for p in positions.iter_mut() {
        let id = p.get("nodeId").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
        if p.get("kind").and_then(serde_json::Value::as_str) == Some("agent") {
            agents.push(id.clone());
        }
        if id == node_id {
            found = Some(p);
        }
    }
    let pos = found.ok_or_else(|| {
        format!(
            "{prog} model: team '{team_id}' has no position '{node_id}'. Its agent positions are: {}",
            if agents.is_empty() { "(none)".to_string() } else { agents.join(", ") }
        )
    })?;
    let kind = pos.get("kind").and_then(serde_json::Value::as_str).unwrap_or("");
    if kind != "agent" {
        return Err(format!(
            "{prog} model: '{node_id}' is a '{kind}' position, not an agent — it never launches a \
             session, so a model on it would look set and do nothing."
        ));
    }
    let obj = pos
        .as_object_mut()
        .ok_or_else(|| format!("{prog} model: position '{node_id}' is not a JSON object"))?;
    match tier {
        // Cleared by REMOVING the key, not by writing `""`: absence is what "no override" already
        // looks like for every placement that never set one, and an empty string would be a second
        // spelling of it that every reader would have to know about.
        None => { obj.remove("model"); }
        Some(t) => { obj.insert("model".into(), serde_json::Value::String(t.to_string())); }
    }
    let out = serde_json::to_string(&v).map_err(|e| format!("{prog} model: {e}"))?;
    store.set(team_id, &out)?;
    println!("{out}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_keeps_the_orgs_on_disk_store() {
        // #2700: the crate + verb are "teams", but the store dir + env stay "orgs"/"BSC_ORG_DIR" so a
        // rename never orphans existing users' saved data.
        assert_eq!(SPEC.noun, "org");
        assert_eq!(SPEC.dir_env, "BSC_ORG_DIR");
        assert_eq!(SPEC.dir_segment, "orgs");
        assert_eq!(SPEC.meta_fields, &["id", "name"]);
    }

    /// A scratch teams store, wired through `--dir` so a test never touches the real one.
    fn scratch(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "bsc-teams-model-{}-{}-{}",
            tag,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A team with one agent placement, one external actor, and the incidental fields a whole-record
    /// round trip is most likely to drop (canvas coordinates, a relationship bow).
    const TEAM: &str = r#"{"id":"squad","name":"Squad","positions":[{"nodeId":"eng-a","kind":"agent","personaId":"persona-worker","label":"Engineer A","x":40,"y":60},{"nodeId":"customer","kind":"external","label":"Customer"}],"relationships":[{"id":"r1","archetype":"manages","from":"eng-a","to":"customer","bow":12}]}"#;

    fn team_of(store: &bsc_json_store::Store) -> serde_json::Value {
        serde_json::from_str(&store.get("squad").unwrap().unwrap()).unwrap()
    }

    // ── `model` — the per-placement override (a-model-cannot-be-chosen-from-the-command-surface) ──

    /// The whole point of the verb: ONE position moves and nothing else in the team does — the canvas
    /// layout and the relationship bows included, which a read-edit-write through `set` would be
    /// carrying by hand.
    #[test]
    fn model_sets_one_placement_and_leaves_the_rest_of_the_team_byte_identical() {
        let dir = scratch("set");
        let store = bsc_json_store::Store::new(dir.clone(), SPEC.noun);
        store.set("squad", TEAM).unwrap();

        run(vec!["model".into(), "squad".into(), "eng-a".into(), "haiku-4.5".into(), "--dir".into(), dir.to_string_lossy().into_owned()], "bsc teams").unwrap();

        let v = team_of(&store);
        assert_eq!(v["positions"][0]["model"], "haiku-4.5");
        // The placement's own fields, and the team around it, are untouched.
        assert_eq!(v["positions"][0]["personaId"], "persona-worker");
        assert_eq!(v["positions"][0]["label"], "Engineer A");
        assert_eq!(v["positions"][0]["x"], 40);
        assert_eq!(v["positions"][1]["nodeId"], "customer");
        assert_eq!(v["relationships"][0]["bow"], 12);
        assert_eq!(v["name"], "Squad");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `--clear` REMOVES the key rather than writing `""` — absence is what "no override" already
    /// looks like for every placement that never set one, and the fallback downstream is `pos.model ||
    /// persona.model`, which an empty string would satisfy in the wrong direction if it were read
    /// anywhere as a value.
    #[test]
    fn model_clear_removes_the_override_rather_than_emptying_it() {
        let dir = scratch("clear");
        let store = bsc_json_store::Store::new(dir.clone(), SPEC.noun);
        store.set("squad", TEAM).unwrap();
        let d = || dir.to_string_lossy().into_owned();

        run(vec!["model".into(), "squad".into(), "eng-a".into(), "opus-4.5".into(), "--dir".into(), d()], "bsc teams").unwrap();
        run(vec!["model".into(), "squad".into(), "eng-a".into(), "--clear".into(), "--dir".into(), d()], "bsc teams").unwrap();

        let v = team_of(&store);
        assert!(v["positions"][0].get("model").is_none(), "cleared means ABSENT: {v}");
        assert_eq!(v["positions"][0]["personaId"], "persona-worker");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The refusals, and the property that matters about each: nothing is written.
    ///
    /// The non-agent case is the one worth stating. An `external` actor or a `resource` never launches
    /// a session, so a model stored on one would read as configured and do exactly nothing — the
    /// silent-no-op shape this repo keeps getting caught by.
    #[test]
    fn model_refuses_a_bad_tier_an_unknown_node_and_a_non_agent_position() {
        let dir = scratch("refuse");
        let store = bsc_json_store::Store::new(dir.clone(), SPEC.noun);
        store.set("squad", TEAM).unwrap();
        let d = || dir.to_string_lossy().into_owned();

        let err = run(vec!["model".into(), "squad".into(), "eng-a".into(), "haiku".into(), "--dir".into(), d()], "bsc teams").unwrap_err();
        assert!(err.contains("haiku"), "{err}");
        for tier in bsc_util::model_ids() {
            assert!(err.contains(tier), "the error names the tier {tier}: {err}");
        }

        // An unknown node names the agent positions that DO exist — a nodeId is minted by the designer
        // and is not guessable from the team's name.
        let err = run(vec!["model".into(), "squad".into(), "ghost".into(), "haiku-4.5".into(), "--dir".into(), d()], "bsc teams").unwrap_err();
        assert!(err.contains("ghost") && err.contains("eng-a"), "{err}");

        // A non-agent position is refused rather than silently stored.
        let err = run(vec!["model".into(), "squad".into(), "customer".into(), "haiku-4.5".into(), "--dir".into(), d()], "bsc teams").unwrap_err();
        assert!(err.contains("external"), "the error names what it IS: {err}");

        // An unknown team, and the two usage errors.
        assert!(run(vec!["model".into(), "nope".into(), "eng-a".into(), "haiku-4.5".into(), "--dir".into(), d()], "bsc teams").is_err());
        assert!(run(vec!["model".into(), "squad".into(), "eng-a".into(), "--dir".into(), d()], "bsc teams").is_err());
        assert!(run(vec!["model".into(), "squad".into(), "--dir".into(), d()], "bsc teams").is_err());
        assert!(run(vec!["model".into(), "squad".into(), "eng-a".into(), "haiku-4.5".into(), "--clear".into(), "--dir".into(), d()], "bsc teams").is_err());

        // Not one of those refusals wrote anything.
        assert_eq!(store.get("squad").unwrap().unwrap(), TEAM, "a refusal leaves the team byte-identical");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every tier the registry offers is settable on a placement, and each maps to a launch alias —
    /// the property that keeps this CLI and the harness in step.
    #[test]
    fn every_registry_tier_is_settable_on_a_placement() {
        let dir = scratch("all");
        let store = bsc_json_store::Store::new(dir.clone(), SPEC.noun);
        store.set("squad", TEAM).unwrap();
        for tier in bsc_util::model_ids() {
            run(vec!["model".into(), "squad".into(), "eng-a".into(), tier.into(), "--dir".into(), dir.to_string_lossy().into_owned()], "bsc teams").unwrap();
            assert_eq!(team_of(&store)["positions"][0]["model"], tier);
            assert!(bsc_util::model_alias(tier).is_some());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_help_still_routes_to_help_rather_than_a_team_called_help() {
        let dir = scratch("help");
        run(vec!["model".into(), "help".into(), "--dir".into(), dir.to_string_lossy().into_owned()], "bsc teams").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn teams_store_persists_to_sqlite_not_json_files() {
        // #2983 regression (epic #2982): the shared store backend moved JSON-files → SQLite. Prove the
        // teams store (segment `orgs`, per SPEC) now round-trips through a SQLite `orgs.db` and never
        // writes a legacy `orgs/<id>.json` file. Uses the public `bsc_json_store::Store` over the SAME
        // segment/noun the `bsc teams` CLI uses, rooted at a fresh temp base.
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let uniq = format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed));
        let base = std::env::temp_dir().join(format!("bsc-teams-sqlite-test-{uniq}"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let store = bsc_json_store::Store::new(base.join(SPEC.dir_segment), SPEC.noun);

        // Round-trip a team through the public store API (write → read back).
        let team = r#"{"id":"squad","name":"Squad","positions":[],"relationships":[]}"#;
        store.set("squad", team).unwrap();
        assert_eq!(
            store.get("squad").unwrap().as_deref(),
            Some(team),
            "the written team reads back verbatim",
        );

        // SQLite, not files: `<base>/orgs.db` EXISTS after the write, and NO `<base>/orgs/<id>.json`
        // (nor even the legacy `orgs/` dir) was created.
        let db = base.join(format!("{}.db", SPEC.dir_segment));
        assert!(db.exists(), "the SQLite db {} exists after a write", db.display());
        let legacy_json = base.join(SPEC.dir_segment).join("squad.json");
        assert!(
            !legacy_json.exists(),
            "no legacy JSON file was written ({})",
            legacy_json.display(),
        );

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(base.join(SPEC.dir_segment));
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc teams", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove", "model"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // The tier vocabulary is rendered INTO the help, so `bsc teams model help` answers "which
        // tiers" without a second lookup — and cannot name a tier the launch would not accept.
        let m = bsc_cli_util::help_for("bsc teams", TAGLINE, COMMANDS, "model");
        for tier in bsc_util::model_ids() {
            assert!(m.contains(tier), "the model help names {tier}");
        }
        let one = bsc_cli_util::help_for("bsc teams", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc teams set"));
        assert!(one.contains("stdin"));
        assert!(bsc_cli_util::help_for("bsc teams", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
