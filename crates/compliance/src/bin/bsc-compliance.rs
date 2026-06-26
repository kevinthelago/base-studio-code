//! `bsc-compliance` — the session-facing CLI over the compliance **standards store** (#1718, an
//! instance of #1325 "all application state reachable via `bsc-*`"). The corpus
//! (`~/.base-studio-code/compliance/store.db`) was previously reachable only through the
//! `bsc-compliance-mcp` server's READ-only tools, and only from sessions that get `.mcp.json`
//! (planner/director/workers). This CLI exposes the **same** projections to ANY shell session —
//! plus the WRITE side the MCP server lacks (`upsert` / `remove` / `reseed`).
//!
//! The store is located via `--db <path>`, the `BSC_COMPLIANCE_STORE` env var (set per-session at
//! launch), or the default `~/.base-studio-code/compliance/store.db` (the same precedence
//! [`compliance::store::Store::default_path`] uses). Output is JSON to stdout — compact by default,
//! indented with `--pretty` (the `--json` flag is accepted as an explicit no-op, since output is
//! always JSON). Read projections reuse [`compliance::engine::Engine`] / `Store`; nothing is
//! re-queried by hand.
//!
//! Commands:
//!   bsc-compliance standards list [--domain <d>]   # every standard (or one domain), JSON
//!   bsc-compliance standards get <id>              # one standard's full record (or null)
//!   bsc-compliance requirements [--regions a,b] [--data-types x,y] [--domains d1,d2]
//!   bsc-compliance accessibility <target>          # the WCAG checklist for a UI target
//!   bsc-compliance privacy <data-types> [--regions a,b]   # privacy obligations for the data
//!   bsc-compliance meta                            # corpus version + count
//!   bsc-compliance reseed                          # re-apply the baseline corpus; prints count
//!   bsc-compliance upsert                          # upsert a Standard JSON on stdin; prints id
//!   bsc-compliance remove <id>                     # delete a standard; prints whether it existed
//! Global flags: --db <path> · --json · --pretty

use bsc_sqlite_util::{print_json, read_stdin_json};
use compliance::engine::Engine;
use compliance::store::Store;
use compliance::types::{Domain, Standard};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("bsc-compliance: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Parsed global flags + the value-bearing flags any verb may use + leftover positional args.
struct Args {
    db: Option<String>,
    pretty: bool,
    domain: Option<String>,
    regions: Vec<String>,
    data_types: Vec<String>,
    domains: Vec<String>,
    positional: Vec<String>,
}

/// Split a comma-separated flag value into trimmed, non-empty tokens (`eu, us-ca` → `["eu","us-ca"]`).
fn csv(s: &str) -> Vec<String> {
    s.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        db: None,
        pretty: false,
        domain: None,
        regions: Vec::new(),
        data_types: Vec::new(),
        domains: Vec::new(),
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--pretty" => a.pretty = true,
            // Output is always JSON; --json is accepted so callers can be explicit.
            "--json" => {}
            "--domain" => a.domain = Some(it.next().ok_or("--domain needs a value")?),
            "--regions" => a.regions = csv(&it.next().ok_or("--regions needs a comma-separated value")?),
            "--data-types" => {
                a.data_types = csv(&it.next().ok_or("--data-types needs a comma-separated value")?)
            }
            "--domains" => a.domains = csv(&it.next().ok_or("--domains needs a comma-separated value")?),
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

/// Parse a domain token into a [`Domain`], with a clear error listing the accepted values.
fn parse_domain(s: &str) -> Result<Domain, String> {
    Domain::parse(s).ok_or_else(|| {
        format!("unknown domain '{s}' (expected accessibility | privacy | security | user_protection)")
    })
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1).collect())?;
    let cmd = args.positional.first().cloned().unwrap_or_default();
    if cmd.is_empty() {
        print!("{USAGE}");
        return Ok(());
    }

    let open_store = || -> Result<Store, String> {
        let path = resolve_db(&args.db)?;
        Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
    };

    match cmd.as_str() {
        "standards" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            match sub {
                "list" => {
                    let s = open_store()?;
                    let standards = match args.domain.as_deref() {
                        Some(d) => s.list_by_domain(parse_domain(d)?),
                        None => s.all(),
                    };
                    print_json(&standards, args.pretty);
                    Ok(())
                }
                "get" => {
                    let id = args.positional.get(2).ok_or("usage: bsc-compliance standards get <id>")?;
                    let s = open_store()?;
                    // Print `null` for a miss (mirrors `bsc-skill group get`).
                    print_json(&s.get(id), args.pretty);
                    Ok(())
                }
                "" => Err(format!("usage: bsc-compliance standards <list|get>\n\n{USAGE}")),
                other => Err(format!("unknown standards command '{other}'\n\n{USAGE}")),
            }
        }
        "requirements" => {
            let domains = args
                .domains
                .iter()
                .map(|d| parse_domain(d))
                .collect::<Result<Vec<_>, _>>()?;
            let engine = Engine::with_store(open_store()?);
            let set = engine.requirements_for(&args.regions, &args.data_types, &domains);
            print_json(&set, args.pretty);
            Ok(())
        }
        "accessibility" => {
            let target = args
                .positional
                .get(1)
                .ok_or("usage: bsc-compliance accessibility <target>")?;
            let engine = Engine::with_store(open_store()?);
            print_json(&engine.accessibility_checklist(target), args.pretty);
            Ok(())
        }
        "privacy" => {
            // `<data-types>` is a positional comma-separated list (e.g. `pii,health`).
            let data_types = csv(args.positional.get(1).map(String::as_str).unwrap_or(""));
            if data_types.is_empty() {
                return Err("usage: bsc-compliance privacy <data-types> [--regions a,b]".into());
            }
            let engine = Engine::with_store(open_store()?);
            print_json(&engine.privacy_requirements(&data_types, &args.regions), args.pretty);
            Ok(())
        }
        "meta" => {
            let s = open_store()?;
            print_json(&s.meta(), args.pretty);
            Ok(())
        }
        "reseed" => {
            let s = open_store()?;
            let n = s.reseed()?;
            print_json(&n, args.pretty);
            Ok(())
        }
        "upsert" => {
            // One Standard object (or an array) on stdin; upsert each, print the ids.
            let standards: Vec<Standard> = read_stdin_json("standard")?;
            let s = open_store()?;
            let mut ids = Vec::new();
            for standard in &standards {
                if standard.id.trim().is_empty() {
                    return Err("upsert: each standard needs a non-empty \"id\"".into());
                }
                s.upsert(standard)?;
                ids.push(standard.id.clone());
            }
            print_json(&ids, args.pretty);
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(1).ok_or("usage: bsc-compliance remove <id>")?;
            let s = open_store()?;
            print_json(&s.remove(id)?, args.pretty);
            Ok(())
        }
        other => Err(format!("unknown command '{other}'\n\n{USAGE}")),
    }
}

