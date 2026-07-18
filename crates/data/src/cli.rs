//! The `bsc data` subcommand (#1877) — read/write a project's canonical **Data Model** + **Platform
//! Behavior Summary** in its per-project DuckDB store (#1446), and read the materialized **DataStore**
//! — the typed entity tables + lineage (#1717). The desktop app writes them; the **planner** reads
//! them at the UI-kickoff stage to drive data-driven screens (it can't query DuckDB directly, so this
//! CLI is its accessor — the #1325 pattern, mirroring `bsc plan` / `bsc skill`).
//!
//! Extracted from the old `bsc-data` binary so the unified `bsc` umbrella dispatches into it via
//! [`run`]; the legacy `bsc-data` shim also calls it. The store is located via `--db <path>` or the
//! `BSC_DATA_DB` env var (set per-session at launch). Reading is lean by default; `--json` emits
//! compact JSON and `--pretty` re-indents it.
//!
//! Help is per-command so a model loads only what it needs (#1762):
//!   bsc data help            # compact menu (the small "what commands exist" prompt)
//!   bsc data model help      # detailed help for ONE command
//!   bsc data <cmd> help      # same, after any command

use crate::{DataModel, DataStore, MetaStore, PlatformScan};
use bsc_cli_util::{emit, CmdDoc};
use std::path::{Path, PathBuf};

const TAGLINE: &str = "the per-project Data Model + Platform Behavior Summary + DataStore (#1446/#1717)";

/// The command catalog — drives the shared help system. One detailed `usage` block per top-level
/// command keeps the overview tiny; the multi-verb commands (`model`/`scan`/`connector`) document
/// their subcommands in their own usage blocks. Reading is lean TSV by default (`--json`/`--pretty`).
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "model",
        summary: "read/write the canonical Data Model",
        usage: "\
USAGE:
  bsc data model get                 # print {\"model\":<DataModel>,\"refined\":<bool>} (or null)
  bsc data model set [--refined]     # upsert the DataModel JSON on stdin

