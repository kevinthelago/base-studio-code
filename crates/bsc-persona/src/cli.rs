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

/// How long `use` waits for the app, and how it polls — the same numbers `bsc fleet` uses, so the two
/// verbs on this transport behave alike.
const DEFAULT_TIMEOUT_MS: i64 = 10_000;
const POLL_INTERVAL_MS: u64 = 50;
/// Requests older than this are swept before a new one is written, so a dead run cannot accumulate.
const STALE_MS: i64 = 60_000;

const TAGLINE: &str = "the user persona store — list/get/set/remove ~/.base-studio-code/personas (#2094)";

/// The crate's own verb catalog. `pub` so `bsc surface verbs` can PROJECT it rather than
/// restate it — a generated catalog cannot drift, a second list does.
pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every persona's {id, name, role} (JSON)",
        usage: "\
USAGE:
  bsc persona list [--full] [--pretty]

Prints every persona's { id, name, role, model } as JSON (compact; --pretty for indented). --full
emits the COMPLETE persona objects (role + startPrompt + skills + model + …) as a plain array — the
full-fidelity read the desktop library hydration needs.

An empty `model` is the real answer for a persona that has never set one: it launches on Claude
Code's own default. `model` is projected here so the whole library's tiers are ONE read — asking
which personas run cheap used to mean a `get` per persona.",
    },
    CmdDoc {
        name: "reseed",
        summary: "restore every built-in's FLOOR to the one the app ships with",
        usage: "\
USAGE:
  bsc persona reseed [--dry-run] [--pretty]

Rewrites the permission FLOOR of every packaged persona from the shipped definition, and touches
nothing else — name, model, startPrompt and skills are yours and stay as they are.

WHY IT EXISTS. A built-in's floor is seeded once and never reconciled, so a persona seeded at an
older version kept that version's surface forever. MEASURED on a real store, 6 of 18 built-ins had
drifted: `persona-librarian` offered five retired `bsc loop *` verbs while hiding `bsc session
reply`, which its own charter instructs it to use, and `persona-curator` hid `bsc graph` and
`bsc ui` — its entire tool surface. `bsc persona whatami` reported all of it, so a session asking
what it was allowed to do got the wrong answer in both directions.

It cannot widen anything past what shipped: the packaged floor IS the clamp ceiling, so a reseed is
a narrowing-or-equal write by construction, and a surface the app never granted is refused rather
than restored. --dry-run reports what would change and writes nothing.",
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
        name: "model",
        summary: "set (or clear) the LLM tier a persona launches on",
        usage: "\
USAGE:
  bsc persona model <id> <tier>     # haiku-4.5 | sonnet-4.5 | opus-4.5
  bsc persona model <id> --clear    # back to the harness default

Sets one persona's default MODEL and leaves every other field byte-identical. Prints the stored
persona. Every session launched as this persona runs on that tier (`claude --model <alias>`) unless
something nearer overrides it — a fleet stream's own model, or a team placement's.

This is how you make a team cheap to test: point its personas at `haiku-4.5`, run the fleet, then
clear them again. Use `bsc teams model` instead when only ONE team should be cheap — that overrides
the tier for that placement and leaves the persona's default alone.

An unknown tier is REFUSED and the error names the ones that exist. That matters more than it looks:
an unrecognized value is not an error at launch, it is silently no `--model` at all, so a typo would
read as `sonnet` and cost like `opus` with nothing to see.

--clear removes the field, which is not the same as naming a tier: the session then launches with no
`--model` and runs on Claude Code's own default. That is the default for every persona that has never
set one.

It exists for the reason `rename` does: `set` is a whole-record verbatim upsert, so changing one
field through it means reading the record, hand-copying it, editing and writing the whole thing back
— and the start prompt and the skill list are the expensive things to lose in that round trip. A
restricted session cannot pipe or redirect either.

A BUILT-IN persona is settable here, unlike `rename`/`remove`. Its model is not its identity, the
library reconcile preserves the edit, and the system sessions (designer, librarian, architect, …) are
exactly the ones worth running cheap while testing.",
    },
    CmdDoc {
        name: "use",
        summary: "run a pane as a different persona (relaunches it)",
        usage: "USAGE:
  bsc persona use <paneId> <personaId> [--no-relaunch] [--force] [--timeout <ms>] [--json|--pretty]

Changes which persona a pane runs as. A persona is the LAUNCH primitive - capability, MCP servers and
hooks all resolve from it when the session starts - so this RELAUNCHES the pane by default, and says
so. Rewriting the assignment under a running session would change nothing the agent can observe.

  --no-relaunch   set the assignment only; it applies at the next launch
  --force         relaunch even when the pane is BUSY (a relaunch kills the session first)
  --timeout <ms>  how long to wait for the app to answer

Requires the desktop app to be running: the assignment lives in its store, not on disk. An unknown
persona id is refused BEFORE anything is killed, and the error names ids that do exist.",
    },
    CmdDoc {
        name: "whatami",
        summary: "what THIS session is running as (persona + role)",
        usage: "USAGE:
  bsc persona whatami [--pane <paneId>] [--timeout <ms>] [--json|--pretty]

Prints the persona and ROLE the calling pane is running as - the question that decides what the
session is allowed to do. Defaults to the pane it is running in, read from $BSC_AUDIT_PANE, which
every session carries; --pane names another.

An agent can run this to check its own role rather than inferring it from its kickoff prose. A pane
with no persona reports its role alone, which is a real state and not an error.

It also reports `viewing` — WHAT THE USER IS LOOKING AT right now, worded as the titlebar words it
(`Components — React — bsc-kit`). Read it before acting on anything phrased as `the graph`, `this
kit` or `here`: a studio start prompt names its technology and nothing finer, the user can switch
tabs mid-session, and the studios whose axis is not technology run one session across every value.
`--json` additionally carries `workspace` and `pageTab` — the graph and its axis value — for a
session that wants to act on them rather than print them.

Requires the desktop app to be running: the assignment lives in its store, not on disk.",
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
    meta_fields: &["id", "name", "role", "model"],
    graph_fields: &[],
    field_aliases: &[],
};

/// The `persona` subcommand entrypoint: `args` is everything after `bsc persona`; `prog` is the
/// display name for help/errors. Delegates to the shared dispatch with the persona [`SPEC`].
///
/// `rename` and `model` are intercepted BEFORE delegating: they are persona-specific (the shared store
/// CLI knows nothing about a `name` or `model` field) and the scaffold would reject them as unknown
/// commands. `help` still lists them, because the catalog above is what the shared help renders.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("rename") && args.get(1).map(String::as_str) != Some("help") {
        return rename(&args, prog);
    }
    if args.first().map(String::as_str) == Some("model") && args.get(1).map(String::as_str) != Some("help") {
        return set_model(&args, prog);
    }
    if args.first().map(String::as_str) == Some("use") && args.get(1).map(String::as_str) != Some("help") {
        return use_pane(&args, prog);
    }
    if args.first().map(String::as_str) == Some("whatami") && args.get(1).map(String::as_str) != Some("help") {
        return whatami(&args, prog);
    }
    // The narrow-only floor clamp rides the shared runner's write-time batch gate (#2928), so the
    // check happens BEFORE any write and a bad batch is rejected whole — the same contract
    // `bsc plan add` states. It is a CLOSURE rather than a plain fn because resolving a persona's
    // ancestor means reading the store, and the store dir is whatever `--dir`/env/default resolves
    // to for THIS invocation; a fn pointer could not see it and would silently clamp against the
    // default store while writing to another.
    let dir = store_dir(&args, prog)?;
    if args.first().map(String::as_str) == Some("reseed") && args.get(1).map(String::as_str) != Some("help") {
        return reseed(&args, &dir, prog);
    }
    // `remove` is intercepted for the same reason `rename` is guarded: the shared scaffold knows
    // nothing about `builtin`, so the protection has to live where the noun does.
    if args.first().map(String::as_str) == Some("remove") && args.get(1).map(String::as_str) != Some("help") {
        if let Some(id) = args.iter().skip(1).find(|a| !a.starts_with("--")) {
            refuse_if_builtin(&bsc_json_store::Store::new(dir.clone(), SPEC.noun), id, prog, "remove")?;
        }
    }
    // `set` is intercepted too — see `set_persona`'s doc comment for why a plain verbatim upsert
    // silently destroys a builtin's `proseSeal` (#172).
    if args.first().map(String::as_str) == Some("set") && args.get(1).map(String::as_str) != Some("help") {
        return set_persona(&args, &dir, prog);
    }
    let validate = |items: &[serde_json::Value]| validate_floor_batch(items, &dir, prog);
    bsc_json_store::cli::run_hooked_validated(args, prog, &SPEC, None, Some(&validate))
}

