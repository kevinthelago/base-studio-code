//! `bsc-data` — read/write a project's canonical **Data Model** + **Platform Behavior Summary** in
//! its per-project DuckDB store (#1446). The desktop app writes them; the **planner** reads them at
//! the UI-kickoff stage to drive data-driven screens (it can't query DuckDB directly, so this CLI is
//! its accessor — the #1325 pattern, mirroring `bsc-plan` / `bsc-skill`).
//!
//! The store is located via `--db <path>` or the `BSC_DATA_DB` env var (set per-session at launch).
//!
//! USAGE:
//!   bsc-data model get                 # print {"model":<DataModel>,"refined":<bool>} or null
//!   bsc-data model set [--refined]     # upsert the DataModel JSON from stdin
//!   bsc-data scan get                  # print the PlatformScan JSON or null
//!   bsc-data scan set                  # upsert the PlatformScan JSON from stdin

use bsc_data::{DataModel, MetaStore, PlatformScan};
use std::io::Read;
use std::path::PathBuf;
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
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { db: None, refined: false, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--refined" => a.refined = true,
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

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1).collect())?;
    let cmd = args.positional.first().cloned().unwrap_or_default();
    if cmd.is_empty() {
        print!("{USAGE}");
        return Ok(());
    }
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let store = MetaStore::open(resolve_db(&args.db)?).map_err(|e| e.to_string())?;
    match (cmd.as_str(), sub) {
        ("model", "get") => {
            match store.get_model().map_err(|e| e.to_string())? {
                Some((model, refined)) => println!("{}", serde_json::json!({ "model": model, "refined": refined })),
                None => println!("null"),
            }
            Ok(())
        }
        ("model", "set") => {
            let model: DataModel =
                serde_json::from_str(read_stdin()?.trim()).map_err(|e| format!("parsing DataModel: {e}"))?;
            store.set_model(&model, args.refined).map_err(|e| e.to_string())?;
            Ok(())
        }
        ("scan", "get") => {
            match store.get_scan().map_err(|e| e.to_string())? {
                Some(scan) => println!("{}", serde_json::to_string(&scan).unwrap_or_else(|_| "null".into())),
                None => println!("null"),
            }
            Ok(())
        }
        ("scan", "set") => {
            let scan: PlatformScan =
                serde_json::from_str(read_stdin()?.trim()).map_err(|e| format!("parsing PlatformScan: {e}"))?;
            store.set_scan(&scan).map_err(|e| e.to_string())?;
            Ok(())
        }
        _ => {
            print!("{USAGE}");
            Err(format!("unknown command: {cmd} {sub}"))
        }
    }
}

const USAGE: &str = "\
bsc-data — the per-project Data Model + Platform Behavior Summary store (#1446)

USAGE:
  bsc-data <model|scan> <get|set> [--db <path>] [--refined]

MODEL (the canonical Data Model):
  model get                 print {\"model\":<DataModel>,\"refined\":<bool>} (or null)
  model set [--refined]     upsert the DataModel JSON on stdin

SCAN (the Platform Behavior Summary):
  scan get                  print the PlatformScan JSON (or null)
  scan set                  upsert the PlatformScan JSON on stdin

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
}
