//! The `bsc security` surface — every detector, one finding list.
//!
//! `bsc cve` survives as a deprecated alias over the same crate (the `bsc org` → `bsc teams` and
//! `bsc component` → `bsc ui` precedent), and its exit-code contract is untouched: 0 clean, 1 error,
//! 2 a finding at or above `--min-severity`. That contract is load-bearing for CI, for triage and
//! for the install hook, so the widening had to be additive rather than a replacement.

use crate::engine::Engine;
use crate::finding::{rank, Finding, Kind, Locator};
use crate::lockfile;
use crate::secrets;
use crate::types::{PackageReport, Severity};
use bsc_cli_util::CmdDoc;
use std::path::Path;

const TAGLINE: &str =
    "the security surface — dependencies, leaked credentials, one ranked finding list (widened from `bsc cve`, which still works)";

/// How many commits of history the secrets detector walks by default. Bounded because an unbounded
/// walk on a large repository is indistinguishable from a hang.
pub const DEFAULT_HISTORY_COMMITS: usize = 200;

pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "scan",
        summary: "run every detector over a repo and rank what they found",
        usage: "\
USAGE:
  bsc security scan [path] [--min-severity <s>] [--only deps|secrets] [--history <n>] [--no-history]

Runs each detector and returns ONE ranked list rather than several reports, because a security
surface that emits a different shape per detector cannot rank across them.

  deps     lockfile dependencies against OSV.dev advisories
  secrets  credentials in the working tree AND in git history

EXIT CODE: 0 clean · 1 error · 2 a finding at/above --min-severity (default high) — the same
contract `bsc cve scan` has always had.

A detector that fails does NOT lose the other's findings; its error is reported alongside them.

HISTORY IS SCANNED BY DEFAULT, bounded to the last 200 commits (--history <n> to change,
--no-history to skip). A credential deleted from the working tree is still in the pack and still
valid until it is rotated, so a working-tree-only scan reports clean on a repo that is still
leaking. The bound is printed, so a clean result is never mistaken for `all of history is clean`.",
    },
    CmdDoc {
        name: "secrets",
        summary: "leaked credentials only — working tree and git history",
        usage: "\
USAGE:
  bsc security secrets [path] [--history <n>] [--no-history]

Matches VENDOR-ISSUED SHAPES (AWS, GitHub, Anthropic, OpenAI, Slack, Stripe, Google, SendGrid, npm,
PEM private keys) — a fixed prefix plus a known body length — never entropy. Entropy alone fires on
lockfile integrity hashes, git object ids and base64 fixtures, and a scanner that cries wolf gets
switched off, after which its silence reads as a clean result.

The cost of that choice, stated plainly: a bespoke or self-issued credential with no recognisable
shape is NOT found, and no tuning changes that.

EVERY MATCH IS REDACTED and the raw value is never stored. Findings flow into terminals, logs and
append-only plan notes, so a scanner that printed what it found would itself be the leak.",
    },
    CmdDoc {
        name: "deps",
        summary: "dependencies against OSV.dev — the former `bsc cve scan`",
        usage: "\
USAGE:
  bsc security deps [path] [--min-severity <s>]

Parses a lockfile (package-lock.json, Cargo.lock, requirements.txt) — or, given a directory, the
first one found — batch-queries OSV.dev, and reports each vulnerable package as a finding.

Identical in behaviour to `bsc cve scan`, which remains available.",
    },
    CmdDoc {
        name: "rules",
        summary: "what the secrets detector can and cannot recognize",
        usage: "\
USAGE:
  bsc security rules

Lists every credential shape, its severity, and its prefix. Printed rather than buried, because the
useful question about a secrets scanner is what it MISSES, and that is answerable only from the rule
list.",
    },
];

/// A dependency report rendered as findings — the bridge that lets OSV results rank alongside
/// secrets. The advisory ids ride in `refs`, so nothing the old report carried is lost.
pub fn findings_from_packages(reports: &[PackageReport], manifest: Option<&str>) -> Vec<Finding> {
    reports
        .iter()
        .map(|r| {
            let worst = r.max_severity();
            let title = r
                .advisories
                .iter()
                .max_by_key(|a| a.severity)
                .map(|a| a.summary.clone())
                .unwrap_or_else(|| "known advisory".to_string());
            Finding::new(
                Kind::VulnerableDependency,
                worst,
                title,
                Locator::Package {
                    ecosystem: r.package.ecosystem.as_str().to_string(),
                    name: r.package.name.clone(),
                    version: r.package.version.clone(),
                    manifest: manifest.map(str::to_string),
                },
            )
            .with_refs(r.advisories.iter().map(|a| a.id.clone()).collect())
        })
        .collect()
}