/// `set` — upsert, carrying a builtin's `proseSeal`/`replacedProse` FORWARD when the payload omits them.
///
/// The generic store CLI's `set` is a whole-record verbatim upsert (see `rename`'s doc comment above
/// for why that is right for nearly everything a persona carries): a session that `get`s a persona,
/// edits it, and `set`s the whole object back — the ONLY way to author into this store — will do so
/// without `proseSeal`/`replacedProse`, since nothing outside the frontend's `reconcilePersonas`
/// (`persona.ts`) ever computes a prose fingerprint.
///
/// A plain verbatim overwrite therefore DROPS a builtin's existing seal whenever a caller edits its
/// prose this way — and dropping it is not neutral: `reconcilePersonas` reads an absent `proseSeal` as
/// "never sealed" (bootstrap provenance), which it treats as safe to re-seed from the packaged prose
/// on the very next hydrate — silently REVERTING the just-written edit and filing it away into
/// `replacedProse` instead. That is exactly what happened to the director's first attempt at
/// `bsc request 172` (`bsc plan get request-172-persona-worker-logging-perf-ownership`): a correct
/// `get` → edit → `set` round-trip on `persona-worker`'s `startPrompt` landed, then vanished on the
/// next app hydrate.
///
/// The fix is narrow: when the incoming item does not mention `proseSeal`/`replacedProse` at all, carry
/// the STORED record's existing value forward rather than writing an absent one. Left untouched, an old
/// seal correctly MISMATCHES the newly-written prose on the next reconcile — which is precisely the
/// signal `reconcilePersonas` uses to recognize "a real edit happened, keep it" (see its doc comment).
/// A user-authored persona (which never has a seal) round-trips exactly as before.
/// Restore every packaged persona's FLOOR to the shipped one, leaving every other field alone.
///
/// FLOOR ONLY, and that is the whole design. `bsc persona model` moves a persona's tier and a user may
/// rename one; rewriting the whole record would undo both to fix a permissions field. So this reads the
/// stored record, replaces exactly `floor`, and writes it back — a persona that has never been stored
/// is left absent rather than created, because seeding a library is not this verb's job.
///
/// It cannot widen: the packaged floor is the clamp ceiling (see `validate_floor_batch`), so writing it
/// is narrowing-or-equal by construction. A stored surface the app never granted — the retired
/// `bsc loop *` entries — is REMOVED by this rather than blessed, which is the direction that matters.
fn reseed(args: &[String], dir: &std::path::Path, prog: &str) -> Result<(), String> {
    let dry = args.iter().any(|a| a == "--dry-run");
    let pretty = args.iter().any(|a| a == "--pretty");
    let store = bsc_json_store::Store::new(dir.to_path_buf(), SPEC.noun);
    let mut changed: Vec<serde_json::Value> = Vec::new();

    for (id, shipped) in crate::packaged::packaged_personas() {
        let Some(want) = shipped.get("floor") else { continue };
        let Some(text) = store.get(&id)? else { continue }; // never stored ⇒ not this verb's job
        let Ok(mut have) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        if have.get("floor") == Some(want) {
            continue;
        }
        // NAME THE FIELDS THAT DIFFER, not just `allow`. Reporting the allow-list alone printed seven
        // personas as "would reseed" with an identical list beside them — the difference was that their
        // stored floor omitted every AXIS, which `floor.rs` reads as `none`. A report that cannot say
        // what it is about to change is not a dry run.
        let empty = serde_json::Map::new();
        let hf = have.get("floor").and_then(|f| f.as_object()).unwrap_or(&empty);
        let wf = want.as_object().unwrap_or(&empty);
        let mut fields: Vec<String> = hf.keys().chain(wf.keys()).cloned().collect();
        fields.sort();
        fields.dedup();
        fields.retain(|k| hf.get(k) != wf.get(k));
        let before = have.get("floor").and_then(|f| f.get("allow")).cloned().unwrap_or(serde_json::Value::Null);
        let after = want.get("allow").cloned().unwrap_or(serde_json::Value::Null);
        changed.push(serde_json::json!({
            "id": id, "fields": fields, "allowBefore": before, "allowAfter": after,
        }));
        if !dry {
            if let Some(obj) = have.as_object_mut() {
                obj.insert("floor".to_string(), want.clone());
            }
            store.set(&id, &have.to_string())?;
        }
    }

    let out = serde_json::json!({
        "reseeded": if dry { serde_json::Value::from(0) } else { serde_json::Value::from(changed.len()) },
        "wouldReseed": if dry { serde_json::Value::from(changed.len()) } else { serde_json::Value::from(0) },
        "personas": changed,
    });
    let _ = prog;
    bsc_sqlite_util::print_json(&out, pretty);
    Ok(())
}

fn set_persona(args: &[String], dir: &std::path::Path, prog: &str) -> Result<(), String> {
    let mut pretty = false;
    let mut file: Option<String> = None;
    let mut it = args.iter().skip(1); // skip "set" itself
    while let Some(a) = it.next() {
        match a.as_str() {
            "--pretty" => pretty = true,
            "--file" => {
                file = Some(it.next().cloned().ok_or_else(|| format!("{prog} set: --file needs a bare filename in $BSC_SCRATCH"))?)
            }
            "--dir" => {
                it.next(); // already resolved into `dir` by the caller
            }
            // ACCURATE ABOUT WHAT IT FOUND. Its three siblings — `model`, `use`, `whatami` — guard on
            // `starts_with("--")`, so only this one calls a bare word a "flag": `bsc persona set foo`
            // answered "unknown flag 'foo'". Still refused, because `set` takes no positionals and
            // swallowing a typo silently is worse, but named for what it is.
            other if other.starts_with("--") => return Err(format!("{prog} set: unknown flag '{other}'")),
            other => {
                return Err(format!(
                    "{prog} set: unexpected argument '{other}' — `set` reads the persona from stdin and \
                     takes flags only"
                ))
            }
        }
    }

    let raw = bsc_cli_util::read_payload(file.as_deref())?;
    let items: Vec<serde_json::Value> = bsc_sqlite_util::parse_json_items(&raw, SPEC.noun)?;
    validate_floor_batch(&items, dir, prog)?;

    let store = bsc_json_store::Store::new(dir.to_path_buf(), SPEC.noun);
    let items: Vec<serde_json::Value> = items
        .into_iter()
        .map(|item| {
            let id = item.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
            let existing = store
                .get(id)
                .ok()
                .flatten()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
            carry_forward_prose_seal(existing.as_ref(), item)
        })
        .collect();

    // `bsc_json_store::cli::set_items` (the write loop) is private to that module, so it is inlined
    // here over the same public `id_of` helper that module uses — upsert by `id`, verbatim, in order.
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        let id = bsc_json_store::cli::id_of(&item, SPEC.noun)?;
        let json = serde_json::to_string(&item).map_err(|e| format!("{prog} set: {e}"))?;
        store.set(&id, &json)?;
        ids.push(id);
    }
    bsc_sqlite_util::print_json(&ids, pretty);
    Ok(())
}

