//! `bsc secret` — the session-facing + app-facing surface over the credential store.
//!
//! # What this CLI can and cannot do
//!
//! **No verb prints a secret.** `list` and `get` project the [`Credential`] metadata (which has no
//! field that could hold one) plus the derived [`Status`]; `put` reads a value from stdin and writes
//! it to the keychain without echoing it back. [`crate::vault::Vault::get`] — the one method that
//! reads a value — is not reachable from any command here. That is deliberate and it is the whole
//! point of the surface: a session can see WHICH credentials exist and WHETHER they work, and cannot
//! extract one.
//!
//! `list`/`get`/`put`/`forget`/`ok`/`fail`/`remove` are implemented here because each needs the
//! keychain, the derived status, or both. `set` is the shared scaffold's, wrapped in the write-time
//! gate that keeps a secret out of the metadata store ([`crate::reject_secret_bearing`]).

use crate::vault::{Keyring, Vault};
use crate::{status, Credential};
use bsc_cli_util::CmdDoc;
use serde_json::{json, Value};

const TAGLINE: &str = "the credential store — what services we are paired with, and whether those pairings still work";

/// The crate's own verb catalog. `pub` so `bsc surface verbs` can PROJECT it rather than
/// restate it — a generated catalog cannot drift, a second list does.
pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every credential + its derived status",
        usage: "USAGE:\n  bsc secret list [--pretty]\n\nOne object per credential: id, service, label, kind, account, status,\nlastVerifiedAt, lastError, expiresAt, hasSecret.\n\nNEVER a secret value — see `bsc secret put`.\n\nSTATUS is derived, never stored:\n  missing     the store holds a record but the keychain holds no secret for it\n  expired     past its declared expiry\n  failing     the last observed use failed\n  expiring    within 7 days of its declared expiry\n  ok          the last observed use succeeded\n  unverified  a secret is present but nothing has used it yet",
    },
    CmdDoc {
        name: "get",
        summary: "one credential + its derived status",
        usage: "USAGE:\n  bsc secret get <id> [--pretty]",
    },
    CmdDoc {
        name: "set",
        summary: "upsert credential METADATA from JSON on stdin",
        usage: "USAGE:\n  bsc secret set   # one object, or an array, as JSON on stdin\n\nFields: id (required), service, label, kind, account, expiresAt, note.\n\nREFUSES any payload carrying a secret-bearing key (token/secret/password/\napiKey/…), at any depth. The value goes in the keychain via `bsc secret put`,\nnever in this store.",
    },
    CmdDoc {
        name: "put",
        summary: "store a credential's SECRET in the OS keychain (value on stdin)",
        usage: "USAGE:\n  bsc secret put <id>   # the value on stdin\n\nReads the secret from stdin and writes it to the OS keychain. The value is\nnever echoed, never logged, and no `bsc secret` verb can read it back.\nA trailing newline is stripped (so `echo` and a heredoc both work);\nnothing else is touched.",
    },
    CmdDoc {
        name: "forget",
        summary: "delete a credential's secret, keeping its record",
        usage: "USAGE:\n  bsc secret forget <id>\n\nThe record survives and reports `missing`, so a revoked credential stays\nVISIBLE rather than silently vanishing. Use `remove` to drop both.",
    },
    CmdDoc {
        name: "ok",
        summary: "stamp a credential as having just worked",
        usage: "USAGE:\n  bsc secret ok <id>\n\nRecords lastResult=ok + lastVerifiedAt=now and clears any lastError.\nThis is how a credential becomes `ok` rather than `unverified` — status is\nderived from observed use, so something has to report the observation.",
    },
    CmdDoc {
        name: "fail",
        summary: "stamp a credential as having just failed",
        usage: "USAGE:\n  bsc secret fail <id> [message]\n\nRecords lastResult=failed + lastVerifiedAt=now and stores `message` as\nlastError, which is what the Credentials screen shows as the reason.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a credential — record AND secret",
        usage: "USAGE:\n  bsc secret remove <id>\n\nDrops the metadata record and forgets the keychain secret, so no orphaned\nsecret is left behind under an id nothing lists any more.",
    },
];