Needs a store (--db <path> or $BSC_DATA_DB).",
    },
    CmdDoc {
        name: "shapes",
        summary: "infer each entity's ideal data shape from the Data Model (#2478)",
        usage: "\
USAGE:
  bsc data shapes [<entity>] [--json|--pretty]

Derives every entity's ideal DATA SHAPE from the canonical Data Model's structure — so a layout is
picked mechanically instead of by judging the taxonomy by hand. With <entity>, prints just that one.

Shapes are the six-shape vocabulary (#2475): list · linked-list · tree · graph · table · key-value.
The slugs are byte-identical to the picker's, so the output feeds straight into it:

  bsc data shapes                      # what shape IS each entity's data
  bsc ui shapes <shape>                # which kit components ideally render that shape

WHAT IT READS: a `ref` field IS a foreign key — its `ref` names the target entity. A SELF-referencing
ref (a ref back to its own entity) is what distinguishes a hierarchy from a flat collection.

HEURISTICS: self-referencing ref → tree (graph when several self-refs admit multiple parents) ·
a next/prev self-ref or a numeric sequence column → linked-list · a join table (nearly all refs, ≥2
distinct targets) or a join-heavy entity (≥3 targets) → graph · a name column + a value column →
key-value · otherwise a plain collection → table when column-dense, list when lean. Every entity
also offers key-value as its single-record DETAIL view.

Each entity gets RANKED CANDIDATES (strongest first), each with a `confidence`
(strong|likely|possible) and the `reason` it fired — never one guessed answer. The schema genuinely
cannot tell a tree from a graph when an item MAY have several parents, so both are offered and the
planner asks. Read-only; needs a store (--db <path> or $BSC_DATA_DB).",
    },
    CmdDoc {
        name: "scan",
        summary: "read/write the Platform Behavior Summary (PlatformScan)",
        usage: "\
USAGE:
  bsc data scan get                  # print the PlatformScan JSON (or null)
  bsc data scan set                  # upsert the PlatformScan JSON on stdin

Needs a store (--db <path> or $BSC_DATA_DB).",
    },
    CmdDoc {
        name: "tables",
        summary: "list entity tables + row counts",
        usage: "\
USAGE:
  bsc data tables [--json|--pretty]

Lists every entity table in the materialized DataStore with its row count.",
    },
    CmdDoc {
        name: "rows",
        summary: "sample rows from an entity table (default 20)",
        usage: "\
USAGE:
  bsc data rows <entity> [--limit N] [--json|--pretty]

A small sample of rows from <entity> — capped at --limit (default 20) so an agent reads a peek,
not a dump.",
    },
    CmdDoc {
        name: "count",
        summary: "row count for an entity",
        usage: "\
USAGE:
  bsc data count <entity> [--json|--pretty]

The row count for one entity table.",
    },
    CmdDoc {
        name: "nulls",
        summary: "NULL counts — all fields, or just <field>",
        usage: "\
USAGE:
  bsc data nulls <entity> [<field>] [--json|--pretty]

NULL counts for an entity: every field, or just <field> when given.",
    },
    CmdDoc {
        name: "lineage",
        summary: "per-row + per-field lineage counts for an entity",
        usage: "\
USAGE:
  bsc data lineage <entity> [--json|--pretty]

The per-row and per-field lineage counts recorded for an entity.",
    },
    CmdDoc {
        name: "connector",
        summary: "runtime REST connector presets + dev-loop (no --db needed)",
        usage: "\
USAGE:
  bsc data connector list            # list the runtime connectors
  bsc data connector get <id>        # print one connector (RuntimePreset JSON)
  bsc data connector add             # upsert a RuntimePreset JSON on stdin (validated, secret-free)
  bsc data connector remove <id>     # delete a runtime connector

DEV-LOOP (author + test a REST connector on the fly, secret-free; read-only — `try` persists NOTHING):
  bsc data connector validate        # validate a RuntimePreset JSON on stdin → `ok` or the error
  bsc data connector probe --base-url <url> [--openapi <url>] [--path <p>] [--project <k> --source <u>]
                                     # GET a live endpoint (authed if a handle is given) and emit a
                                     #   draft RuntimePreset + shape report; --openapi walks an
                                     #   OpenAPI/Swagger doc's paths instead
  bsc data connector try --project <k> --source <u> [--base-url <url>]
                                     # sample-read dry run: validate a RuntimePreset on stdin, resolve
                                     #   the secret from the keychain, read ≤12 objects ×≤20 rows, emit
                                     #   { live, resources:[{name,count,fields}] } — persists nothing
  bsc data connector map             # read a `try` result (or manifest) JSON on stdin → a starter
                                     #   canonical DataModel JSON (one entity per resource)

Runtime REST connector presets live in ~/.base-studio-code/connectors.json ($BSC_CONNECTORS
overrides) — the app-wide store, NOT the per-project DuckDB, so `connector` needs no --db.",
    },
];

/// Parsed flags + leftover positional args.
struct Args {
    db: Option<String>,
    refined: bool,
    /// Compact JSON output (set implicitly by `--pretty`).
    json: bool,
    /// Pretty (re-indented) JSON output.
    pretty: bool,
    /// Row cap for `rows` (default [`DEFAULT_ROW_LIMIT`]).
    limit: Option<usize>,
    /// `connector probe/try`: the instance base URL (overrides a preset's `base_url`).
    base_url: Option<String>,
    /// `connector probe`: an OpenAPI/Swagger doc URL to infer a draft manifest from.
    openapi: Option<String>,
    /// `connector probe`: the request path to sample under `--base-url`.
    path: Option<String>,
    /// `connector probe/try`: the project key half of the keychain handle (authed read).
    project: Option<String>,
    /// `connector probe/try`: the source uid half of the keychain handle (authed read).
    source: Option<String>,
    positional: Vec<String>,
}

/// Default sample size for `rows` — small so an agent reads a peek, not a dump.
const DEFAULT_ROW_LIMIT: usize = 20;

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        db: None,
        refined: false,
        json: false,
        pretty: false,
        limit: None,
        base_url: None,
        openapi: None,
        path: None,
        project: None,
        source: None,
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--refined" => a.refined = true,
            "--json" => a.json = true,
            "--pretty" => {
                a.json = true;
                a.pretty = true;
            }
            "--base-url" => a.base_url = Some(it.next().ok_or("--base-url needs a url")?),
            "--openapi" => a.openapi = Some(it.next().ok_or("--openapi needs a url")?),
            "--path" => a.path = Some(it.next().ok_or("--path needs a value")?),
            "--project" => a.project = Some(it.next().ok_or("--project needs a value")?),
            "--source" => a.source = Some(it.next().ok_or("--source needs a value")?),
            "--limit" => {
                a.limit = Some(
                    it.next()
                        .ok_or("--limit needs a number")?
                        .parse()
                        .map_err(|_| "--limit needs a number")?,
                );
            }
            // `-h`/`--help` route to the help command (handled in run()).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_DATA_DB", || {
        Err("no data store: pass --db <path> or set BSC_DATA_DB".into())
    })
}