/// For each of `proseSeal`/`replacedProse`: if `item` does not carry the key at all, and `existing`
/// (the currently stored record, if any) does, copy `existing`'s value onto `item`. A key present in
/// `item` — including an explicit `null`, which is how a caller would clear one deliberately — is
/// always left as the caller wrote it.
fn carry_forward_prose_seal(existing: Option<&serde_json::Value>, mut item: serde_json::Value) -> serde_json::Value {
    let Some(existing) = existing.and_then(serde_json::Value::as_object) else { return item };
    let Some(obj) = item.as_object_mut() else { return item };
    for field in ["proseSeal", "replacedProse"] {
        if !obj.contains_key(field) {
            if let Some(v) = existing.get(field) {
                obj.insert(field.to_string(), v.clone());
            }
        }
    }
    item
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

        // The ancestor chain, in order. For a persona the app SHIPS, the ceiling is its PACKAGED
        // floor — not whatever the store happens to hold.
        //
        // That ordering used to be the other way round, and it made a built-in's floor a one-way
        // ratchet. `stored_floor` short-circuited, so the first value ever written became the
        // permanent ceiling and every later packaged widening was unreachable: `bsc persona set`
        // refused the app's own shipped definition as "would WIDEN beyond its own stored floor".
        // MEASURED on a real store, 6 of 18 built-ins had drifted that way — `persona-librarian`
        // offering five retired `bsc loop *` verbs while hiding `bsc session reply`, which its
        // charter instructs it to use, and `persona-curator` hiding `bsc graph` and `bsc ui`, its
        // entire tool surface.
        //
        // NOTHING IS GIVEN UP BY THIS. The invariant that matters is "never wider than what shipped",
        // and that is exactly what the packaged floor expresses; the stored value is a current
        // setting, not a ceiling. A narrowing is still accepted, a widening PAST the packaged floor
        // is still refused (which is what removes those `bsc loop *` entries rather than blessing
        // them), and a persona the app does not ship is unaffected — its chain is still stored →
        // derivesFrom → closed. What changes is only that a deliberate narrowing of a BUILT-IN is now
        // reversible up to the capability the app shipped it with, which is the difference between a
        // floor and a trap.
        //
        // The packaged link is also what makes seeding possible at all: without it a store where
        // nothing has a floor yet refuses every write, because every branch falls through to the
        // closed floor. See `packaged.rs` — that was a real merged bug, found by the live CLI check
        // and invisible to unit tests that seed their ancestor with `store.set()`.
        let ancestor = match crate::packaged::packaged_floor(&id) {
            Some(shipped) => shipped,
            None => match stored_floor(&store, &id, &pending)? {
                Some(own) => own,
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
                crate::packaged::packaged_floor(&id).is_some(),
                stored_floor(&store, &id, &pending)?.is_some(),
                derives,
            ) {
                (true, _, _) => format!("the PACKAGED floor for '{id}' — the capability the app ships it with"),
                (false, true, _) => "its own stored floor".to_string(),
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
/// Refuse a destructive verb against a PACKAGED persona.
///
/// The system sessions — designer, librarian, architect, sound-designer, integrator and the rest —
/// run as built-in personas. They are the user's window onto what the system IS, and the Teams graph
/// presents them read-only for exactly that reason ("no inspector CRUD, no right-click delete —
/// `bsc teams` / `bsc persona` are what write"). The app store agrees: `removePersona` returns early
/// on `builtin`.
///
/// The CLI did not, and that is not theoretical — `bsc persona remove persona-designer` deleted the
/// running Design Studio's identity, after which `whatami` reported a pane with a role and no
/// persona. It comes back on the next hydrate, which makes it worse rather than better: the damage
/// is invisible until someone asks a live session who it is.
///
/// `set` is deliberately NOT guarded. Seeding goes through it — `hydratePersonas` reconciles the
/// packaged built-ins and pushes newly-seeded ones back — so refusing there would break the very
/// mechanism that restores these records.
fn refuse_if_builtin(store: &bsc_json_store::Store, id: &str, prog: &str, verb: &str) -> Result<(), String> {
    let Some(raw) = store.get(id)? else { return Ok(()) };  // absent → let the verb report it
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // Unparseable is not our problem to diagnose here; the verb itself will say so.
        Err(_) => return Ok(()),
    };
    if v.get("builtin").and_then(serde_json::Value::as_bool) == Some(true) {
        return Err(format!(
            "{prog} {verb}: '{id}' is a BUILT-IN persona — it belongs to the system, not to a user, \
             and is read-only here. The Teams graph shows it the same way. (It would also come back \
             on the next hydrate, so this would look like it worked and quietly change nothing.)"
        ));
    }
    Ok(())
}

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
    refuse_if_builtin(&store, id, prog, "rename")?;
    v["name"] = serde_json::Value::String(name.to_string());
    let out = serde_json::to_string(&v).map_err(|e| format!("{prog} rename: {e}"))?;
    store.set(id, &out)?;
    println!("{out}");
    Ok(())
}

/// `model <id> <tier>` / `model <id> --clear` — set (or remove) one persona's default model tier,
/// leaving every other field untouched.
///
/// Read-modify-write over the STORED json for the same reason [`rename`] is: the record is held
/// verbatim, and round-tripping it through a typed struct here would quietly drop any field this
/// crate has no model for.
///
/// ## The tier is validated, and that is the point of the verb
/// An unrecognized model is not an error at launch — `claude_model_flag` returns `None`, no `--model`
/// is injected, and the session runs on the harness default. So a typo stored through `set` is
/// invisible: the persona reads as `haiku-4.5x` and costs like whatever Claude Code defaults to. The
/// vocabulary is [`bsc_util::MODEL_TIERS`], the same table the launch maps through, so a tier this
/// accepts is exactly a tier the harness can carry.
///
/// ## Built-ins are NOT refused here
/// Unlike `rename`/`remove`, which are guarded because a packaged persona is the system's own
/// identity and the Teams graph presents it read-only. A model is not identity: the library's
/// reconcile keeps a user edit to a built-in (`definedFields`), and the system sessions are precisely
/// the ones a user wants to run cheap while testing.
fn set_model(args: &[String], prog: &str) -> Result<(), String> {
    let usage = format!(
        "usage: {prog} model <id> <model> | {prog} model <id> --clear   (tiers: {} — or any model installed locally)",
        bsc_util::model_id_list()
    );
    let mut clear = false;
    let mut positional: Vec<&str> = Vec::new();
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--clear" => clear = true,
            // Consumed by `store_dir`, which re-reads the raw args — skipped here so a store path is
            // never mistaken for the persona id or the tier.
            "--dir" => { it.next().ok_or("--dir needs a value")?; }
            "--pretty" | "--json" => {}
            other if other.starts_with("--") => return Err(format!("{prog} model: unknown flag {other}")),
            other => positional.push(other),
        }
    }
    let id = positional.first().copied().ok_or_else(|| usage.clone())?;
    let tier = positional.get(1).copied().map(str::trim).filter(|t| !t.is_empty());
    if clear && tier.is_some() {
        return Err(format!("{prog} model: --clear takes no tier — pass one or the other"));
    }
    if !clear && tier.is_none() {
        return Err(usage);
    }
    // A TIER OR AN INSTALLED LOCAL MODEL — the same rule every level uses (`llm::cli::verify_model`).
    //
    // This verb used to accept ONLY Claude tiers while the stream verb accepted any string, so an
    // identity that `bsc persona model` is documented to move "everywhere it is placed" could not name
    // a local model at all — the one gap between "personas are the launch primitive" and "the platform
    // runs on any model". The plumbing below was already there: `streamPaneWiring` derives
    // `provider = bsc-agent` for any model outside the tier registry.
    let mut unverified: Option<String> = None;
    if let Some(t) = tier {
        match llm::cli::verify_model(t, None) {
            llm::cli::ModelVerdict::Tier | llm::cli::ModelVerdict::Installed => {}
            // Refused with what this machine HAS, which is the actionable half — a typo is the failure
            // this check exists to catch, and it is only catchable against the real installed list.
            llm::cli::ModelVerdict::Unknown(installed) => {
                let have = if installed.is_empty() {
                    "the local runtime has no models installed".to_string()
                } else {
                    format!("installed locally: {}", installed.join(" | "))
                };
                return Err(format!(
                    "{prog} model: '{t}' is neither a Claude tier nor a model this machine has.\n                       tiers: {}\n  {have}\n                       (or `{prog} model {id} --clear` to launch on Claude Code's own default)",
                    bsc_util::model_id_list()
                ));
            }
            // NOT a refusal. Ollama being down is a normal state on a Claude-only machine, and refusing
            // to write a config because a daemon is asleep would break the verb exactly when someone is
            // setting a machine up. Say so and proceed; a wrong name then fails at launch, which is
            // where it would have failed anyway.
            llm::cli::ModelVerdict::Unverifiable(why) => unverified = Some(why),
        }
    }

    let dir = store_dir(args, prog)?;
    let store = bsc_json_store::Store::new(dir, SPEC.noun);
    let raw = store
        .get(id)?
        .ok_or_else(|| format!("{prog} model: no persona '{id}' (list them with `{prog} list`)"))?;
    let mut v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("{prog} model: persona '{id}' is not valid JSON: {e}"))?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| format!("{prog} model: persona '{id}' is not a JSON object"))?;
    match tier {
        // Cleared by REMOVING the key rather than writing `""`: an empty string is a value the app
        // would have to special-case everywhere it reads one, and "no model" is genuinely the absence
        // of the field — which is how every persona that never set one is already stored.
        None => { obj.remove("model"); }
        Some(t) => { obj.insert("model".into(), serde_json::Value::String(t.to_string())); }
    }
    let out = serde_json::to_string(&v).map_err(|e| format!("{prog} model: {e}"))?;
    store.set(id, &out)?;
    println!("{out}");
    if let Some(why) = unverified {
        // To STDERR: the write succeeded, and a caller piping `--json` into something must not have a
        // warning land in the middle of its payload.
        eprintln!(
            "{prog} model: stored, but could not verify '{}' against the local runtime ({why}).\n               If that name is wrong the session will fail at launch — check with `bsc llm status`.",
            tier.unwrap_or_default()
        );
    }
    Ok(())
}

