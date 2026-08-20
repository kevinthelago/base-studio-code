//! The `bsc mcp server` subcommand — the MCP server store's CRUD, plus persona assignment.
//!
//! NESTED UNDER `server` ON PURPOSE. `bsc mcp <name>` SPAWNS a bundled server and that form is
//! written into every `.mcp.json` the app has ever generated, so flattening `list`/`get`/`set` into
//! the same namespace would both collide with a server named `list` and break those files. The spawn
//! form is untouched; everything here hangs off `server`.
//!
//! The store is located via `--dir <path>` or `BSC_MCP_DIR`, defaulting to `~/.base-studio-code/mcp`.

use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;

const TAGLINE: &str = "the MCP server store — list/get/set/remove, and assign a server to a persona";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every server's {id, name, transport, enabled} (JSON)",
        usage: "\
USAGE:
  bsc mcp server list [--full] [--pretty]

Prints every stored server's { id, name, transport, enabled } as JSON. --full emits the COMPLETE
objects (command/args/url/env too) — the full-fidelity read the desktop hydration needs.

The BUNDLED servers (research · compliance · cve · channel-mock) are NOT in this store: they ship in
the app and are spawned as `bsc mcp <name>`. This lists what has been authored on top of them.",
    },
    CmdDoc {
        name: "get",
        summary: "print one server (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc mcp server get <id> [--pretty]

Prints the stored server JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from server JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc mcp server set [--pretty]   # server JSON (one object or an array) on stdin

Upserts each server by its (required, non-empty) \"id\" field, written verbatim.

  { \"id\": \"acme-crm\", \"name\": \"Acme CRM\", \"enabled\": true,
    \"transport\": \"stdio\", \"command\": \"acme-mcp\", \"args\": \"--read-only\",
    \"env\": [[\"ACME_TOKEN\", \"...\"]] }

`transport` is \"stdio\" (needs `command`) or \"http\" (needs `url`). A server reaches no session until
a persona carries it — see `assign`.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a server (no-op if absent)",
        usage: "\
USAGE:
  bsc mcp server remove <id>

Deletes the stored server. Personas that carried it are NOT rewritten: a dangling assignment is
visible (the panel renders it as unresolved) rather than silently erased from every carrier.",
    },
    CmdDoc {
        name: "assign",
        summary: "give a persona this server — the ONLY way one reaches a session",
        usage: "\
USAGE:
  bsc mcp server assign <server-id> --persona <persona-id>

Adds <server-id> to that persona's `mcp` list. Idempotent.

This is the whole scoping model: a server reaches a session because the session's persona carries
it. There is no project scoping and no per-pane override — those were three ways to answer one
question and they are gone.

The write lands on the PERSONA record, not on the server, so there is one owner of the assignment.",
    },
    CmdDoc {
        name: "unassign",
        summary: "take this server away from a persona",
        usage: "\
USAGE:
  bsc mcp server unassign <server-id> --persona <persona-id>

Removes <server-id> from that persona's `mcp` list. Idempotent — unassigning what was never assigned
succeeds and changes nothing.",
    },
];

/// The MCP store's concrete knobs over the shared CLI: its noun, env var, dir segment, help catalog,
/// and the lean-`list` projection.
const SPEC: CliSpec = CliSpec {
    noun: "mcp-server",
    dir_env: "BSC_MCP_DIR",
    dir_segment: "mcp",
    tagline: TAGLINE,
    commands: COMMANDS,
    meta_fields: &["id", "name", "transport", "enabled"],
    graph_fields: &[],
    field_aliases: &[],
};

/// The persona store's segment + env var. Assignment writes there, so this crate has to resolve it
/// the same way `bsc persona` does or the two would read different stores.
const PERSONA_ENV: &str = "BSC_PERSONA_DIR";
const PERSONA_SEGMENT: &str = "personas";

/// The `bsc mcp server` entrypoint: `args` is everything after `bsc mcp server`.
///
/// `assign`/`unassign` are intercepted BEFORE delegating, for the same reason `bsc persona rename`
/// is: they are domain verbs the shared store scaffold knows nothing about, and it would reject them
/// as unknown commands. `help` still lists them, because the catalog above is what it renders.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let verb = args.first().map(String::as_str).unwrap_or("");
    let is_help = args.get(1).map(String::as_str) == Some("help");
    if matches!(verb, "assign" | "unassign") && !is_help {
        return assign(&args, prog, verb == "assign");
    }
    bsc_json_store::cli::run(args, prog, &SPEC)
}

