//! `bsc-data` — read/write a project's canonical **Data Model** + **Platform Behavior Summary** in
//! its per-project DuckDB store (#1446), and read the materialized **DataStore** — the typed entity
//! tables + lineage (#1717). The desktop app writes them; the **planner** reads them at the
//! UI-kickoff stage to drive data-driven screens (it can't query DuckDB directly, so this CLI is its
//! accessor — the #1325 pattern, mirroring `bsc-plan` / `bsc-skill`).
//!
//! The store is located via `--db <path>` or the `BSC_DATA_DB` env var (set per-session at launch).
//!
//! Reading is lean by default; `--json` emits compact JSON and `--pretty` re-indents it.
//!
//! USAGE:
//!   bsc-data model get                 # print {"model":<DataModel>,"refined":<bool>} or null
//!   bsc-data model set [--refined]     # upsert the DataModel JSON from stdin
//!   bsc-data scan get                  # print the PlatformScan JSON or null
//!   bsc-data scan set                  # upsert the PlatformScan JSON from stdin
//!   bsc-data tables                    # entity tables + row counts
//!   bsc-data rows <entity> [--limit N] # sample rows from an entity table
//!   bsc-data count <entity>            # row count for an entity
//!   bsc-data nulls <entity> [<field>]  # NULL counts (all fields, or one)
//!   bsc-data lineage <entity>          # per-row + per-field lineage counts
//!   bsc-data connector list            # runtime REST connector presets (connectors.json; no --db)
//!   bsc-data connector add             # upsert a RuntimePreset JSON from stdin (validated)

use bsc_data::{DataModel, DataStore, MetaStore, PlatformScan};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("bsc-data: {e}");
            ExitCode::FAILURE
        }
    }
}

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
    positional: Vec<String>,
}

/// Default sample size for `rows` — small so an agent reads a peek, not a dump.
const DEFAULT_ROW_LIMIT: usize = 20;

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { db: None, refined: false, json: false, pretty: false, limit: None, positional: Vec::new() };
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
            "--limit" => {
                a.limit = Some(
                    it.next()
                        .ok_or("--limit needs a number")?
                        .parse()
                        .map_err(|_| "--limit needs a number")?,
                );
            }
            "-h" | "--help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = flag {
        return Ok(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("BSC_DATA_DB") {
        return Ok(PathBuf::from(p));
    }
    Err("no data store: pass --db <path> or set BSC_DATA_DB".into())
}

fn read_stdin() -> Result<String, String> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
    Ok(buf)
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
            .ok_or("no Data Model in the store — run `bsc-data model set` first")?
    };
    DataStore::open(db, model).map_err(|e| e.to_string())
}