/// The scaffold spec — `set` is the only verb it actually serves (everything else is intercepted
/// below), but it also supplies the store dir resolution, the id slug guard, and the help catalog.
const SPEC: bsc_json_store::cli::CliSpec = bsc_json_store::cli::CliSpec {
    noun: "credential",
    dir_env: "BSC_SECRET_DIR",
    dir_segment: crate::STORE_SEGMENT,
    tagline: TAGLINE,
    commands: COMMANDS,
    meta_fields: &["id", "service", "label", "kind"],
    graph_fields: &[],
    field_aliases: &[],
};

/// `bsc secret <command>` — see [`COMMANDS`] for the surface.
///
/// # Errors
/// A bad/absent id, an unknown command, an unreachable store, or a `set` payload that carries a
/// secret-bearing key.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    run_with(args, prog, &Keyring)
}

/// [`run`] against an injected [`Vault`] — the seam the tests use, since a real keychain is not
/// available in the environments they run in (see [`crate::vault`]).
pub fn run_with(args: Vec<String>, prog: &str, vault: &dyn Vault) -> Result<(), String> {
    let positional = positionals(&args);
    let cmd = positional.first().cloned().unwrap_or_default();
    let pretty = args.iter().any(|a| a == "--pretty");

    // Help first, so it works with no store dir resolvable — same order as the shared scaffold.
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &positional) {
        return Ok(());
    }

    // `set` is the shared scaffold's, behind the write-time gate that keeps a secret out of the
    // metadata store. Delegated whole so its stdin/--file/batch semantics stay identical to every
    // other `bsc <noun> set` rather than being re-implemented slightly differently here.
    if cmd == "set" {
        let validate = |items: &[Value]| -> Result<(), String> {
            for item in items {
                crate::reject_secret_bearing(item, prog)?;
            }
            Ok(())
        };
        return bsc_json_store::cli::run_hooked_validated(args, prog, &SPEC, None, Some(&validate));
    }

    let store = open_store(&args, prog)?;
    let arg = |n: usize| positional.get(n).cloned();

    match cmd.as_str() {
        "list" => {
            let rows = project(&store.list(), vault, crate::now_secs());
            print_json(&Value::Array(rows), pretty);
            Ok(())
        }
        "get" => {
            let id = arg(1).ok_or_else(|| format!("usage: {prog} get <id>"))?;
            match store.get(&id)? {
                Some(raw) => {
                    let rows = project(&[raw], vault, crate::now_secs());
                    // `project` skips an unparseable record, so an id that IS stored but holds
                    // garbage prints `null` rather than an empty array pretending it is absent.
                    print_json(rows.first().unwrap_or(&Value::Null), pretty);
                }
                None => print_json(&Value::Null, pretty),
            }
            Ok(())
        }
        "put" => {
            let id = arg(1).ok_or_else(|| format!("usage: {prog} put <id>"))?;
            require_record(&store, &id, prog, "put")?;
            let value = read_stdin(prog)?;
            if value.is_empty() {
                return Err(format!(
                    "{prog} put {id}: refusing to store an empty secret — pipe the value on stdin"
                ));
            }
            vault.put(&id, &value)?;
            // Echo the ID, never the value. A caller needs to know the write landed; it already has
            // the secret it just handed us.
            print_json(&json!({ "id": id, "stored": true }), pretty);
            Ok(())
        }
        "forget" => {
            let id = arg(1).ok_or_else(|| format!("usage: {prog} forget <id>"))?;
            vault.forget(&id)?;
            print_json(&json!({ "id": id, "forgotten": true }), pretty);
            Ok(())
        }
        "ok" | "fail" => {
            let id = arg(1).ok_or_else(|| format!("usage: {prog} {cmd} <id> [message]"))?;
            let failed = cmd == "fail";
            // The message is the REST of the positionals joined, so `bsc secret fail gh 401 invalid
            // token` works unquoted — the shape a shell caller actually writes after a failed call.
            let message = positional.get(2..).map(|r| r.join(" ")).filter(|m| !m.is_empty());
            let mut record = load(&store, &id, prog)?;
            record.last_verified_at = Some(crate::now_secs());
            record.last_result =
                Some(if failed { crate::RESULT_FAILED } else { crate::RESULT_OK }.to_string());
            // An `ok` CLEARS the previous error: leaving it would have the screen showing a reason
            // for a failure that has since been superseded.
            record.last_error = if failed { message } else { None };
            store.set(&id, &serde_json::to_string(&record).map_err(|e| e.to_string())?)?;
            let rows = project(&[serde_json::to_string(&record).map_err(|e| e.to_string())?], vault, crate::now_secs());
            print_json(rows.first().unwrap_or(&Value::Null), pretty);
            Ok(())
        }
        "remove" => {
            let id = arg(1).ok_or_else(|| format!("usage: {prog} remove <id>"))?;
            store.remove(&id)?;
            // Both halves, or the secret outlives every record of what it was for — an orphan nothing
            // can list, revoke or even name.
            vault.forget(&id)?;
            print_json(&json!({ "id": id, "removed": true }), pretty);
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// Flags that consume the NEXT argument as their value, so it is not a positional.
///
/// Getting this wrong is silent and ugly rather than loud: `bsc secret fail gh 401 --dir /tmp/x`
/// swallowed `/tmp/x` into the stored failure MESSAGE, because a bare `!a.starts_with("--")` filter
/// sees a flag's value as just another word. `fail`'s message is the rest of the positionals joined
/// (so it can be written unquoted), which is exactly what makes it the verb that shows the bug.
const VALUE_FLAGS: &[&str] = &["--dir", "--file"];

/// The positional arguments, with flags AND their values removed.
fn positionals(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip_next = false;
    for a in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if a.starts_with("--") {
            // `--dir=<v>` carries its value inline, so nothing follows to skip.
            skip_next = VALUE_FLAGS.contains(&a.as_str());
            continue;
        }
        out.push(a.clone());
    }
    out
}

/// The enriched projection every read verb emits: the stored metadata, plus `hasSecret` and the
/// derived `status`. Pure over its inputs (records in, rows out) so the status/keychain interaction
/// is testable without a keychain or a store.
///
/// An unparseable record is SKIPPED rather than aborting the list — matching the shared scaffold's
/// lenient read, so one bad row cannot blank the whole screen.
pub fn project(records: &[String], vault: &dyn Vault, now: i64) -> Vec<Value> {
    records
        .iter()
        .filter_map(|raw| serde_json::from_str::<Credential>(raw).ok())
        .map(|c| {
            let has_secret = vault.has(&c.id);
            let st = status(&c, has_secret, now);
            let mut row = serde_json::to_value(&c).unwrap_or_else(|_| json!({}));
            if let Some(obj) = row.as_object_mut() {
                obj.insert("status".into(), json!(st.as_str()));
                obj.insert("hasSecret".into(), json!(has_secret));
                obj.insert("needsAttention".into(), json!(st.needs_attention()));
                // Fall the label back to the id here rather than in every renderer — a row with no
                // label must never render as a blank line.
                if c.label.trim().is_empty() {
                    obj.insert("label".into(), json!(c.id));
                }
            }
            row
        })
        .collect()
}

/// Load a record as a typed [`Credential`], failing with a message that names the fix.
fn load(store: &bsc_json_store::Store, id: &str, prog: &str) -> Result<Credential, String> {
    let raw = store
        .get(id)?
        .ok_or_else(|| format!("{prog}: no credential `{id}` — `{prog} set` it first, then `{prog} put {id}`"))?;
    serde_json::from_str(&raw).map_err(|e| format!("{prog}: credential `{id}` is not readable: {e}"))
}

/// Refuse to put a secret under an id the store has no record for.
///
/// Without this, a typo mints an unreachable secret: `bsc secret put githbu` would succeed, the
/// keychain would hold a value under an id nothing lists, and the credential the user meant would
/// still read `missing`. The keychain has no listing to reconcile against, so nothing would ever
/// find it again.
fn require_record(store: &bsc_json_store::Store, id: &str, prog: &str, verb: &str) -> Result<(), String> {
    match store.get(id)? {
        Some(_) => Ok(()),
        None => Err(format!(
            "{prog} {verb} {id}: no credential `{id}` in the store.\n\
             Register it first so the secret has a record to belong to:\n  \
             echo '{{\"id\":\"{id}\",\"service\":\"…\",\"label\":\"…\"}}' | {prog} set"
        )),
    }
}

/// Resolve the store the same way the shared scaffold does (`--dir` > `$BSC_SECRET_DIR` > default).
fn open_store(args: &[String], prog: &str) -> Result<bsc_json_store::Store, String> {
    let dir_flag = args.iter().position(|a| a == "--dir").and_then(|i| args.get(i + 1)).cloned();
    let dir = bsc_cli_util::resolve_store_path(&dir_flag, SPEC.dir_env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(SPEC.dir_segment))
            .ok_or_else(|| format!("{prog}: could not resolve the credential store; set HOME/USERPROFILE or pass --dir"))
    })?;
    Ok(bsc_json_store::Store::new(dir, SPEC.noun))
}

