//! The `bsc compliance` subcommand (#1877) — the session-facing CLI over the compliance **standards
//! store** (#1718, an instance of #1325 "all application state reachable via `bsc-*`"). The corpus
//! (`~/.base-studio-code/compliance/store.db`) was previously reachable only through the
//! `bsc-compliance-mcp` server's READ-only tools, and only from sessions that get `.mcp.json`
//! (planner/director/workers). This CLI exposes the **same** projections to ANY shell session —
//! plus the WRITE side the MCP server lacks (`upsert` / `remove` / `reseed`).
//!
//! Extracted from the old `bsc-compliance` binary so the unified `bsc` umbrella dispatches into it
//! via [`run`]; the legacy `bsc-compliance` shim delegates here too.
//!
//! The store is located via `--db <path>`, the `BSC_COMPLIANCE_STORE` env var (set per-session at
//! launch), or the default `~/.base-studio-code/compliance/store.db` (the same precedence
//! [`crate::store::Store::default_path`] uses). Output is JSON to stdout — compact by default,
//! indented with `--pretty` (the `--json` flag is accepted as an explicit no-op, since output is
//! always JSON). Read projections reuse [`crate::engine::Engine`] / `Store`; nothing is re-queried by
//! hand.
//!
//! Help is per-command so a model loads only what it needs (#1762):
//!   bsc compliance help              # compact menu (the small "what commands exist" prompt)
//!   bsc compliance standards help    # detailed help for ONE command
//!   bsc compliance <cmd> help        # same, after any command

use crate::engine::Engine;
use crate::store::Store;
use crate::types::{Domain, Standard};
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::{print_json, read_stdin_json};
use std::path::PathBuf;

const TAGLINE: &str = "the compliance standards store — accessibility/privacy/security obligations (#1718)";

/// The command catalog — drives the shared help system. One detailed `usage` block per top-level
/// command keeps the overview tiny; `standards`' subcommands live in its own usage block. Output is
/// JSON throughout (compact; `--pretty` indents).
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "standards",
        summary: "list/get the raw standards corpus",
        usage: "\
USAGE:
  bsc compliance standards list [--domain <d>]   # every standard, or one domain, JSON
  bsc compliance standards get <id>              # one standard's full record (or null)

<d> is one of: accessibility | privacy | security | user_protection.",
    },
    CmdDoc {
        name: "requirements",
        summary: "the applicable obligation set, scoped by jurisdiction + data",
        usage: "\
USAGE:
  bsc compliance requirements [--regions a,b] [--data-types x,y] [--domains d1,d2]

The requirements_for projection: the obligations that apply given the regions, data types, and an
optional domain filter.",
    },
    CmdDoc {
        name: "accessibility",
        summary: "the WCAG checklist a UI target must meet",
        usage: "\
USAGE:
  bsc compliance accessibility <target>

The WCAG checklist for a UI target (the accessibility_checklist projection).",
    },
    CmdDoc {
        name: "privacy",
        summary: "privacy/data-protection obligations for given data types",
        usage: "\
USAGE:
  bsc compliance privacy <data-types> [--regions a,b]

<data-types> is a positional comma-separated list (e.g. pii,health). Prints the privacy obligations
for that data, optionally scoped to --regions.",
    },
    CmdDoc {
        name: "meta",
        summary: "corpus version + last-updated stamp + standard count",
        usage: "\
USAGE:
  bsc compliance meta

Prints the corpus metadata: version, last-updated stamp, and standard count.",
    },
    CmdDoc {
        name: "reseed",
        summary: "re-apply the baseline corpus; prints count",
        usage: "\
USAGE:
  bsc compliance reseed

Re-applies the baseline corpus (a refresh without a release). Prints the resulting standard count.",
    },
    CmdDoc {
        name: "upsert",
        summary: "upsert Standard(s) from JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc compliance upsert   # a Standard object (or an array) as JSON on stdin

Upserts each standard by its (required, non-empty) \"id\". Prints the id(s) written.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a standard; prints whether a row existed",
        usage: "\
USAGE:
  bsc compliance remove <id>

Deletes the standard keyed by <id>; prints whether a row existed.",
    },
];

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
            // `-h`/`--help` route to the help command (handled in run()).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
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

/// The `compliance` subcommand entrypoint: `args` is everything after `bsc compliance`; `prog` is the
/// display name for help/errors (`"bsc compliance"` from the umbrella, `"bsc-compliance"` from the
/// legacy shim).
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level + per-command help (no command / `help` / `help <cmd>` / `<cmd> help`) — the shared
    // dispatch in bsc-cli-util, run before opening the store (help works without a store.db).
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
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
                    let id = args.positional.get(2).ok_or("usage: bsc compliance standards get <id>")?;
                    let s = open_store()?;
                    // Print `null` for a miss (mirrors `bsc skill group get`).
                    print_json(&s.get(id), args.pretty);
                    Ok(())
                }
                "" => Err(format!(
                    "usage: bsc compliance standards <list|get>\n\n{}",
                    bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "standards")
                )),
                other => Err(format!(
                    "unknown standards command '{other}'\n\n{}",
                    bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "standards")
                )),
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
                .ok_or("usage: bsc compliance accessibility <target>")?;
            let engine = Engine::with_store(open_store()?);
            print_json(&engine.accessibility_checklist(target), args.pretty);
            Ok(())
        }
        "privacy" => {
            // `<data-types>` is a positional comma-separated list (e.g. `pii,health`).
            let data_types = csv(args.positional.get(1).map(String::as_str).unwrap_or(""));
            if data_types.is_empty() {
                return Err("usage: bsc compliance privacy <data-types> [--regions a,b]".into());
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
            let id = args.positional.get(1).ok_or("usage: bsc compliance remove <id>")?;
            let s = open_store()?;
            print_json(&s.remove(id)?, args.pretty);
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// Resolve the store path via the shared `--db` → `$BSC_COMPLIANCE_STORE` → default precedence
/// ([`bsc_cli_util::resolve_store_path`]). The default is [`Store::default_path`], which falls back to
/// `~/.base-studio-code/compliance/store.db` (it re-checks the env var, a harmless redundancy since
/// the shared resolver only reaches the default when the env var is unset/empty).
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_COMPLIANCE_STORE", || {
        Store::default_path()
            .ok_or_else(|| "could not resolve a store path; pass --db <path> or set BSC_COMPLIANCE_STORE".to_string())
    })
}

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

    #[test]
    fn parse_args_routes_help_flag_to_the_help_command() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc compliance", TAGLINE, COMMANDS);
        for c in ["standards", "requirements", "accessibility", "privacy", "meta", "reseed", "upsert", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // `standards help` shows the standards subcommands, not the whole menu.
        let s = bsc_cli_util::help_for("bsc compliance", TAGLINE, COMMANDS, "standards");
        assert!(s.contains("bsc compliance standards"));
        assert!(s.contains("get <id>"));
        assert!(!s.contains("reseed"));
        // An unknown command falls back to the overview.
        assert!(bsc_cli_util::help_for("bsc compliance", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