/// Open the DataStore at `db`, seeding it with the Data Model persisted in the same file's
/// MetaStore. The MetaStore connection is opened and **dropped** (releasing the DuckDB file lock)
/// before the DataStore re-opens it, so the two single-file views never contend within this process.
fn open_data_store(db: &Path) -> Result<DataStore, String> {
    let model = {
        let meta = MetaStore::open(db).map_err(|e| e.to_string())?;
        meta.get_model()
            .map_err(|e| e.to_string())?
            .map(|(m, _refined)| m)
            .ok_or("no Data Model in the store — run `bsc data model set` first")?
    };
    DataStore::open(db, model).map_err(|e| e.to_string())
}

/// The `data` subcommand entrypoint: `args` is everything after `bsc data`; `prog` is the display
/// name for help/errors (`"bsc data"` from the umbrella, `"bsc-data"` from the legacy shim). Handles
/// help before resolving any store, then dispatches via the `(cmd, sub)` tuple match.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level + per-command help (no command / `help` / `help <cmd>` / `<cmd> help`) — the shared
    // dispatch in bsc-cli-util, run before resolving any store (help works without a --db).
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    // `connector` reaches the runtime REST connector store (~/.base-studio-code/connectors.json),
    // NOT the per-project DuckDB — so it must NOT require --db / BSC_DATA_DB. Dispatch it first.
    if cmd == "connector" {
        return cmd_connector(&args, prog);
    }
    let db = resolve_db(&args.db)?;
    match (cmd.as_str(), sub) {
        ("model", "get") => {
            let store = MetaStore::open(&db).map_err(|e| e.to_string())?;
            match store.get_model().map_err(|e| e.to_string())? {
                Some((model, refined)) => println!("{}", serde_json::json!({ "model": model, "refined": refined })),
                None => println!("null"),
            }
            Ok(())
        }
        ("model", "set") => {
            let store = MetaStore::open(&db).map_err(|e| e.to_string())?;
            let model: DataModel = bsc_sqlite_util::read_stdin_json_one("DataModel")?;
            store.set_model(&model, args.refined).map_err(|e| e.to_string())?;
            Ok(())
        }
        // Shape inference (#2478) — reads the MetaStore only (the schema, not the loaded rows), so
        // it works before any data is materialized.
        ("shapes", _) => {
            let store = MetaStore::open(&db).map_err(|e| e.to_string())?;
            let model = store
                .get_model()
                .map_err(|e| e.to_string())?
                .map(|(m, _refined)| m)
                .ok_or("no Data Model in the store — run `bsc data model set` first")?;
            let all = crate::shape::infer_shapes(&model);
            // An explicit <entity> narrows to one — and an unknown key is an error, not silence.
            let picked: Vec<crate::shape::EntityShapes> = match args.positional.get(1) {
                Some(key) => {
                    let hit = all.into_iter().find(|e| &e.entity == key).ok_or_else(|| {
                        format!("unknown entity '{key}' — `bsc data shapes` lists every entity in the model")
                    })?;
                    vec![hit]
                }
                None => all,
            };
            let value = serde_json::to_value(&picked).map_err(|e| e.to_string())?;
            emit(args.pretty, args.json, &value, || {
                let mut lines = vec!["entity\tshape\tconfidence\treason".to_string()];
                for es in &picked {
                    for c in &es.candidates {
                        lines.push(format!(
                            "{}\t{}\t{}\t{}",
                            es.entity,
                            c.shape.slug(),
                            c.confidence.label(),
                            c.reason
                        ));
                    }
                }
                lines.join("\n")
            });
            Ok(())
        }
        ("scan", "get") => {
            let store = MetaStore::open(&db).map_err(|e| e.to_string())?;
            match store.get_scan().map_err(|e| e.to_string())? {
                Some(scan) => println!("{}", serde_json::to_string(&scan).unwrap_or_else(|_| "null".into())),
                None => println!("null"),
            }
            Ok(())
        }
        ("scan", "set") => {
            let store = MetaStore::open(&db).map_err(|e| e.to_string())?;
            let scan: PlatformScan = bsc_sqlite_util::read_stdin_json_one("PlatformScan")?;
            store.set_scan(&scan).map_err(|e| e.to_string())?;
            Ok(())
        }
        ("tables", _) => {
            let store = open_data_store(&db)?;
            let mut rows = Vec::new();
            for e in &store.model().entities {
                let n = store.count(&e.key).map_err(|e| e.to_string())?;
                rows.push((e.key.clone(), e.label.clone(), n));
            }
            let value = serde_json::Value::Array(
                rows.iter()
                    .map(|(k, l, n)| serde_json::json!({ "entity": k, "label": l, "rows": n }))
                    .collect(),
            );
            emit(args.pretty, args.json, &value, || {
                let mut lines = vec!["entity\trows".to_string()];
                lines.extend(rows.iter().map(|(k, _l, n)| format!("{k}\t{n}")));
                lines.join("\n")
            });
            Ok(())
        }
        ("rows", _) => {
            let entity = args.positional.get(1).ok_or("usage: bsc data rows <entity> [--limit N]")?;
            let store = open_data_store(&db)?;
            let (cols, data) =
                store.sample(entity, args.limit.unwrap_or(DEFAULT_ROW_LIMIT)).map_err(|e| e.to_string())?;
            let objs: Vec<serde_json::Value> = data
                .iter()
                .map(|row| {
                    let mut m = serde_json::Map::new();
                    for (c, v) in cols.iter().zip(row) {
                        let jv = match v {
                            Some(s) => serde_json::Value::String(s.clone()),
                            None => serde_json::Value::Null,
                        };
                        m.insert(c.clone(), jv);
                    }
                    serde_json::Value::Object(m)
                })
                .collect();
            emit(args.pretty, args.json, &serde_json::Value::Array(objs), || {
                let mut lines = vec![cols.join("\t")];
                lines.extend(data.iter().map(|row| {
                    row.iter().map(|c| c.clone().unwrap_or_default()).collect::<Vec<_>>().join("\t")
                }));
                lines.join("\n")
            });
            Ok(())
        }
        ("count", _) => {
            let entity = args.positional.get(1).ok_or("usage: bsc data count <entity>")?;
            let store = open_data_store(&db)?;
            let n = store.count(entity).map_err(|e| e.to_string())?;
            emit(args.pretty, args.json, &serde_json::json!({ "entity": entity, "rows": n }), || n.to_string());
            Ok(())
        }
        ("nulls", _) => {
            let entity = args.positional.get(1).ok_or("usage: bsc data nulls <entity> [<field>]")?;
            let store = open_data_store(&db)?;
            match args.positional.get(2) {
                Some(field) => {
                    let n = store.null_count(entity, field).map_err(|e| e.to_string())?;
                    emit(
                        args.pretty,
                        args.json,
                        &serde_json::json!({ "entity": entity, "field": field, "nulls": n }),
                        || n.to_string(),
                    );
                }
                None => {
                    let fields: Vec<String> = store
                        .model()
                        .entity(entity)
                        .ok_or_else(|| format!("unknown entity `{entity}`"))?
                        .fields
                        .iter()
                        .map(|f| f.key.clone())
                        .collect();
                    let mut counts = Vec::new();
                    for key in &fields {
                        counts.push((key.clone(), store.null_count(entity, key).map_err(|e| e.to_string())?));
                    }
                    let value = serde_json::Value::Array(
                        counts.iter().map(|(k, n)| serde_json::json!({ "field": k, "nulls": n })).collect(),
                    );
                    emit(args.pretty, args.json, &value, || {
                        let mut lines = vec!["field\tnulls".to_string()];
                        lines.extend(counts.iter().map(|(k, n)| format!("{k}\t{n}")));
                        lines.join("\n")
                    });
                }
            }
            Ok(())
        }
        ("lineage", _) => {
            let entity = args.positional.get(1).ok_or("usage: bsc data lineage <entity>")?;
            let store = open_data_store(&db)?;
            if store.model().entity(entity).is_none() {
                return Err(format!("unknown entity `{entity}`"));
            }
            let row_lineage = store.entity_lineage_count(entity).map_err(|e| e.to_string())?;
            let field_lineage = store.entity_field_lineage_count(entity).map_err(|e| e.to_string())?;
            emit(
                args.pretty,
                args.json,
                &serde_json::json!({ "entity": entity, "rowLineage": row_lineage, "fieldLineage": field_lineage }),
                || format!("rowLineage\t{row_lineage}\nfieldLineage\t{field_lineage}"),
            );
            Ok(())
        }
        _ => Err(format!(
            "unknown command: {cmd} {sub}\n\n{}",
            bsc_cli_util::help_overview(prog, TAGLINE, COMMANDS)
        )),
    }
}