/// `bsc persona use <paneId> <personaId>` — run a pane as a different persona.
///
/// ## Why this cannot be answered here
/// The assignment lives in the app's `panePersonas`, not on disk: the persona STORE is a file store
/// this CLI owns, but which pane runs as which persona is frontend state. So the verb rides
/// [`bsc_appchan`] — the one `bsc`→app channel, shared with `bsc shot` / `bsc navigate` / `bsc fleet`
/// — rather than growing a second transport.
///
/// ## What is checked here, and what is not
/// The persona id is resolved against the STORE here, before anything is sent, so a typo cannot reach
/// the app and cannot kill a session on its way to failing. BUSY is deliberately NOT checked here:
/// liveness lives in the app's `PtyState`, and a second opinion computed from this side is exactly how
/// `list` and `wake` would come to disagree about what is running.
fn use_pane(args: &[String], prog: &str) -> Result<(), String> {
    let mut pane = String::new();
    let mut persona = String::new();
    let mut relaunch = true;
    let mut force = false;
    let mut json = false;
    let mut pretty = false;
    let mut timeout_ms: i64 = DEFAULT_TIMEOUT_MS;

    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--no-relaunch" => relaunch = false,
            "--force" => force = true,
            "--json" => json = true,
            "--pretty" => pretty = true,
            "--timeout" => {
                let v = it.next().ok_or("--timeout needs a value")?;
                timeout_ms = v.parse().map_err(|_| format!("--timeout: not a number: {v}"))?;
            }
            // Consumed by `store_dir` below, which re-reads the raw args — skipped here so it is not
            // mistaken for the pane id, and so `use` resolves the same store every other verb does.
            "--dir" => { it.next().ok_or("--dir needs a value")?; }
            other if other.starts_with("--") => return Err(format!("{prog} use: unknown flag {other}")),
            other if pane.is_empty() => pane = other.to_string(),
            other if persona.is_empty() => persona = other.to_string(),
            other => return Err(format!("{prog} use: unexpected argument {other}")),
        }
    }
    if pane.trim().is_empty() || persona.trim().is_empty() {
        return Err(format!("{prog} use: needs <paneId> and <personaId>"));
    }

    // Resolve the persona BEFORE the request goes anywhere: the app relaunches the pane to apply it,
    // and a typo that got that far would kill a session on its way to an error.
    let dir = store_dir(args, prog)?;
    let store = bsc_json_store::Store::new(dir, SPEC.noun);
    if store.get(persona.trim()).ok().flatten().is_none() {
        // `Store::list` returns the record BODIES, not the ids — printing it raw dumped every persona's
        // full JSON into the error, which is how this was caught. Pull the id out of each.
        let mut known: Vec<String> = store
            .list()
            .iter()
            .filter_map(|json| {
                serde_json::from_str::<serde_json::Value>(json)
                    .ok()?
                    .get("id")?
                    .as_str()
                    .map(str::to_string)
            })
            .collect();
        known.sort();
        let names = if known.is_empty() {
            "the persona store is empty".to_string()
        } else {
            format!("known: {}", known.join(", "))
        };
        return Err(format!("{prog} use: no persona '{}' — {names}", persona.trim()));
    }

    let req = crate::UseRequest {
        pane_id: pane.trim().to_string(),
        persona_id: persona.trim().to_string(),
        relaunch,
        force,
    };

    let chan = bsc_appchan::chan_dir()?;
    let now = bsc_util::now_ms();
    let _ = bsc_appchan::sweep_stale(&chan, now, STALE_MS);
    let id = bsc_appchan::new_id(now);
    bsc_appchan::write_request(&chan, &id, crate::USE_KIND, now, &req)?;

    let reply = bsc_appchan::poll_reply(&chan, &id, timeout_ms, POLL_INTERVAL_MS, || {
        format!(
            "timed out after {timeout_ms}ms waiting for the app to answer.\n\
             The request is at {}.\n\
             Is the desktop app running? A pane's persona lives in its store — `bsc` cannot set it alone.",
            bsc_appchan::request_path(&chan, &id).display()
        )
    })?;
    if let Some(e) = reply.error {
        return Err(format!("{prog} use: {e}"));
    }
    let res: crate::UseResult =
        serde_json::from_value(reply.payload).map_err(|e| format!("{prog} use: malformed reply: {e}"))?;

    if json || pretty {
        let out = if pretty {
            serde_json::to_string_pretty(&res)
        } else {
            serde_json::to_string(&res)
        };
        println!("{}", out.map_err(|e| e.to_string())?);
    } else {
        let was = res.previous.as_deref().unwrap_or("(none)");
        println!("{} — {} → {}", res.pane_id, was, res.persona_id);
        // Say which happened, every time: "set it and relaunched" and "set it for next time" are very
        // different outcomes, and a caller that guesses wrong debugs the wrong thing.
        println!(
            "{}",
            if res.relaunched {
                "relaunched — the new persona is in effect"
            } else {
                "not relaunched — it applies at the next launch"
            }
        );
    }
    Ok(())

}

