//! The `bsc cve` subcommand (#3797, supply-chain #2433) — the session-facing CLI over the OSV.dev
//! vulnerability data layer. Three verbs:
//!   • `scan [path]`  — parse a lockfile/manifest, batch-query OSV, report the vulnerable packages;
//!                      **exit 2** when a finding is at/above `--min-severity` (default `high`), so CI,
//!                      triage, and the install hook can gate on the exit code (0 clean · 1 error · 2 vulns).
//!   • `check <ecosystem> <name> [version]` — advisories for one package (the per-add primitive).
//!   • `get <id>`     — one advisory's full record (or `null`).
//!
//! Output is JSON to stdout (compact; `--pretty` indents). The cache is located via `--db` →
//! `$BSC_CVE_DB` → the default (`Cache::default_path`), mirroring the `bsc compliance` house style.

use crate::cache::Cache;
use crate::engine::Engine;
use crate::lockfile;
use crate::types::{Ecosystem, Package, Severity};
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::print_json;

const TAGLINE: &str = "the CVE / vulnerability data layer — OSV.dev advisories for a package or a whole lockfile (#3797)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "scan",
        summary: "scan a lockfile/manifest for known-vulnerable packages",
        usage: "\
USAGE:
  bsc cve scan [path] [--min-severity <s>]

Parse a lockfile (package-lock.json, Cargo.lock, requirements.txt) — or, given a directory, the first
one found in it (default: the current directory) — batch-query OSV, and print the vulnerable packages
with their advisories. EXIT CODE: 0 = clean, 1 = error, 2 = a finding at/above --min-severity.

<s> is one of: unknown | low | medium | high | critical (default: high). `--min-severity none` never
gates (always exits 0).",
    },
    CmdDoc {
        name: "check",
        summary: "advisories affecting one package/version",
        usage: "\
USAGE:
  bsc cve check <ecosystem> <name> [version]

<ecosystem> is one of: npm | cargo | pypi | go | maven | nuget | rubygems. Prints the package's
advisories (empty array = no known vulnerabilities). Pass the exact <version> so OSV resolves which
advisories actually affect this install.",
    },
    CmdDoc {
        name: "get",
        summary: "one advisory's full record by id",
        usage: "\
USAGE:
  bsc cve get <id>

<id> is an OSV id (usually a GHSA-… or CVE-…). Prints the advisory record, or null if unknown.",
    },
];

/// Parsed flags + leftover positionals.
struct Args {
    db: Option<String>,
    pretty: bool,
    min_severity: Severity,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { db: None, pretty: false, min_severity: Severity::High, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--pretty" => a.pretty = true,
            "--json" => {} // output is always JSON; accepted so callers can be explicit
            "--min-severity" | "--fail-on" => {
                let v = it.next().ok_or("--min-severity needs a value")?;
                a.min_severity = Severity::parse(&v)
                    .ok_or_else(|| format!("unknown severity '{v}' (expected unknown|low|medium|high|critical)"))?;
            }
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `cve` subcommand entrypoint: `args` is everything after `bsc cve`; `prog` is the display name.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    let cmd = args.positional.first().cloned().unwrap_or_default();
    // The cache path via the shared `--db` → `$BSC_CVE_DB` → default precedence (the compliance style).
    let engine = || {
        let path = bsc_cli_util::resolve_store_path(&args.db, "BSC_CVE_DB", || {
            Cache::default_path()
                .ok_or_else(|| "could not resolve a cve cache path; pass --db <path> or set BSC_CVE_DB".to_string())
        })?;
        Engine::open(&path).map_err(|e| format!("opening the cve engine: {e}"))
    };

    match cmd.as_str() {
        "scan" => {
            let path = args.positional.get(1).map(String::as_str).unwrap_or(".");
            let packages = lockfile::scan_path(std::path::Path::new(path))?;
            let report = engine()?.scan(&packages)?;
            print_json(&report, args.pretty);
            // Exit 2 (distinct from an error's 1) when a finding breaches the gate, so CI / the install
            // hook can act on the code without parsing the JSON. `--min-severity none` disables gating.
            if args.min_severity != Severity::Unknown && report.breaches(args.min_severity) {
                std::process::exit(2);
            }
            Ok(())
        }
        "check" => {
            let eco = args.positional.get(1).ok_or("usage: bsc cve check <ecosystem> <name> [version]")?;
            let ecosystem = Ecosystem::parse(eco)
                .ok_or_else(|| format!("unknown ecosystem '{eco}' (expected npm|cargo|pypi|go|maven|nuget|rubygems)"))?;
            let name = args.positional.get(2).ok_or("usage: bsc cve check <ecosystem> <name> [version]")?;
            let version = args.positional.get(3).cloned();
            let report = engine()?.check(&Package::new(ecosystem, name.clone(), version))?;
            print_json(&report, args.pretty);
            Ok(())
        }
        "get" => {
            let id = args.positional.get(1).ok_or("usage: bsc cve get <id>")?;
            // Print `null` for an unknown id (mirrors `bsc compliance standards get`).
            print_json(&engine()?.get(id)?, args.pretty);
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_defaults_min_severity_to_high() {
        let a = parse_args(vec!["scan".into()]).unwrap();
        assert_eq!(a.min_severity, Severity::High);
        assert_eq!(a.positional, vec!["scan".to_string()]);
    }

    #[test]
    fn parse_args_reads_min_severity_and_aliases() {
        let a = parse_args(["scan", ".", "--min-severity", "moderate"].iter().map(|s| s.to_string()).collect()).unwrap();
        assert_eq!(a.min_severity, Severity::Medium, "moderate → medium");
        assert_eq!(a.positional, vec!["scan".to_string(), ".".to_string()]);
        // --fail-on is an accepted alias.
        let a = parse_args(["scan", "--fail-on", "critical"].iter().map(|s| s.to_string()).collect()).unwrap();
        assert_eq!(a.min_severity, Severity::Critical);
    }

    #[test]
    fn parse_args_rejects_bad_severity_and_unknown_flag() {
        assert!(parse_args(vec!["scan".into(), "--min-severity".into(), "nope".into()]).is_err());
        assert!(parse_args(vec!["scan".into(), "--bogus".into()]).is_err());
    }

    #[test]
    fn parse_args_routes_help_flag() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn help_overview_lists_the_three_verbs() {
        let ov = bsc_cli_util::help_overview("bsc cve", TAGLINE, COMMANDS);
        for c in ["scan", "check", "get"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let s = bsc_cli_util::help_for("bsc cve", TAGLINE, COMMANDS, "check");
        assert!(s.contains("bsc cve check"));
        assert!(s.contains("ecosystem"));
    }

    #[test]
    fn unknown_command_is_refused_with_the_overview() {
        let e = run(vec!["frobnicate".into()], "bsc cve").unwrap_err();
        assert!(e.contains("unknown command 'frobnicate'"));
        assert!(e.contains("COMMANDS:"));
    }

    #[test]
    fn check_rejects_an_unknown_ecosystem_before_touching_the_network() {
        // `check` with a bad ecosystem fails at parse time — no engine/network needed.
        let e = run(vec!["check".into(), "cobol".into(), "some-pkg".into()], "bsc cve").unwrap_err();
        assert!(e.contains("unknown ecosystem 'cobol'"), "{e}");
    }
}