/// `connector` — runtime (planner/user-authored) REST connector presets (#1235, relocated #1721).
/// These live in the app-wide connectors store (`~/.base-studio-code/connectors.json`, via
/// [`crate::runtime_store_path`] — `$BSC_CONNECTORS` overrides) — NOT the per-project DuckDB — so
/// an authored connector becomes a native, app-wide integration like the built-ins. The spec is
/// validated + **secret-free** on add (credentials go to the keychain, #1194). This is the same store
/// and semantics the deprecated `bsc plan integration` reaches.
fn cmd_connector(args: &Args, prog: &str) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let path = crate::runtime_store_path();
    match sub {
        // `connector add` reads a RuntimePreset JSON on stdin, validates, upserts by id.
        "add" => {
            let preset: crate::RuntimePreset = bsc_sqlite_util::read_stdin_json_one("connector JSON")?;
            let id = preset.id.clone();
            crate::upsert_runtime_preset(&path, preset)?;
            if args.json {
                println!("{}", serde_json::to_string(&id).unwrap_or_default());
            } else {
                println!("connector added: {id}");
            }
            Ok(())
        }
        "list" => {
            let presets = crate::load_runtime_presets(&path).map_err(|e| e.to_string())?;
            let value = serde_json::to_value(&presets).unwrap_or_else(|_| serde_json::Value::Array(vec![]));
            emit(args.pretty, args.json, &value, || {
                if presets.is_empty() {
                    "(no runtime connectors)".to_string()
                } else {
                    presets
                        .iter()
                        .map(|p| format!("{}  {} [{}] — {} resource(s)", p.id, p.label, p.auth, p.resources.len()))
                        .collect::<Vec<_>>()
                        .join("\n")
                }
            });
            Ok(())
        }
        "get" => {
            let id = args.positional.get(2).ok_or("usage: bsc data connector get <id>")?;
            match crate::find_runtime_preset(&path, id).map_err(|e| e.to_string())? {
                Some(p) => {
                    let value = serde_json::to_value(&p).unwrap_or(serde_json::Value::Null);
                    emit(args.pretty, args.json, &value, || {
                        serde_json::to_string(&p).unwrap_or_else(|_| "null".into())
                    });
                }
                None if args.json => println!("null"),
                None => println!("(no connector '{id}')"),
            }
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(2).ok_or("usage: bsc data connector remove <id>")?;
            let removed = crate::remove_runtime_preset(&path, id).map_err(|e| e.to_string())?;
            if !args.json {
                println!("{}", if removed { format!("removed {id}") } else { format!("(no connector '{id}')") });
            }
            Ok(())
        }
        // ── dev-loop (#1963): author + test a REST connector on the fly, secret-free ──
        "validate" => cmd_connector_validate(),
        "probe" => cmd_connector_probe(args),
        "try" => cmd_connector_try(args),
        "map" => cmd_connector_map(args),
        other => Err(format!(
            "unknown connector command '{other}'\n\n{}",
            bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "connector")
        )),
    }
}