/// `bsc persona whatami` — what the calling session is running as.
///
/// ## Why a session cannot answer this itself
/// Every session carries `$BSC_AUDIT_PANE`, so it knows its own pane id — but nothing carries the
/// ROLE or the PERSONA. Those live in the app's `paneRoles` / `panePersonas`, which is frontend
/// state, so the answer has to come from the app. This is the READ beside `use`'s write, on the same
/// [`bsc_appchan`] transport.
///
/// ## Why it matters to the agent, not just the user
/// A worker and a director have different capability floors, different git/gh permissions and
/// different protocols. Without this an agent has to INFER its role from its kickoff prose, which is
/// exactly the kind of guess that is confidently wrong.
fn whatami(args: &[String], prog: &str) -> Result<(), String> {
    let mut pane: Option<String> = None;
    let mut json = false;
    let mut pretty = false;
    let mut timeout_ms: i64 = DEFAULT_TIMEOUT_MS;

    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => json = true,
            "--pretty" => pretty = true,
            "--pane" => pane = Some(it.next().ok_or("--pane needs a value")?.clone()),
            "--timeout" => {
                let v = it.next().ok_or("--timeout needs a value")?;
                timeout_ms = v.parse().map_err(|_| format!("--timeout: not a number: {v}"))?;
            }
            "--dir" => { it.next().ok_or("--dir needs a value")?; }
            other if other.starts_with("--") => return Err(format!("{prog} whatami: unknown flag {other}")),
            other if pane.is_none() => pane = Some(other.to_string()),
            other => return Err(format!("{prog} whatami: unexpected argument {other}")),
        }
    }

    // The pane a session is running in. Every session gets this, so an agent can just run
    // `bsc persona whatami` without knowing its own id.
    let pane = pane
        .or_else(|| std::env::var("BSC_AUDIT_PANE").ok())
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            // Said plainly rather than guessed: an empty or invented answer to "what am I" is worse
            // than none, because the whole point is to stop an agent inferring its own role.
            format!(
                "{prog} whatami: no pane to describe — $BSC_AUDIT_PANE is not set, so this is not \
                 running inside a session. Pass --pane <paneId> to ask about one."
            )
        })?;

    let req = crate::WhatamiRequest { pane_id: pane.clone() };

    let chan = bsc_appchan::chan_dir()?;
    let now = bsc_util::now_ms();
    let _ = bsc_appchan::sweep_stale(&chan, now, STALE_MS);
    let id = bsc_appchan::new_id(now);
    bsc_appchan::write_request(&chan, &id, crate::WHATAMI_KIND, now, &req)?;

    let reply = bsc_appchan::poll_reply(&chan, &id, timeout_ms, POLL_INTERVAL_MS, || {
        format!(
            "timed out after {timeout_ms}ms waiting for the app to answer.\n\
             The request is at {}.\n\
             Is the desktop app running? A pane's identity lives in its store — `bsc` cannot read it alone.",
            bsc_appchan::request_path(&chan, &id).display()
        )
    })?;
    if let Some(e) = reply.error {
        return Err(format!("{prog} whatami: {e}"));
    }
    let res: crate::WhatamiResult = serde_json::from_value(reply.payload)
        .map_err(|e| format!("{prog} whatami: malformed reply: {e}"))?;

    if json || pretty {
        let out = if pretty {
            serde_json::to_string_pretty(&res)
        } else {
            serde_json::to_string(&res)
        };
        println!("{}", out.map_err(|e| e.to_string())?);
        return Ok(());
    }

    println!("pane    {}", res.pane_id);
    // Role first: it is the field that answers "what am I allowed to do", which is the reason this
    // verb exists. A pane with neither is a plain interactive console, and saying so beats a blank.
    match (&res.role, &res.persona_id) {
        (None, None) => println!("        no role or persona — an unconfigured console session"),
        _ => {
            println!("role    {}", res.role.as_deref().unwrap_or("(none)"));
            match (&res.persona_id, &res.persona_name) {
                (Some(id), Some(name)) => println!("persona {name} ({id})"),
                (Some(id), None) => println!("persona {id}"),
                _ => println!("persona (none)"),
            }
        }
    }
    if let Some(p) = res.start_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        let first = p.lines().next().unwrap_or("").trim();
        // One line: the full start prompt can be pages, and this is an identity check, not a dump.
        println!("brief   {}{}", first, if p.lines().count() > 1 { " …" } else { "" });
    }
    // WHERE THE USER IS. Last because it is the only line that changes between two runs a minute
    // apart — identity is stable, the view is not, and putting the moving part at the bottom means a
    // session re-reading this sees the change where it is looking.
    if let Some(v) = res.viewing.as_deref().filter(|v| !v.trim().is_empty()) {
        println!("viewing {v}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_the_persona_store_with_role_and_model_in_the_lean_list() {
        assert_eq!(SPEC.noun, "persona");
        assert_eq!(SPEC.dir_env, "BSC_PERSONA_DIR");
        assert_eq!(SPEC.dir_segment, "personas");
        // `model` is projected so "which personas run cheap" is ONE read rather than a `get` each.
        assert_eq!(SPEC.meta_fields, &["id", "name", "role", "model"]);
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

    /// The real drift, end to end: a stored floor that both OFFERS a retired verb and HIDES a granted
    /// one, reconciled in one call — and the behavioural fields left alone.
    #[test]
    fn reseed_removes_a_retired_verb_and_restores_a_granted_one() {
        let dir = scratch("pkg-reseed-verb");
        with_packaged_named(
            "reseedverb",
            "p-pkg",
            serde_json::json!({"ui": "write", "allow": ["bsc graph", "bsc session reply"]}),
            || {
                // Exactly the shape found on the live store: `bsc loop watch` was retired from the
                // shipped floor and never removed here; `bsc session reply` was added and never arrived.
                store_at(&dir)
                    .set(
                        "p-pkg",
                        r#"{"id":"p-pkg","name":"Renamed By Hand","model":"haiku","floor":{"ui":"write","allow":["bsc graph","bsc loop watch"]}}"#,
                    )
                    .unwrap();
                reseed(&["reseed".to_string()], &dir, "bsc persona").unwrap();

                let after: serde_json::Value =
                    serde_json::from_str(&store_at(&dir).get("p-pkg").unwrap().unwrap()).unwrap();
                let allow = after["floor"]["allow"].as_array().unwrap();
                let allow: Vec<&str> = allow.iter().filter_map(serde_json::Value::as_str).collect();
                assert!(!allow.contains(&"bsc loop watch"), "the retired verb survived: {allow:?}");
                assert!(allow.contains(&"bsc session reply"), "the granted verb did not arrive: {allow:?}");
                // FLOOR ONLY. A permissions reconcile that silently reverted a rename or a model tier
                // would be a worse bug than the one it fixes.
                assert_eq!(after["name"], "Renamed By Hand");
                assert_eq!(after["model"], "haiku");
            },
        );
    }

    /// `--dry-run` reports and writes nothing — the store is untouched.
    #[test]
    fn reseed_dry_run_changes_nothing() {
        let dir = scratch("pkg-reseed-dry");
        with_packaged_named("reseeddry", "p-pkg", serde_json::json!({"ui": "write", "allow": ["bsc graph"]}), || {
            let stored = r#"{"id":"p-pkg","floor":{"ui":"write","allow":["bsc graph","bsc loop watch"]}}"#;
            store_at(&dir).set("p-pkg", stored).unwrap();
            reseed(&["reseed".to_string(), "--dry-run".to_string()], &dir, "bsc persona").unwrap();
            assert_eq!(store_at(&dir).get("p-pkg").unwrap().unwrap(), stored);
        });
    }

    /// A BUILT-IN's ceiling is what the app SHIPS, not the first thing ever written to the store.
    ///
    /// This is the bug that pinned six of eighteen packaged personas. `stored_floor` used to
    /// short-circuit the packaged floor, so once a record existed its own value became the permanent
    /// ceiling: re-writing the app's own shipped definition was refused as a widening, and no verb
    /// existed to break the cycle. `persona-librarian` was left offering five retired `bsc loop *`
    /// verbs while hiding `bsc session reply`, which its charter instructs it to use.
    #[test]
    fn a_shipped_persona_can_be_restored_to_the_floor_it_ships_with() {
        let dir = scratch("pkg-reseed");
        with_packaged_named("reseed", "p-pkg", serde_json::json!({"ui": "write", "allow": ["bsc ui", "bsc graph"]}), || {
            // Narrowed by hand — still allowed, that is the whole point of the clamp.
            validate(&dir, r#"{"id":"p-pkg","floor":{"ui":"read","allow":["bsc ui"]}}"#).unwrap();
            store_at(&dir)
                .set("p-pkg", r#"{"id":"p-pkg","floor":{"ui":"read","allow":["bsc ui"]}}"#)
                .unwrap();
            // And now BACK to what shipped. Under the old ordering this was refused, which is what
            // made the narrowing a trap rather than a setting.
            validate(&dir, r#"{"id":"p-pkg","floor":{"ui":"write","allow":["bsc ui","bsc graph"]}}"#).unwrap();
        });
    }

    /// Restoring is not widening: the packaged floor is a ceiling, and it still holds.
    #[test]
    fn a_shipped_persona_still_cannot_exceed_the_floor_it_ships_with() {
        let dir = scratch("pkg-ceiling");
        with_packaged_named("ceiling", "p-pkg", serde_json::json!({"ui": "write", "allow": ["bsc ui"]}), || {
            store_at(&dir)
                .set("p-pkg", r#"{"id":"p-pkg","floor":{"ui":"write","allow":["bsc ui"]}}"#)
                .unwrap();
            // A surface the app never shipped it with — this is how the retired `bsc loop *` entries
            // are removed rather than blessed by a reseed.
            let err = validate(&dir, r#"{"id":"p-pkg","floor":{"ui":"write","allow":["bsc ui","bsc loop watch"]}}"#)
                .unwrap_err();
            assert!(err.contains("bsc loop watch"), "{err}");
            assert!(err.contains("PACKAGED floor"), "the refusal must name the ceiling it used: {err}");
            // And an axis the app never granted.
            let err = validate(&dir, r#"{"id":"p-pkg","floor":{"code":"write","allow":["bsc ui"]}}"#).unwrap_err();
            assert!(err.contains("code"), "{err}");
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

    // ── `model` — the tier verb (a-model-cannot-be-chosen-from-the-command-surface) ───────────────

    /// The point of the verb: one field moves and the expensive ones do not. `set` is a whole-record
    /// upsert, so the alternative is a read-edit-write round trip that drops whatever it forgets.
    #[test]
    fn model_sets_the_tier_and_leaves_every_other_field_byte_identical() {
        let dir = scratch("model-set");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store
            .set(
                "persona-worker",
                r#"{"id":"persona-worker","name":"Worker","role":"worker","startPrompt":"long prose","skills":["a","b"],"unknownFutureField":42}"#,
            )
            .unwrap();

        run(vec!["model".into(), "persona-worker".into(), "haiku-4.5".into(), "--dir".into(), dir.to_string_lossy().into_owned()], "bsc persona").unwrap();

        let v: serde_json::Value = serde_json::from_str(&store.get("persona-worker").unwrap().unwrap()).unwrap();
        assert_eq!(v["model"], "haiku-4.5");
        assert_eq!(v["id"], "persona-worker");
        assert_eq!(v["name"], "Worker");
        assert_eq!(v["role"], "worker");
        assert_eq!(v["startPrompt"], "long prose");
        assert_eq!(v["skills"], serde_json::json!(["a", "b"]));
        assert_eq!(v["unknownFutureField"], 42, "a field this crate has no model for must survive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `--clear` REMOVES the key rather than writing `""`. Absence is what "no model" already looks
    /// like for every persona that never set one, and an empty string would be a second spelling of
    /// the same state that every reader would have to know about.
    #[test]
    fn model_clear_removes_the_key_rather_than_emptying_it() {
        let dir = scratch("model-clear");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store.set("p1", r#"{"id":"p1","name":"One","role":"worker","model":"opus-4.5"}"#).unwrap();

        run(vec!["model".into(), "p1".into(), "--clear".into(), "--dir".into(), dir.to_string_lossy().into_owned()], "bsc persona").unwrap();

        let v: serde_json::Value = serde_json::from_str(&store.get("p1").unwrap().unwrap()).unwrap();
        assert!(v.get("model").is_none(), "cleared means ABSENT, not empty: {v}");
        assert_eq!(v["name"], "One", "clearing one field touches nothing else");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The refusal is the whole reason the verb validates. An unrecognized tier is NOT an error at
    /// launch — no `--model` is injected and the session runs on the harness default — so a stored
    /// typo would read as the tier the user named and bill as something else entirely.
    #[test]
    fn model_refuses_an_unknown_tier_and_writes_nothing() {
        let dir = scratch("model-bad");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store.set("p1", r#"{"id":"p1","name":"One","role":"worker"}"#).unwrap();
        let d = || dir.to_string_lossy().into_owned();

        for junk in ["haiku", "sonnet-4", "gpt-4o", "OPUS-4.5"] {
            let err = run(vec!["model".into(), "p1".into(), junk.into(), "--dir".into(), d()], "bsc persona").unwrap_err();
            assert!(err.contains(junk), "the error names what was passed: {err}");
            // ...and what could have been passed instead — a refusal that only says "no" is a dead end.
            for tier in bsc_util::model_ids() {
                assert!(err.contains(tier), "the error names the tier {tier}: {err}");
            }
        }
        // An unknown persona is an error, not a create — `set` is the verb that creates.
        let err = run(vec!["model".into(), "ghost".into(), "haiku-4.5".into(), "--dir".into(), d()], "bsc persona").unwrap_err();
        assert!(err.contains("ghost"), "{err}");
        // A tier with no persona, and a persona with no tier, are both usage errors.
        assert!(run(vec!["model".into(), "p1".into(), "--dir".into(), d()], "bsc persona").is_err());
        assert!(run(vec!["model".into(), "--dir".into(), d()], "bsc persona").is_err());
        // `--clear` and a tier together are ambiguous — refused rather than one silently winning.
        assert!(run(vec!["model".into(), "p1".into(), "haiku-4.5".into(), "--clear".into(), "--dir".into(), d()], "bsc persona").is_err());

        // Nothing any refusal touched was written.
        let v: serde_json::Value = serde_json::from_str(&store.get("p1").unwrap().unwrap()).unwrap();
        assert!(v.get("model").is_none(), "a refusal writes nothing: {v}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every tier the registry offers is settable. This is the property that keeps the CLI and the
    /// launch in step: what one accepts, the other can map to a `--model` alias.
    #[test]
    fn every_registry_tier_is_settable() {
        let dir = scratch("model-all");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store.set("p1", r#"{"id":"p1","name":"One","role":"worker"}"#).unwrap();
        for tier in bsc_util::model_ids() {
            run(vec!["model".into(), "p1".into(), tier.into(), "--dir".into(), dir.to_string_lossy().into_owned()], "bsc persona").unwrap();
            let v: serde_json::Value = serde_json::from_str(&store.get("p1").unwrap().unwrap()).unwrap();
            assert_eq!(v["model"], tier);
            assert!(bsc_util::model_alias(tier).is_some(), "a settable tier must map to a launch alias");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A BUILT-IN persona is settable here, unlike `rename`/`remove`. Those are guarded because a
    /// packaged persona is the system's own identity; a model is not identity, the library reconcile
    /// keeps the edit, and the system sessions (designer, librarian, architect, …) are exactly the
    /// ones worth running cheap while testing.
    #[test]
    fn model_is_settable_on_a_builtin_unlike_rename() {
        let dir = scratch("model-builtin");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store.set("persona-designer", r#"{"id":"persona-designer","name":"Designer","role":"designer","builtin":true}"#).unwrap();
        let d = || dir.to_string_lossy().into_owned();

        run(vec!["model".into(), "persona-designer".into(), "haiku-4.5".into(), "--dir".into(), d()], "bsc persona").unwrap();
        let v: serde_json::Value = serde_json::from_str(&store.get("persona-designer").unwrap().unwrap()).unwrap();
        assert_eq!(v["model"], "haiku-4.5");
        assert_eq!(v["builtin"], true, "the packaged identity is untouched");
        // ...while renaming the same record is still refused.
        assert!(run(vec!["rename".into(), "persona-designer".into(), "Mine".into(), "--dir".into(), d()], "bsc persona").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_help_still_routes_to_help_rather_than_setting_a_persona_called_help() {
        let dir = scratch("model-help");
        run(vec!["model".into(), "help".into(), "--dir".into(), dir.to_string_lossy().into_owned()], "bsc persona").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc persona", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove", "use", "whatami", "model"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // The tier vocabulary is rendered INTO the help, so `bsc persona model help` answers "which
        // tiers" without a second lookup — and cannot name a tier the launch would not accept.
        let m = bsc_cli_util::help_for("bsc persona", TAGLINE, COMMANDS, "model");
        for tier in bsc_util::model_ids() {
            assert!(m.contains(tier), "the model help names {tier}");
        }
        let one = bsc_cli_util::help_for("bsc persona", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc persona set"));
        assert!(one.contains("stdin"));
        assert!(bsc_cli_util::help_for("bsc persona", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }

    // ── `set` carries a builtin's `proseSeal`/`replacedProse` forward (#172 follow-up) ─────────────
    //
    // `--file` (over `with_scratch`) rather than piped stdin — it is the same channel a restricted
    // studio session must use, and the one this crate's own doc comments point to for exactly this
    // reason: driving real stdin from a test is neither reliable nor how a caged session gets here.

    fn set_via_file(dir: &std::path::Path, payload: &str) -> Result<(), String> {
        let scratch_dir = std::env::temp_dir().join(format!("bsc-persona-set-scratch-{}-{:p}", std::process::id(), payload));
        std::fs::create_dir_all(&scratch_dir).unwrap();
        std::fs::write(scratch_dir.join("payload.json"), payload).unwrap();
        let out = bsc_cli_util::with_scratch(Some(&scratch_dir.to_string_lossy()), || {
            set_persona(&["set".into(), "--file".into(), "payload.json".into()], dir, "bsc persona")
        });
        let _ = std::fs::remove_dir_all(&scratch_dir);
        out
    }

    /// The bug behind `bsc request 172`: a `get` → edit → `set` round trip on a BUILTIN's prose, with
    /// the payload omitting `proseSeal`/`replacedProse` exactly as `bsc persona get`'s own output
    /// would if a caller forgot to paste them back (or, per the request's own instructions, was told
    /// to omit them and "let the store recompute them" — the store does not, so this is what makes
    /// that instruction true rather than a trap). The old seal must survive the write UNCHANGED, not
    /// be dropped and not be recomputed from the new content.
    #[test]
    fn set_carries_an_existing_prosseal_forward_when_the_payload_omits_it() {
        let dir = scratch("seal-carry");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store
            .set(
                "persona-worker",
                r#"{"id":"persona-worker","name":"Worker","role":"worker","builtin":true,
                    "startPrompt":"old packaged prose",
                    "proseSeal":{"startPrompt":"oldhash1","blurb":"oldhash2","responsibilities":"oldhash3"}}"#,
            )
            .unwrap();

        // The realistic shape: `bsc persona get` verbatim, with just `startPrompt` edited — no
        // `proseSeal` key at all, because nothing outside the frontend computes one.
        set_via_file(
            &dir,
            r#"{"id":"persona-worker","name":"Worker","role":"worker","builtin":true,
                "startPrompt":"NEW prose with the logging/perf section added"}"#,
        )
        .unwrap();

        let v: serde_json::Value = serde_json::from_str(&store.get("persona-worker").unwrap().unwrap()).unwrap();
        assert_eq!(v["startPrompt"], "NEW prose with the logging/perf section added", "the edit itself must land");
        assert_eq!(
            v["proseSeal"],
            serde_json::json!({"startPrompt": "oldhash1", "blurb": "oldhash2", "responsibilities": "oldhash3"}),
            "the OLD seal must survive untouched — recomputing or dropping it is what let reconcilePersonas \
             read this as an unsealed bootstrap edit and revert it (see the fn doc comment)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `replacedProse` gets the identical treatment, and independently of `proseSeal` — a payload can
    /// omit one and carry the other explicitly.
    #[test]
    fn set_carries_replaced_prose_forward_independently_of_prose_seal() {
        let dir = scratch("seal-carry-replaced");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store
            .set(
                "persona-worker",
                r#"{"id":"persona-worker","builtin":true,"startPrompt":"current",
                    "proseSeal":{"startPrompt":"h1"},
                    "replacedProse":{"startPrompt":"whatever an earlier bootstrap displaced"}}"#,
            )
            .unwrap();

        set_via_file(&dir, r#"{"id":"persona-worker","builtin":true,"startPrompt":"edited again"}"#).unwrap();

        let v: serde_json::Value = serde_json::from_str(&store.get("persona-worker").unwrap().unwrap()).unwrap();
        assert_eq!(v["replacedProse"], serde_json::json!({"startPrompt": "whatever an earlier bootstrap displaced"}));
    }

    /// An explicit value in the payload — including a deliberate `null` clear — always wins. Carrying
    /// forward is only for the OMITTED case; a caller who does state the field is never overridden.
    #[test]
    fn set_never_overrides_an_explicitly_stated_prose_seal() {
        let dir = scratch("seal-explicit");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store.set("persona-worker", r#"{"id":"persona-worker","builtin":true,"proseSeal":{"startPrompt":"old"}}"#).unwrap();

        set_via_file(
            &dir,
            r#"{"id":"persona-worker","builtin":true,"startPrompt":"x","proseSeal":{"startPrompt":"NEW-EXPLICIT"}}"#,
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&store.get("persona-worker").unwrap().unwrap()).unwrap();
        assert_eq!(v["proseSeal"], serde_json::json!({"startPrompt": "NEW-EXPLICIT"}));

        // A literal `null` is a stated value too (a deliberate clear) — never backfilled.
        set_via_file(&dir, r#"{"id":"persona-worker","builtin":true,"proseSeal":null}"#).unwrap();
        let v: serde_json::Value = serde_json::from_str(&store.get("persona-worker").unwrap().unwrap()).unwrap();
        assert!(v["proseSeal"].is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A brand-new persona (nothing stored yet) has no existing record to carry anything forward from
    /// — `set` must not error just because `store.get` came back empty.
    #[test]
    fn set_creates_a_new_persona_with_no_existing_record_to_carry_forward() {
        let dir = scratch("seal-new");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        set_via_file(&dir, r#"{"id":"persona-new","name":"New","role":"reviewer"}"#).unwrap();
        let v: serde_json::Value = serde_json::from_str(&store.get("persona-new").unwrap().unwrap()).unwrap();
        assert_eq!(v["name"], "New");
        assert!(v.get("proseSeal").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A user-authored persona (never sealed) round-trips exactly as it always did: no `proseSeal` in,
    /// none appears out.
    #[test]
    fn set_leaves_an_unsealed_user_persona_unaffected() {
        let dir = scratch("seal-user");
        let store = bsc_json_store::Store::new(dir.clone(), "persona");
        store.set("p1", r#"{"id":"p1","name":"One","role":"reviewer","startPrompt":"a"}"#).unwrap();
        set_via_file(&dir, r#"{"id":"p1","name":"One","role":"reviewer","startPrompt":"b"}"#).unwrap();
        let v: serde_json::Value = serde_json::from_str(&store.get("p1").unwrap().unwrap()).unwrap();
        assert_eq!(v["startPrompt"], "b");
        assert!(v.get("proseSeal").is_none());
    }

    /// The floor clamp still runs FIRST — carrying the seal forward must not become a backdoor around
    /// the narrow-only guard the batch validator enforces.
    #[test]
    fn set_still_refuses_a_widening_floor_even_with_a_sealed_prose_payload() {
        isolated(|| {
            let dir = scratch("seal-floor");
            let store = bsc_json_store::Store::new(dir.clone(), "persona");
            store
                .set(
                    "p1",
                    r#"{"id":"p1","role":"designer","floor":{"github":"none","git":"none","code":"none","net":"none","ui":"read"},
                        "proseSeal":{"startPrompt":"h"}}"#,
                )
                .unwrap();
            let err = set_via_file(
                &dir,
                r#"{"id":"p1","role":"designer","floor":{"github":"none","git":"none","code":"none","net":"none","ui":"write"}}"#,
            )
            .unwrap_err();
            assert!(err.contains("would WIDEN"), "{err}");
            let v: serde_json::Value = serde_json::from_str(&store.get("p1").unwrap().unwrap()).unwrap();
            assert_eq!(v["floor"]["ui"], "read", "the rejected batch must not have written anything");
        });
    }

    // ── `bsc persona use` — the checks that happen BEFORE the app is ever contacted ────────────────
    //
    // Everything here is deliberately reachable without a running app: the point of validating the
    // persona id CLI-side is that a typo must not travel to the app, which would relaunch a pane on its
    // way to failing. A test that needed the app could not pin that.

    // ── `bsc persona whatami` (a-session-can-ask-what-it-is) ─────────────────────────────────────

    #[test]
    fn whatami_rejects_an_unknown_flag() {
        let e = whatami(&["whatami".into(), "--wat".into()], "bsc persona").unwrap_err();
        assert!(e.contains("unknown flag --wat"), "{e}");
    }

    /// A BARE WORD IS NOT A FLAG, and the refusal has to say so.
    ///
    /// `set` was the only one of persona's four subcommand parsers without a `starts_with("--")`
    /// guard, so `bsc persona set foo` answered "unknown flag 'foo'" about something that is not a
    /// flag, while `model`/`use`/`whatami` beside it would have taken it as a positional. It still
    /// REFUSES — `set` reads its persona from stdin and has no positionals, so swallowing a typo
    /// silently would be worse — but it names what it found.
    #[test]
    fn set_refuses_a_bare_argument_without_calling_it_a_flag() {
        let dir = scratch("set-bare");
        let e = set_persona(&["set".into(), "foo".into()], &dir, "bsc persona").unwrap_err();
        assert!(e.contains("unexpected argument 'foo'"), "{e}");
        assert!(!e.contains("unknown flag"), "a bare word is not a flag: {e}");
        // A real unknown FLAG still reads as one.
        let e = set_persona(&["set".into(), "--wat".into()], &dir, "bsc persona").unwrap_err();
        assert!(e.contains("unknown flag '--wat'"), "{e}");
    }

    #[test]
    fn whatami_with_no_pane_to_infer_says_so_rather_than_guessing() {
        // The whole point of the verb is that nothing has to guess what a session is, so guessing
        // HERE would be self-defeating. Run outside a session it must say it has no pane.
        // Same reason `PACKAGED_ENV_LOCK` exists: `cargo test` threads these inside one binary, so a
        // process-global env var set by one thread is read by another. (nextest forks per test and
        // would not need it — but the gate runs both.)
        let _guard = PACKAGED_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("BSC_AUDIT_PANE").ok();
        std::env::remove_var("BSC_AUDIT_PANE");
        let e = whatami(&["whatami".into()], "bsc persona").unwrap_err();
        assert!(e.contains("no pane to describe"), "{e}");
        assert!(e.contains("--pane"), "it must say how to ask anyway: {e}");
        if let Some(p) = prev {
            std::env::set_var("BSC_AUDIT_PANE", p);
        }
    }

    #[test]
    fn whatami_takes_the_pane_positionally_or_by_flag() {
        // Both spellings must reach the same place; a caller should not have to remember which.
        //
        // THIS TEST ASSERTS THE PANE RESOLVED, and nothing more. It used to call `unwrap_err()`, which
        // made it depend on something it is not about: `whatami` answers from the RUNNING APP, so with
        // no app the request times out (an Err) and with an app it succeeds (an Ok). The old assertion
        // only held in the first world, so the test failed for everyone with a dev app open — and
        // `tauri dev` watches the repo root, which the zero-install worktree convention puts every
        // `wt-*` inside, so editing Rust in a worktree restarts the app and the next gate there hits it.
        //
        // Either outcome proves what is being tested. What must NEVER appear is the refusal that says
        // no pane could be determined at all, because that is the one failure meaning the argument was
        // not read.
        for args in [
            vec!["whatami".to_string(), "demo:worker".to_string(), "--timeout".into(), "1".into()],
            vec!["whatami".to_string(), "--pane".into(), "demo:worker".into(), "--timeout".into(), "1".into()],
        ] {
            match whatami(&args, "bsc persona") {
                // The app answered: the pane resolved and a request completed.
                Ok(()) => {}
                // No app to answer: a transport failure still proves the pane resolved and a request
                // was SENT — as long as it is not the "no pane" refusal.
                Err(e) => assert!(!e.contains("no pane to describe"), "the pane should have resolved: {e}"),
            }
        }
    }

    #[test]
    fn use_needs_both_a_pane_and_a_persona() {
        let e = use_pane(&["use".into()], "bsc persona").unwrap_err();
        assert!(e.contains("needs <paneId> and <personaId>"), "{e}");
        let e = use_pane(&["use".into(), "demo:worker".into()], "bsc persona").unwrap_err();
        assert!(e.contains("needs <paneId> and <personaId>"), "{e}");
    }

    #[test]
    fn use_rejects_an_unknown_flag_rather_than_treating_it_as_a_pane() {
        let e = use_pane(&["use".into(), "--wat".into()], "bsc persona").unwrap_err();
        assert!(e.contains("unknown flag --wat"), "{e}");
    }

    #[test]
    fn use_refuses_an_unknown_persona_and_names_the_ones_that_exist() {
        let dir = scratch("use-unknown");
        let store = bsc_json_store::Store::new(dir.clone(), SPEC.noun);
        store.set("reviewer", r#"{"id":"reviewer","name":"Reviewer","role":"reviewer"}"#).unwrap();

        let e = use_pane(
            &["use".into(), "demo:worker".into(), "nope".into(), "--dir".into(), dir.display().to_string()],
            "bsc persona",
        )
        .unwrap_err();
        // Named, so a caller that typo'd does not have to run a second command to find out what is real.
        assert!(e.contains("no persona 'nope'"), "{e}");
        assert!(e.contains("reviewer"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn use_names_persona_ids_and_never_dumps_their_bodies() {
        // Caught by running it: `Store::list` yields record BODIES, so the refusal printed every
        // persona's whole JSON — start prompt and all — instead of a list of ids.
        let dir = scratch("use-ids");
        let store = bsc_json_store::Store::new(dir.clone(), SPEC.noun);
        store
            .set("reviewer", r#"{"id":"reviewer","name":"Reviewer","role":"reviewer","startPrompt":"SECRET-PROSE"}"#)
            .unwrap();

        let e = use_pane(
            &["use".into(), "demo:worker".into(), "nope".into(), "--dir".into(), dir.display().to_string()],
            "bsc persona",
        )
        .unwrap_err();
        assert!(e.contains("known: reviewer"), "{e}");
        assert!(!e.contains("SECRET-PROSE"), "the refusal must list ids, not record bodies: {e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn use_says_so_when_the_store_is_empty_rather_than_printing_an_empty_list() {
        let dir = scratch("use-empty");
        let e = use_pane(
            &["use".into(), "demo:worker".into(), "nope".into(), "--dir".into(), dir.display().to_string()],
            "bsc persona",
        )
        .unwrap_err();
        assert!(e.contains("the persona store is empty"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn use_is_in_the_help_catalog_with_its_flags() {
        let h = bsc_cli_util::help_for("bsc persona", TAGLINE, COMMANDS, "use");
        assert!(h.contains("--no-relaunch"), "{h}");
        assert!(h.contains("--force"), "{h}");
        // The relaunch is the surprising part of the verb, so the help has to lead with it.
        assert!(h.contains("RELAUNCHES"), "{h}");
    }

}

#[cfg(test)]
mod builtin_guard_tests {
    use super::*;

    fn store_with(dir: &std::path::Path, id: &str, builtin: bool) -> bsc_json_store::Store {
        let s = bsc_json_store::Store::new(dir.to_path_buf(), SPEC.noun);
        let body = serde_json::json!({ "id": id, "name": "X", "role": "designer", "builtin": builtin });
        s.set(id, &serde_json::to_string(&body).unwrap()).unwrap();
        s
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("bsc-persona-guard-{}-{tag}", std::process::id()))
    }

    /// A packaged persona is READ-ONLY from the CLI.
    ///
    /// THE BUG: `bsc persona remove persona-designer` deleted the running Design Studio's identity.
    /// The app store had always refused this (`removePersona` returns early on `builtin`); the CLI
    /// never learned, and the CLI is what an agent — or a user reading the help — actually drives.
    #[test]
    fn a_builtin_cannot_be_removed_or_renamed() {
        let dir = scratch("builtin");
        let s = store_with(&dir, "persona-designer", true);
        let e = refuse_if_builtin(&s, "persona-designer", "bsc persona", "remove").unwrap_err();
        assert!(e.contains("BUILT-IN"), "the refusal says why: {e}");
        assert!(e.contains("read-only"), "and what the rule is: {e}");
        assert!(
            refuse_if_builtin(&s, "persona-designer", "bsc persona", "rename").is_err(),
            "rename is an UPDATE to a system record and is refused the same way",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A user-authored persona is untouched — the guard must not become a wall around the store.
    #[test]
    fn a_user_persona_is_still_removable() {
        let dir = scratch("user");
        let s = store_with(&dir, "persona-mine", false);
        assert!(refuse_if_builtin(&s, "persona-mine", "bsc persona", "remove").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An ABSENT id passes the guard, so the verb itself reports "no such persona".
    ///
    /// Otherwise a typo would be answered with a lecture about built-ins, which is a worse error than
    /// the one it replaced.
    #[test]
    fn an_absent_persona_is_left_for_the_verb_to_report() {
        let dir = scratch("absent");
        let s = bsc_json_store::Store::new(dir.clone(), SPEC.noun);
        assert!(refuse_if_builtin(&s, "persona-nope", "bsc persona", "remove").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `set` stays OPEN to a builtin, and that is deliberate: `hydratePersonas` reconciles the
    /// packaged built-ins and pushes newly-seeded ones back through it, so refusing a builtin write
    /// the way `remove`/`rename` do would break the mechanism that RESTORES these records.
    ///
    /// Pinned BEHAVIORALLY rather than by grepping `run`'s source for the literal token `Some("set")`
    /// (the previous form of this test): `set` gained its OWN interception in #172's follow-up, to
    /// carry a builtin's `proseSeal`/`replacedProse` forward rather than dropping them (see
    /// `set_persona`'s doc comment) — a change that does not refuse anything, but would have failed
    /// the old text-matching assertion regardless. What this test actually needs to keep true is that
    /// a builtin persona is still WRITABLE end to end through the public `run` entrypoint.
    #[test]
    fn set_is_deliberately_not_guarded() {
        let dir = scratch("set-open");
        let s = store_with(&dir, "persona-designer", true);

        let scratch_dir = std::env::temp_dir().join(format!("bsc-persona-guard-set-scratch-{}", std::process::id()));
        std::fs::create_dir_all(&scratch_dir).unwrap();
        std::fs::write(
            scratch_dir.join("payload.json"),
            r#"{"id":"persona-designer","name":"Renamed via set","role":"designer","builtin":true}"#,
        )
        .unwrap();
        let result = bsc_cli_util::with_scratch(Some(&scratch_dir.to_string_lossy()), || {
            run(
                vec!["set".into(), "--file".into(), "payload.json".into(), "--dir".into(), dir.to_string_lossy().into_owned()],
                "bsc persona",
            )
        });
        let _ = std::fs::remove_dir_all(&scratch_dir);
        result.expect("a builtin persona must remain settable — reseeding depends on it");

        let v: serde_json::Value = serde_json::from_str(&s.get("persona-designer").unwrap().unwrap()).unwrap();
        assert_eq!(v["name"], "Renamed via set");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