/// Resolve a store dir exactly as the shared scaffold does (`--dir` > env > default).
fn store_dir(
    args: &[String],
    prog: &str,
    env: &str,
    segment: &str,
    what: &str,
) -> Result<std::path::PathBuf, String> {
    // `--dir` targets the MCP store; the persona store has its own env/default and is never
    // redirected by it, so a `--dir` for one cannot silently move the other.
    let dir_flag = if env == SPEC.dir_env {
        args.iter().position(|a| a == "--dir").and_then(|i| args.get(i + 1)).cloned()
    } else {
        None
    };
    bsc_cli_util::resolve_store_path(&dir_flag, env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(segment))
            .ok_or_else(|| format!("{prog}: could not resolve the {what} store; set HOME/USERPROFILE or pass --dir"))
    })
}

/// One named flag's value (`--persona <id>`).
fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1))
}

/// `assign` / `unassign` — a read-modify-write of the PERSONA record's `mcp` list.
///
/// Both are idempotent, and both REFUSE an unknown persona rather than creating one: a typo that
/// silently minted an empty persona would be a new agent identity nobody asked for.
///
/// An unknown SERVER id is allowed on purpose. The bundled servers are not in this store, so
/// requiring the id to resolve here would make `assign channel-mock` impossible — and that is
/// precisely the assignment that replaces the old `channel-mock` special case.
///
/// Takes the STORE rather than resolving it, so the logic is testable without touching the
/// process-global environment. That is not hypothetical tidiness: the first version resolved the dir
/// from `BSC_PERSONA_DIR` inside the function, the tests set that var, and under `cargo test` (threads
/// in ONE process, unlike nextest) they raced — one test's writes landed in another's store.
fn assign_in(
    personas: &bsc_json_store::Store,
    server: &str,
    persona_id: &str,
    add: bool,
    prog: &str,
) -> Result<Vec<String>, String> {
    let raw = personas
        .get(persona_id)?
        .ok_or_else(|| format!("{prog}: no persona '{persona_id}' — `bsc persona list` shows the ids"))?;
    let mut obj: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("{prog}: persona '{persona_id}' is not valid JSON: {e}"))?;

    // Read the current list tolerantly: absent, null, or a non-array all mean "carries nothing yet",
    // because the persona record is a free-form passthrough and this field is new.
    let mut list: Vec<String> = obj
        .get("mcp")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    if add {
        list.push(server.to_string());
    } else {
        list.retain(|s| s != server);
    }
    // Deterministic order + no duplicates, so a re-assign is a no-op on the stored bytes and a diff
    // stays readable. `dedup` needs the sort to be adjacent-correct, hence this order.
    list.sort();
    list.dedup();

    obj.as_object_mut()
        .ok_or_else(|| format!("{prog}: persona '{persona_id}' is not a JSON object"))?
        .insert("mcp".into(), serde_json::json!(list));

    let out = serde_json::to_string(&obj).map_err(|e| format!("{prog}: {e}"))?;
    personas.set(persona_id, &out)?;
    Ok(list)
}