/// `connector validate` — read a [`RuntimePreset`] JSON on stdin, run its structural + secret-free
/// validation, and print `ok`; a malformed/invalid preset is the command's error (#1963).
fn cmd_connector_validate() -> Result<(), String> {
    let preset: crate::RuntimePreset = bsc_sqlite_util::read_stdin_json_one("connector JSON")?;
    preset.validate()?;
    println!("ok");
    Ok(())
}

/// `connector probe` — GET a live endpoint (or an OpenAPI doc) read-only and emit a draft
/// [`RuntimePreset`] (#1963). With `--openapi`, walk the doc's `paths` for array-returning GETs;
/// else sample `--base-url[/--path]` and report its JSON shape. A `--project`/`--source` handle adds
/// a bearer token from the keychain for an authed probe. Persists nothing.
fn cmd_connector_probe(args: &Args) -> Result<(), String> {
    let base = args.base_url.clone().ok_or(
        "usage: bsc data connector probe --base-url <url> [--openapi <url>] [--path <p>] [--project <k> --source <u>]",
    )?;
    // An optional handle resolves a bearer token for the authed probe (the auth kind is unknown
    // here, so default to the `token` keychain field + a bearer header).
    let secret = match (&args.project, &args.source) {
        (Some(p), Some(s)) => crate::transport::resolve_source_secret(p, s, "token"),
        _ => None,
    };
    let value = match &args.openapi {
        Some(openapi_url) => {
            // The OpenAPI URL is absolute; base is empty so it passes through join_url unchanged.
            let fetch = crate::transport::build_fetch("", "token", secret);
            let spec = (fetch)(openapi_url).map_err(|e| format!("fetching OpenAPI doc: {e}"))?;
            serde_json::to_value(crate::transport::draft_from_openapi(&spec, &base))
                .map_err(|e| e.to_string())?
        }
        None => {
            let fetch = crate::transport::build_fetch(&base, "token", secret);
            let path = args.path.clone().unwrap_or_default();
            let body = (fetch)(&path).map_err(|e| format!("fetching {base}: {e}"))?;
            crate::transport::report_sample_shape(&body, &base, &path)
        }
    };
    bsc_sqlite_util::print_json(&value, args.pretty);
    Ok(())
}