/// Render a value per the output flags, or fall back to the caller's lean text. `--pretty`
/// re-indents, `--json` is compact, default is the human-readable `lean` rendering.
fn emit(args: &Args, value: serde_json::Value, lean: impl FnOnce() -> String) {
    if args.pretty {
        println!("{}", serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".into()));
    } else if args.json {
        println!("{}", serde_json::to_string(&value).unwrap_or_else(|_| "null".into()));
    } else {
        println!("{}", lean());
    }
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1).collect())?;
    let cmd = args.positional.first().cloned().unwrap_or_default();
    if cmd.is_empty() {
        print!("{USAGE}");
        return Ok(());
    }
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    // `connector` reaches the runtime REST connector store (~/.base-studio-code/connectors.json),
    // NOT the per-project DuckDB — so it must NOT require --db / BSC_DATA_DB. Dispatch it first.
    if cmd == "connector" {
        return cmd_connector(&args);
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
            let model: DataModel =
                serde_json::from_str(read_stdin()?.trim()).map_err(|e| format!("parsing DataModel: {e}"))?;
            store.set_model(&model, args.refined).map_err(|e| e.to_string())?;
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
            let scan: PlatformScan =
                serde_json::from_str(read_stdin()?.trim()).map_err(|e| format!("parsing PlatformScan: {e}"))?;
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
            emit(&args, value, || {
                let mut lines = vec!["entity\trows".to_string()];
                lines.extend(rows.iter().map(|(k, _l, n)| format!("{k}\t{n}")));
                lines.join("\n")
            });
            Ok(())
        }
        ("rows", _) => {
            let entity = args.positional.get(1).ok_or("usage: bsc-data rows <entity> [--limit N]")?;
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
            emit(&args, serde_json::Value::Array(objs), || {
                let mut lines = vec![cols.join("\t")];
                lines.extend(data.iter().map(|row| {
                    row.iter().map(|c| c.clone().unwrap_or_default()).collect::<Vec<_>>().join("\t")
                }));
                lines.join("\n")
            });
            Ok(())
        }
        ("count", _) => {
            let entity = args.positional.get(1).ok_or("usage: bsc-data count <entity>")?;
            let store = open_data_store(&db)?;
            let n = store.count(entity).map_err(|e| e.to_string())?;
            emit(&args, serde_json::json!({ "entity": entity, "rows": n }), || n.to_string());
            Ok(())
        }
        ("nulls", _) => {
            let entity = args.positional.get(1).ok_or("usage: bsc-data nulls <entity> [<field>]")?;
            let store = open_data_store(&db)?;
            match args.positional.get(2) {
                Some(field) => {
                    let n = store.null_count(entity, field).map_err(|e| e.to_string())?;
                    emit(
                        &args,
                        serde_json::json!({ "entity": entity, "field": field, "nulls": n }),
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
                    emit(&args, value, || {
                        let mut lines = vec!["field\tnulls".to_string()];
                        lines.extend(counts.iter().map(|(k, n)| format!("{k}\t{n}")));
                        lines.join("\n")
                    });
                }
            }
            Ok(())
        }
        ("lineage", _) => {
            let entity = args.positional.get(1).ok_or("usage: bsc-data lineage <entity>")?;
            let store = open_data_store(&db)?;
            if store.model().entity(entity).is_none() {
                return Err(format!("unknown entity `{entity}`"));
            }
            let row_lineage = store.entity_lineage_count(entity).map_err(|e| e.to_string())?;
            let field_lineage = store.entity_field_lineage_count(entity).map_err(|e| e.to_string())?;
            emit(
                &args,
                serde_json::json!({ "entity": entity, "rowLineage": row_lineage, "fieldLineage": field_lineage }),
                || format!("rowLineage\t{row_lineage}\nfieldLineage\t{field_lineage}"),
            );
            Ok(())
        }
        _ => {
            print!("{USAGE}");
            Err(format!("unknown command: {cmd} {sub}"))
        }
    }
}