/// Resolve the store path: explicit `--db` wins, else [`Store::default_path`] (`$BSC_COMPLIANCE_STORE`,
/// then `~/.base-studio-code/compliance/store.db`).
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = flag {
        return Ok(PathBuf::from(p));
    }
    Store::default_path()
        .ok_or("could not resolve a store path; pass --db <path> or set BSC_COMPLIANCE_STORE")
        .map_err(str::to_string)
}

const USAGE: &str = "\
bsc-compliance — the compliance standards store (#1718)

USAGE:
  bsc-compliance <command> [args] [--db <path>] [--json|--pretty]

READ:
  standards list [--domain <d>]      every standard, or one domain (accessibility | privacy |
                                     security | user_protection); JSON
  standards get <id>                 one standard's full record + requirements (JSON, or null)
  requirements [--regions a,b]       the applicable obligation set, scoped by jurisdiction +
    [--data-types x,y] [--domains d] data types + optional domain filter (the requirements_for projection)
  accessibility <target>             the WCAG checklist a UI target must meet
  privacy <data-types> [--regions]   the privacy/data-protection obligations for the data types
  meta                               corpus version + last-updated stamp + standard count

WRITE:
  reseed                             re-apply the baseline corpus (refresh without a release); prints count
  upsert                             upsert a Standard object/array JSON on stdin; prints id(s)
  remove <id>                        delete a standard; prints whether a row existed

The store is found via --db <path>, the BSC_COMPLIANCE_STORE env var, or the default
~/.base-studio-code/compliance/store.db. Output is JSON (compact; --pretty indents).
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_trims_and_drops_empties() {
        assert_eq!(csv("eu, us-ca ,,"), vec!["eu".to_string(), "us-ca".to_string()]);
        assert!(csv("").is_empty());
        assert!(csv("  ,  ").is_empty());
    }

    #[test]
    fn parse_args_collects_flags_and_positionals() {
        let a = parse_args(
            ["standards", "list", "--domain", "privacy", "--db", "x.db", "--pretty"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        )
        .unwrap();
        assert_eq!(a.positional, vec!["standards".to_string(), "list".to_string()]);
        assert_eq!(a.domain.as_deref(), Some("privacy"));
        assert_eq!(a.db.as_deref(), Some("x.db"));
        assert!(a.pretty);
    }

    #[test]
    fn parse_args_splits_comma_lists_and_accepts_json_noop() {
        let a = parse_args(
            ["requirements", "--regions", "eu,us-ca", "--data-types", "pii,health", "--domains", "privacy", "--json"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        )
        .unwrap();
        assert_eq!(a.regions, vec!["eu".to_string(), "us-ca".to_string()]);
        assert_eq!(a.data_types, vec!["pii".to_string(), "health".to_string()]);
        assert_eq!(a.domains, vec!["privacy".to_string()]);
        assert!(!a.pretty, "--json must not imply --pretty");
    }

    #[test]
    fn parse_args_rejects_unknown_flag() {
        let err = parse_args(vec!["meta".into(), "--nope".into()])
            .err()
            .expect("an unknown flag must error");
        assert!(err.contains("unknown flag"));
    }

    #[test]
    fn parse_domain_maps_aliases_and_rejects_garbage() {
        assert_eq!(parse_domain("privacy").unwrap(), Domain::Privacy);
        assert_eq!(parse_domain("a11y").unwrap(), Domain::Accessibility);
        assert!(parse_domain("nonsense").is_err());
    }
}