/// `connector try` — a sample-reads-only dry run (#1963). Validate the [`RuntimePreset`] on stdin,
/// resolve its secret from the keychain via the `--project`/`--source` handle, build the audited
/// generic REST connector, and read a bounded sample (≤12 objects × ≤20 rows). Emits
/// `{ live, resources:[{name,count,fields}], error? }`. **Persists NOTHING** — no store, no DuckDB,
/// no connectors.json write.
fn cmd_connector_try(args: &Args) -> Result<(), String> {
    use crate::descriptor::RestPreset;
    let project = args.project.as_deref().ok_or(
        "usage: bsc data connector try --project <k> --source <u> [--base-url <url>]  (RuntimePreset on stdin)",
    )?;
    let source = args.source.as_deref().ok_or(
        "usage: bsc data connector try --project <k> --source <u> [--base-url <url>]  (RuntimePreset on stdin)",
    )?;
    let preset: crate::RuntimePreset = bsc_sqlite_util::read_stdin_json_one("connector JSON")?;
    preset.validate()?;
    let base = args
        .base_url
        .clone()
        .or_else(|| preset.base_url.clone())
        .filter(|s| !s.is_empty())
        .ok_or("missing base URL — pass --base-url or set the preset's base_url")?;
    let field = crate::transport::runtime_secret_field(&preset.auth);
    let secret = crate::transport::resolve_source_secret(project, source, field);
    let fetch = crate::transport::build_fetch(&base, &preset.auth, secret);
    let conn = preset.connector(preset.id.clone(), fetch);
    let result = crate::transport::run_try(&conn, 12, 20);
    bsc_sqlite_util::print_json(&result, args.pretty);
    Ok(())
}