/// `connector` — runtime (planner/user-authored) REST connector presets (#1235, relocated #1721).
/// These live in the app-wide connectors store (`~/.base-studio-code/connectors.json`, via
/// [`bsc_data::runtime_store_path`] — `$BSC_CONNECTORS` overrides) — NOT the per-project DuckDB — so
/// an authored connector becomes a native, app-wide integration like the built-ins. The spec is
/// validated + **secret-free** on add (credentials go to the keychain, #1194). This is the same store
/// and semantics the deprecated `bsc-plan integration` reaches.
fn cmd_connector(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let path = bsc_data::runtime_store_path();
    match sub {
        // `connector add` reads a RuntimePreset JSON on stdin, validates, upserts by id.
        "add" => {
            let preset: bsc_data::RuntimePreset =
                serde_json::from_str(read_stdin()?.trim()).map_err(|e| format!("parsing connector JSON: {e}"))?;
            let id = preset.id.clone();
            bsc_data::upsert_runtime_preset(&path, preset)?;
            if args.json {
                println!("{}", serde_json::to_string(&id).unwrap_or_default());
            } else {
                println!("connector added: {id}");
            }
            Ok(())
        }
        "list" => {
            let presets = bsc_data::load_runtime_presets(&path).map_err(|e| e.to_string())?;
            let value = serde_json::to_value(&presets).unwrap_or_else(|_| serde_json::Value::Array(vec![]));
            emit(args, value, || {
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
            let id = args.positional.get(2).ok_or("usage: bsc-data connector get <id>")?;
            match bsc_data::find_runtime_preset(&path, id).map_err(|e| e.to_string())? {
                Some(p) => {
                    let value = serde_json::to_value(&p).unwrap_or(serde_json::Value::Null);
                    emit(args, value, || {
                        serde_json::to_string(&p).unwrap_or_else(|_| "null".into())
                    });
                }
                None if args.json => println!("null"),
                None => println!("(no connector '{id}')"),
            }
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(2).ok_or("usage: bsc-data connector remove <id>")?;
            let removed = bsc_data::remove_runtime_preset(&path, id).map_err(|e| e.to_string())?;
            if !args.json {
                println!("{}", if removed { format!("removed {id}") } else { format!("(no connector '{id}')") });
            }
            Ok(())
        }
        other => Err(format!("unknown connector command '{other}'\n\n{USAGE}")),
    }
}

const USAGE: &str = "\
bsc-data — the per-project Data Model + Platform Behavior Summary + DataStore (#1446/#1717)

USAGE:
  bsc-data <command> [args] [--db <path>] [--json] [--pretty]

MODEL (the canonical Data Model):
  model get                 print {\"model\":<DataModel>,\"refined\":<bool>} (or null)
  model set [--refined]     upsert the DataModel JSON on stdin

SCAN (the Platform Behavior Summary):
  scan get                  print the PlatformScan JSON (or null)
  scan set                  upsert the PlatformScan JSON on stdin

DATASTORE (the materialized entity tables + lineage; reading is lean by default):
  tables                    list entity tables + row counts
  rows <entity> [--limit N] sample rows from an entity table (default 20)
  count <entity>            row count for an entity
  nulls <entity> [<field>]  NULL counts — all fields, or just <field>
  lineage <entity>          per-row + per-field lineage counts for an entity

CONNECTOR (runtime REST connector presets in ~/.base-studio-code/connectors.json; no --db needed):
  connector list            list the runtime connectors
  connector get <id>        print one connector (RuntimePreset JSON)
  connector add             upsert a RuntimePreset JSON on stdin (validated, secret-free)
  connector remove <id>     delete a runtime connector

OUTPUT:
  --json                    compact JSON (default is lean TSV)
  --pretty                  re-indented JSON (implies --json)

The store is found via --db <path> or the BSC_DATA_DB env var.
";

#[cfg(test)]
mod tests {
    use super::*;

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
            positional: positional.iter().map(|s| s.to_string()).collect(),
        };

        // list against an absent store: Ok (empty), and crucially no --db required.
        assert!(cmd_connector(&conn(&["connector", "list"])).is_ok());

        // seed via the same functions the verb calls, then get/remove through the verb.
        let preset = bsc_data::RuntimePreset {
            id: "acme-crm".into(),
            label: "Acme".into(),
            category: "crm".into(),
            base_url: Some("https://acme.example.com/api".into()),
            auth: "token".into(),
            resources: vec![bsc_data::RuntimeResource {
                name: "contacts".into(),
                path: "contacts".into(),
                array_key: Some("data".into()),
            }],
        };
        bsc_data::upsert_runtime_preset(&store, preset).unwrap();

        assert!(cmd_connector(&conn(&["connector", "get", "acme-crm"])).is_ok());
        assert!(cmd_connector(&conn(&["connector", "remove", "acme-crm"])).is_ok());
        assert_eq!(bsc_data::load_runtime_presets(&store).unwrap().len(), 0);

        // an unknown sub is an error.
        assert!(cmd_connector(&conn(&["connector", "frobnicate"])).is_err());

        std::env::remove_var("BSC_CONNECTORS");
        let _ = std::fs::remove_file(&store);
    }
}