/// The result of a whole scan: what was found, and what failed while finding it.
#[derive(Debug, Default)]
pub struct ScanOutcome {
    pub findings: Vec<Finding>,
    /// Per-detector errors. A failing detector never costs another its findings.
    pub errors: Vec<String>,
    /// How many commits of history were walked (`None` when skipped) — reported so a clean result
    /// is never read as a claim about all of history.
    pub history_commits: Option<usize>,
}

impl ScanOutcome {
    /// The worst severity found.
    pub fn max_severity(&self) -> Severity {
        self.findings.iter().map(|f| f.severity).max().unwrap_or(Severity::Unknown)
    }

    /// Does this scan breach the gate? Same predicate shape as `ScanReport::breaches`, kept pure so
    /// the CLI's exit is a one-liner over a tested function.
    pub fn breaches(&self, min: Severity) -> bool {
        !self.findings.is_empty() && self.max_severity() >= min
    }
}

/// Run the secrets detector over a tree and optionally its history.
pub fn run_secrets(root: &Path, history: Option<usize>) -> ScanOutcome {
    let mut out = ScanOutcome { history_commits: history, ..Default::default() };
    match secrets::scan_tree(root) {
        Ok(mut f) => out.findings.append(&mut f),
        Err(e) => out.errors.push(format!("secrets (working tree): {e}")),
    }
    if let Some(n) = history {
        match secrets::scan_history(root, n) {
            Ok(mut f) => out.findings.append(&mut f),
            Err(e) => out.errors.push(format!("secrets (history): {e}")),
        }
    }
    out.findings = rank(std::mem::take(&mut out.findings));
    out
}

/// Run the dependency detector over a path.
pub fn run_deps(path: &Path) -> ScanOutcome {
    let mut out = ScanOutcome::default();
    let packages = match lockfile::scan_path(path) {
        Ok(p) => p,
        Err(e) => {
            out.errors.push(format!("deps: {e}"));
            return out;
        }
    };
    match Engine::from_env().and_then(|e| e.scan(&packages)) {
        Ok(report) => out.findings = rank(findings_from_packages(&report.packages, None)),
        Err(e) => out.errors.push(format!("deps: {e}")),
    }
    out
}