/// The CLI wrapper: parse the args, resolve the persona store, delegate to [`assign_in`].
fn assign(args: &[String], prog: &str, add: bool) -> Result<(), String> {
    let verb = if add { "assign" } else { "unassign" };
    let usage = format!("usage: {prog} {verb} <server-id> --persona <persona-id>");
    let server = args
        .get(1)
        .filter(|s| !s.starts_with("--"))
        .ok_or_else(|| usage.clone())?;
    let persona_id = flag(args, "--persona").ok_or(usage)?;

    let dir = store_dir(args, prog, PERSONA_ENV, PERSONA_SEGMENT, "persona")?;
    let personas = bsc_json_store::Store::new(dir, "persona");
    let list = assign_in(&personas, server, persona_id, add, prog)?;
    println!("{}", serde_json::json!({ "persona": persona_id, "mcp": list }));
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn uniq() -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    /// A temp persona store holding one persona. NO env var is touched: these run threaded under
    /// `cargo test`, and a process-global would have them writing into each other's stores.
    fn with_persona(json: &str) -> bsc_json_store::Store {
        let base = std::env::temp_dir().join(format!("bsc-mcp-assign-{}", uniq()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let store = bsc_json_store::Store::new(base.join("personas"), "persona");
        store.set("p1", json).unwrap();
        store
    }

    fn mcp_of(store: &bsc_json_store::Store, id: &str) -> Vec<String> {
        let raw = store.get(id).unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v.get("mcp")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    }

    #[test]
    fn assign_adds_the_server_and_is_idempotent() {
        let store = with_persona(r#"{"id":"p1","name":"P","role":"worker"}"#);
        assign_in(&store, "acme", "p1", true, "t").unwrap();
        assert_eq!(mcp_of(&store, "p1"), vec!["acme"]);
        // Twice is once — a re-assign must not duplicate the entry.
        assign_in(&store, "acme", "p1", true, "t").unwrap();
        assert_eq!(mcp_of(&store, "p1"), vec!["acme"]);
    }

    #[test]
    fn unassign_removes_it_and_tolerates_what_was_never_there() {
        let store = with_persona(r#"{"id":"p1","name":"P","role":"worker","mcp":["acme","other"]}"#);
        assign_in(&store, "acme", "p1", false, "t").unwrap();
        assert_eq!(mcp_of(&store, "p1"), vec!["other"]);
        // Idempotent: removing what is absent succeeds and changes nothing.
        assign_in(&store, "acme", "p1", false, "t").unwrap();
        assert_eq!(mcp_of(&store, "p1"), vec!["other"]);
    }

    #[test]
    fn the_rest_of_the_persona_survives_a_write() {
        // The assignment is a read-modify-write of a record whose other fields are a free-form
        // passthrough. Losing `startPrompt` here would silently lobotomise an agent.
        let store = with_persona(
            r#"{"id":"p1","name":"P","role":"worker","startPrompt":"do the thing","skills":["s1"],"floor":{"code":"write"}}"#,
        );
        assign_in(&store, "acme", "p1", true, "t").unwrap();
        let raw = store.get("p1").unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["startPrompt"], "do the thing");
        assert_eq!(v["skills"][0], "s1");
        assert_eq!(v["floor"]["code"], "write");
        assert_eq!(v["name"], "P");
    }

    #[test]
    fn an_unknown_persona_is_refused_rather_than_created() {
        // A typo that minted an empty persona would be a new agent identity nobody asked for.
        let store = with_persona(r#"{"id":"p1","name":"P","role":"worker"}"#);
        let err = assign_in(&store, "acme", "nope", true, "t").unwrap_err();
        assert!(err.contains("no persona 'nope'"), "{err}");
        assert!(store.get("nope").unwrap().is_none(), "and nothing was written");
    }

    #[test]
    fn a_non_array_mcp_field_is_replaced_rather_than_crashing() {
        // The persona record is free-form, so this field can arrive as anything. Tolerate it.
        let store = with_persona(r#"{"id":"p1","name":"P","role":"worker","mcp":"acme"}"#);
        assign_in(&store, "other", "p1", true, "t").unwrap();
        assert_eq!(mcp_of(&store, "p1"), vec!["other"]);
    }

    #[test]
    fn the_list_is_sorted_so_a_reassign_does_not_churn_the_bytes() {
        let store = with_persona(r#"{"id":"p1","name":"P","role":"worker"}"#);
        for s in ["zeta", "alpha", "mid"] {
            assign_in(&store, s, "p1", true, "t").unwrap();
        }
        assert_eq!(mcp_of(&store, "p1"), vec!["alpha", "mid", "zeta"]);
    }

    #[test]
    fn a_missing_flag_is_a_usage_error_not_a_panic() {
        // The ARG PARSING half, which assign_in does not cover.
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let err = assign(&a(&["assign", "acme"]), "bsc mcp server", true).unwrap_err();
        assert!(err.contains("--persona"), "{err}");
        // …and a flag must not be read AS the server id.
        let err = assign(&a(&["assign", "--persona", "p1"]), "bsc mcp server", true).unwrap_err();
        assert!(err.contains("<server-id>"), "{err}");
    }
}