/// `connector map` — read a `try`-result (or manifest) JSON on stdin and emit a starter canonical
/// [`DataModel`] JSON: one entity per resource, fields by name with a best-effort type (#1963). A
/// seed for the agent to refine (identities/refs left empty).
fn cmd_connector_map(args: &Args) -> Result<(), String> {
    let input: serde_json::Value = bsc_sqlite_util::read_stdin_json_one("input JSON")?;
    let model = crate::transport::map_to_model(&input);
    let value = serde_json::to_value(&model).map_err(|e| e.to_string())?;
    bsc_sqlite_util::print_json(&value, args.pretty);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc data", TAGLINE, COMMANDS);
        for c in ["model", "shapes", "scan", "tables", "rows", "count", "nulls", "lineage", "connector"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // `shapes` help teaches the hand-off to the #2475 picker and names the vocabulary.
        let s = bsc_cli_util::help_for("bsc data", TAGLINE, COMMANDS, "shapes");
        assert!(s.contains("bsc ui shapes"), "shapes help points at the component-side picker");
        for shape in ["list", "linked-list", "tree", "graph", "table", "key-value"] {
            assert!(s.contains(shape), "shapes help names the `{shape}` vocabulary token");
        }
        // `connector help` shows the connector subcommands, not the whole menu.
        let c = bsc_cli_util::help_for("bsc data", TAGLINE, COMMANDS, "connector");
        assert!(c.contains("bsc data connector"));
        assert!(c.contains("remove <id>"));
        assert!(!c.contains("sample rows"));
        // The dev-loop verbs (#1963) are documented in the connector help block.
        for v in ["validate", "probe", "try", "map"] {
            assert!(c.contains(v), "connector help documents `{v}`");
        }
        // An unknown command falls back to the overview.
        assert!(bsc_cli_util::help_for("bsc data", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }

    #[test]
    fn shapes_verb_dispatches_over_a_stored_model_and_narrows_by_entity() {
        // Drives the real dispatch: a model persisted in the MetaStore, then `shapes` / `shapes
        // <entity>` / an unknown entity / an empty store.
        let db = std::env::temp_dir()
            .join(format!("bsc-data-shapes-test-{}.duckdb", std::process::id()));
        let _ = std::fs::remove_file(&db);
        let dbs = db.to_string_lossy().into_owned();

        // No model yet → a crisp error, never a panic.
        assert!(run(vec!["shapes".into(), "--db".into(), dbs.clone()], "bsc data").is_err());

        let field = |k: &str, ty: crate::FieldType| crate::Field {
            key: k.into(), label: String::new(), ty, required: false,
            reference: None, enum_values: vec![], validate: None,
        };
        let model = DataModel {
            name: "m".into(),
            version: 1,
            entities: vec![crate::Entity {
                key: "category".into(),
                label: String::new(),
                fields: vec![
                    field("id", crate::FieldType::String),
                    crate::Field {
                        reference: Some("category".into()),
                        ..field("parent_id", crate::FieldType::Ref)
                    },
                ],
                identity: vec!["id".into()],
            }],
        };
        MetaStore::open(&db).unwrap().set_model(&model, true).unwrap();

        for form in [vec!["shapes".to_string()], vec!["shapes".into(), "category".into()]] {
            let mut a = form.clone();
            a.extend(["--db".to_string(), dbs.clone()]);
            assert!(run(a, "bsc data").is_ok(), "{form:?} runs");
            let mut j = form;
            j.extend(["--json".to_string(), "--db".to_string(), dbs.clone()]);
            assert!(run(j, "bsc data").is_ok(), "…and in --json");
        }
        // An unknown entity is an error, not silent emptiness.
        let err = run(
            vec!["shapes".into(), "nope".into(), "--db".into(), dbs.clone()],
            "bsc data",
        )
        .unwrap_err();
        assert!(err.contains("unknown entity 'nope'"), "got: {err}");

        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn parses_dev_loop_flags() {
        let a = parse_args(vec![
            "connector".into(), "probe".into(),
            "--base-url".into(), "https://acme.example.com/api".into(),
            "--openapi".into(), "https://acme.example.com/openapi.json".into(),
            "--path".into(), "contacts".into(),
            "--project".into(), "p1".into(),
            "--source".into(), "s1".into(),
        ])
        .unwrap();
        assert_eq!(a.base_url.as_deref(), Some("https://acme.example.com/api"));
        assert_eq!(a.openapi.as_deref(), Some("https://acme.example.com/openapi.json"));
        assert_eq!(a.path.as_deref(), Some("contacts"));
        assert_eq!(a.project.as_deref(), Some("p1"));
        assert_eq!(a.source.as_deref(), Some("s1"));
        assert_eq!(a.positional, vec!["connector", "probe"]);
        // Each value flag errors without its argument.
        assert!(parse_args(vec!["connector".into(), "probe".into(), "--base-url".into()]).is_err());
    }

    #[test]
    fn map_verb_emits_a_starter_model_from_a_try_result() {
        // `connector map` is pure over stdin → DataModel; exercise the mapping the verb calls.
        let try_result = serde_json::json!({ "resources": [
            { "name": "account", "count": 1, "fields": [ { "name": "id", "type": "number" } ] },
        ] });
        let model = crate::transport::map_to_model(&try_result);
        assert_eq!(model.entities.len(), 1);
        assert_eq!(model.entities[0].key, "account");
    }

    #[test]
    fn parses_db_refined_and_positionals() {
        let a = parse_args(vec!["model".into(), "set".into(), "--db".into(), "x.duckdb".into(), "--refined".into()]).unwrap();
        assert_eq!(a.db.as_deref(), Some("x.duckdb"));
        assert!(a.refined);
        assert_eq!(a.positional, vec!["model", "set"]);
    }

    #[test]
    fn resolve_db_errors_without_a_path_or_env() {
        // No --db and (in this test process) no BSC_DATA_DB → a clear error, not a panic.
        if std::env::var("BSC_DATA_DB").is_err() {
            assert!(resolve_db(&None).is_err());
        }
        assert_eq!(resolve_db(&Some("y.duckdb".into())).unwrap(), PathBuf::from("y.duckdb"));
    }

    #[test]
    fn unknown_flag_is_rejected() {
        assert!(parse_args(vec!["model".into(), "--bogus".into()]).is_err());
    }

    #[test]
    fn parses_json_pretty_and_limit() {
        let a = parse_args(vec!["rows".into(), "account".into(), "--limit".into(), "5".into(), "--pretty".into()]).unwrap();
        assert_eq!(a.positional, vec!["rows", "account"]);
        assert_eq!(a.limit, Some(5));
        assert!(a.pretty);
        assert!(a.json, "--pretty implies --json");

        let j = parse_args(vec!["tables".into(), "--json".into()]).unwrap();
        assert!(j.json);
        assert!(!j.pretty);
    }

    #[test]
    fn limit_requires_a_number() {
        assert!(parse_args(vec!["rows".into(), "--limit".into(), "abc".into()]).is_err());
        assert!(parse_args(vec!["rows".into(), "--limit".into()]).is_err());
    }

    #[test]
    fn connector_needs_no_data_db_and_round_trips_the_store() {
        // `connector` reaches connectors.json (via $BSC_CONNECTORS), never the per-project DuckDB —
        // so it must work with no --db / BSC_DATA_DB set. Point the store at a unique temp file.
        let store = std::env::temp_dir().join(format!("bsc-data-conn-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&store);
        std::env::set_var("BSC_CONNECTORS", &store);

        let conn = |positional: &[&str]| Args {
            db: None,
            refined: false,
            json: false,
            pretty: false,
            limit: None,
            base_url: None,
            openapi: None,
            path: None,
            project: None,
            source: None,
            positional: positional.iter().map(|s| s.to_string()).collect(),
        };

        // list against an absent store: Ok (empty), and crucially no --db required.
        assert!(cmd_connector(&conn(&["connector", "list"]), "bsc data").is_ok());

        // seed via the same functions the verb calls, then get/remove through the verb.
        let preset = crate::RuntimePreset {
            id: "acme-crm".into(),
            label: "Acme".into(),
            category: "crm".into(),
            base_url: Some("https://acme.example.com/api".into()),
            auth: "token".into(),
            oauth: None,
            resources: vec![crate::RuntimeResource {
                name: "contacts".into(),
                path: "contacts".into(),
                array_key: Some("data".into()),
            }],
        };
        crate::upsert_runtime_preset(&store, preset).unwrap();

        assert!(cmd_connector(&conn(&["connector", "get", "acme-crm"]), "bsc data").is_ok());
        assert!(cmd_connector(&conn(&["connector", "remove", "acme-crm"]), "bsc data").is_ok());
        assert_eq!(crate::load_runtime_presets(&store).unwrap().len(), 0);

        // an unknown sub is an error.
        assert!(cmd_connector(&conn(&["connector", "frobnicate"]), "bsc data").is_err());

        std::env::remove_var("BSC_CONNECTORS");
        let _ = std::fs::remove_file(&store);
    }
}