/// The `security` subcommand entrypoint.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let mut min = Severity::High;
    let (mut pretty, mut json, mut only, mut history) = (false, false, None::<String>, Some(DEFAULT_HISTORY_COMMITS));
    let ((), positional) = bsc_cli_util::args::walk(
        args,
        (),
        |flag, _: &mut (), v| {
            match flag {
                "--pretty" => pretty = true,
                "--json" => json = true,
                "--no-history" => history = None,
                "--history" => {
                    let n = v.value("--history needs a number of commits")?;
                    history = Some(n.parse::<usize>().map_err(|_| format!("--history expects a number, got '{n}'"))?);
                }
                "--only" => only = Some(v.value("--only needs deps|secrets")?),
                "--min-severity" | "--fail-on" => {
                    let s = v.value("--min-severity needs a value")?;
                    min = Severity::parse(&s)
                        .ok_or_else(|| format!("unknown severity '{s}' (expected unknown|low|medium|high|critical)"))?;
                }
                _ => return Ok(false),
            }
            Ok(true)
        },
    )?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &positional) {
        return Ok(());
    }
    let verb = positional.first().cloned().unwrap_or_default();
    let path = positional.get(1).cloned().unwrap_or_else(|| ".".to_string());
    let root = Path::new(&path);
    match verb.as_str() {
        "rules" => {
            let rows: Vec<_> = secrets::RULES
                .iter()
                .map(|r| serde_json::json!({ "id": r.id, "title": r.title, "prefix": r.prefix, "severity": r.severity }))
                .collect();
            bsc_cli_util::emit(pretty, json, &rows, || {
                let mut s = String::new();
                for r in secrets::RULES {
                    s.push_str(&format!("{:<22} {:<10} {:<14} {}\n", r.id, r.severity.as_str(), r.prefix, r.title));
                }
                s.push_str("private-key            critical   -----BEGIN…   PEM private key headers\n");
                s.push_str(
                    "\nWHAT THIS MISSES: a bespoke or self-issued credential with no recognizable shape.\n\
                     Every rule is a vendor-issued prefix plus a known body length, never entropy —\n\
                     entropy fires on lockfile hashes, git object ids and base64 fixtures.\n",
                );
                s
            });
            Ok(())
        }
        "secrets" | "deps" | "scan" => {
            let mut out = ScanOutcome { history_commits: history, ..Default::default() };
            let want = only.as_deref();
            if verb != "deps" && want != Some("deps") {
                let mut s = run_secrets(root, history);
                out.findings.append(&mut s.findings);
                out.errors.append(&mut s.errors);
            }
            if verb != "secrets" && want != Some("secrets") {
                let mut d = run_deps(root);
                out.findings.append(&mut d.findings);
                out.errors.append(&mut d.errors);
            }
            out.findings = rank(std::mem::take(&mut out.findings));
            let breached = out.breaches(min);
            bsc_cli_util::emit(pretty, json, &serde_json::json!({
                "findings": out.findings, "errors": out.errors,
                "historyCommits": out.history_commits, "maxSeverity": out.max_severity(),
            }), || render(&out));
            if breached {
                std::process::exit(2);
            }
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// The lean rendering.
fn render(out: &ScanOutcome) -> String {
    let mut s = String::new();
    for f in &out.findings {
        s.push_str(&format!(
            "{:<9} {:<22} {:<34} {}\n",
            f.severity.as_str(),
            f.kind.as_str(),
            f.locator.label(),
            f.title
        ));
        if let Some(e) = &f.evidence {
            s.push_str(&format!("          {e}\n"));
        }
    }
    if out.findings.is_empty() {
        s.push_str("no findings\n");
    }
    // Say what was NOT looked at, so a clean result is never read as a broader claim than it is.
    match out.history_commits {
        Some(n) => s.push_str(&format!("\n{} finding(s) · history: last {n} commit(s)\n", out.findings.len())),
        None => s.push_str(&format!("\n{} finding(s) · history NOT scanned\n", out.findings.len())),
    }
    for e in &out.errors {
        s.push_str(&format!("error: {e}\n"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Advisory, Ecosystem, Package};

    fn advisory(id: &str, sev: Severity) -> Advisory {
        Advisory { id: id.into(), summary: format!("{id} summary"), severity: sev, aliases: vec![], references: vec![] }
    }

    #[test]
    fn a_package_report_becomes_a_finding_without_losing_its_advisories() {
        let r = PackageReport {
            package: Package::new(Ecosystem::Npm, "lodash", Some("4.17.20".into())),
            advisories: vec![advisory("GHSA-1", Severity::Medium), advisory("CVE-2", Severity::Critical)],
        };
        let f = &findings_from_packages(std::slice::from_ref(&r), Some("package-lock.json"))[0];
        assert_eq!(f.kind, Kind::VulnerableDependency);
        assert_eq!(f.severity, Severity::Critical, "the finding carries the WORST advisory's severity");
        assert_eq!(f.refs, vec!["GHSA-1", "CVE-2"], "every advisory id survives the bridge");
        assert_eq!(f.locator.label(), "npm:lodash@4.17.20");
    }

    #[test]
    fn the_gate_predicate_matches_the_old_report_contract() {
        // The exit-code contract is load-bearing for CI and the install hook, so the widened
        // predicate must agree with the one `ScanReport::breaches` has always had.
        let r = PackageReport {
            package: Package::new(Ecosystem::Npm, "x", Some("1".into())),
            advisories: vec![advisory("A", Severity::Medium)],
        };
        let out = ScanOutcome { findings: findings_from_packages(&[r], None), ..Default::default() };
        assert!(out.breaches(Severity::Medium), "at the threshold breaches");
        assert!(out.breaches(Severity::Low), "below the threshold breaches");
        assert!(!out.breaches(Severity::High), "above the threshold does not");
    }

    #[test]
    fn an_empty_scan_never_breaches_at_any_threshold() {
        let out = ScanOutcome::default();
        for s in [Severity::Unknown, Severity::Low, Severity::Critical] {
            assert!(!out.breaches(s), "nothing found must exit 0 even at --min-severity unknown");
        }
        assert_eq!(out.max_severity(), Severity::Unknown);
    }

    #[test]
    fn every_command_has_a_usage_block_and_the_tagline_names_the_alias() {
        for c in COMMANDS {
            assert!(bsc_cli_util::help_for("bsc security", TAGLINE, COMMANDS, c.name).contains("USAGE:"));
        }
        assert!(TAGLINE.contains("bsc cve"), "help must say the old noun still works");
    }
}