fn read_stdin(prog: &str) -> Result<String, String> {
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("{prog}: could not read the value from stdin: {e}"))?;
    // Strip ONE trailing newline (and its CR), so `echo tok | bsc secret put x` stores `tok` rather
    // than `tok\n`. Nothing else is trimmed: leading/inner whitespace can be part of a real secret.
    let trimmed = buf.strip_suffix('\n').unwrap_or(&buf);
    let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);
    Ok(trimmed.to_string())
}

fn print_json(v: &Value, pretty: bool) {
    let s = if pretty {
        serde_json::to_string_pretty(v).unwrap_or_default()
    } else {
        serde_json::to_string(v).unwrap_or_default()
    };
    println!("{s}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::MapVault;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 24 * 60 * 60;

    fn record(id: &str, extra: Value) -> String {
        let mut v = json!({ "id": id, "service": "github", "label": "GitHub", "kind": "oauth" });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in e {
                o.insert(k.clone(), val.clone());
            }
        }
        v.to_string()
    }

    #[test]
    fn the_projection_adds_status_and_hassecret_to_each_record() {
        let rows = project(&[record("gh", json!({}))], &MapVault::with(&["gh"]), NOW);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["status"], "unverified");
        assert_eq!(rows[0]["hasSecret"], true);
        assert_eq!(rows[0]["service"], "github");
    }

    #[test]
    fn a_record_with_no_keychain_entry_projects_as_missing() {
        // The store/keychain disagreement, end to end through the projection the screen renders.
        let rows = project(&[record("gh", json!({ "lastResult": "ok", "lastVerifiedAt": NOW }))], &MapVault::default(), NOW);
        assert_eq!(rows[0]["status"], "missing");
        assert_eq!(rows[0]["hasSecret"], false);
        assert_eq!(rows[0]["needsAttention"], true);
    }

    #[test]
    fn the_projection_never_emits_a_secret_even_when_the_vault_holds_one() {
        // The guarantee the whole surface rests on, asserted against the vault's actual stored value
        // rather than against the absence of a field name.
        let vault = MapVault::default();
        vault.put("gh", "ghp_SUPERSECRET").unwrap();
        let rows = project(&[record("gh", json!({}))], &vault, NOW);
        let printed = serde_json::to_string(&rows).unwrap();
        assert!(!printed.contains("ghp_SUPERSECRET"), "the projection leaked the secret: {printed}");
        assert_eq!(rows[0]["hasSecret"], true, "...while still reporting that one exists");
    }

    #[test]
    fn an_unparseable_record_is_skipped_rather_than_blanking_the_list() {
        let rows = project(
            &["{ not json".to_string(), record("gh", json!({}))],
            &MapVault::with(&["gh"]),
            NOW,
        );
        assert_eq!(rows.len(), 1, "the good row survives its bad neighbour");
        assert_eq!(rows[0]["id"], "gh");
    }

    #[test]
    fn a_blank_label_falls_back_to_the_id_so_no_row_renders_empty() {
        let rows = project(&[json!({ "id": "gh", "label": "  " }).to_string()], &MapVault::with(&["gh"]), NOW);
        assert_eq!(rows[0]["label"], "gh");
    }

    #[test]
    fn each_status_survives_the_projection_intact() {
        // The projection is where `status()` meets the vault; pin the interaction at each state so a
        // rewiring that always passes `has_secret: true` is caught.
        let vault = MapVault::with(&["expired", "failing", "expiring", "fine"]);
        let cases = [
            ("expired", json!({ "expiresAt": NOW - DAY }), "expired"),
            ("failing", json!({ "lastResult": "failed", "lastVerifiedAt": NOW }), "failing"),
            ("expiring", json!({ "expiresAt": NOW + DAY }), "expiring"),
            ("fine", json!({ "lastResult": "ok", "lastVerifiedAt": NOW }), "ok"),
            ("gone", json!({ "lastResult": "ok", "lastVerifiedAt": NOW }), "missing"),
        ];
        for (id, extra, want) in cases {
            let rows = project(&[record(id, extra)], &vault, NOW);
            assert_eq!(rows[0]["status"], want, "id {id}");
        }
    }

    #[test]
    fn the_command_catalog_documents_every_verb_run_dispatches() {
        // A verb that dispatches but is undocumented is invisible to `bsc secret help`, which is the
        // only way a session discovers this surface.
        let src = include_str!("cli.rs");
        let run_body = &src[src.find("pub fn run_with(").expect("run_with present")..];
        for doc in COMMANDS {
            assert!(
                run_body.contains(&format!("\"{}\"", doc.name)),
                "`{}` is documented but never dispatched",
                doc.name,
            );
        }
    }

    #[test]
    fn no_command_can_reach_the_vaults_read_method() {
        // The structural guarantee: `Vault::get` is the only way to obtain a secret, and nothing on
        // this surface calls it. Asserted against the source so adding a `bsc secret show` cannot
        // pass review by accident.
        let src = include_str!("cli.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        assert!(
            !body.contains("vault.get(") && !body.contains(".get(&id).map(|v| v"),
            "a `bsc secret` command reads a secret value — no verb may print one",
        );
    }

    #[test]
    fn a_value_flag_does_not_leak_its_value_into_the_positionals() {
        // The bug this exists for: `fail`'s message is the rest of the positionals joined, so a
        // `--dir <path>` anywhere on the line ended up STORED as part of the failure reason.
        let argv = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            positionals(&argv(&["fail", "gh", "401", "invalid_grant", "--dir", "/tmp/store"])),
            ["fail", "gh", "401", "invalid_grant"],
        );
        // ...and before the positionals, which is where it breaks `get <id>` outright by shifting
        // every index: the id would be read as the store path.
        assert_eq!(positionals(&argv(&["--dir", "/tmp/store", "get", "gh"])), ["get", "gh"]);
    }

    #[test]
    fn a_boolean_flag_consumes_nothing_after_it() {
        let argv = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(positionals(&argv(&["get", "--pretty", "gh"])), ["get", "gh"]);
        // The inline form carries its own value, so the next word is still a positional.
        assert_eq!(positionals(&argv(&["--dir=/tmp/x", "get", "gh"])), ["get", "gh"]);
    }

    #[test]
    fn the_store_env_and_segment_match_the_documented_names() {
        assert_eq!(SPEC.dir_env, "BSC_SECRET_DIR");
        assert_eq!(SPEC.dir_segment, "secrets");
        assert_eq!(SPEC.noun, "credential");
    }
}
