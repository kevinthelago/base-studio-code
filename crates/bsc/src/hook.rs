//! `bsc hook <event>` — internal PreToolUse hook helpers (#1916) that Claude Code runs from a
//! session's `.claude/settings.json`. They read the tool JSON from stdin and exit 2 (Claude's deny
//! convention) to BLOCK a tool call. Unlike `permissions.deny` (which `bypassPermissions` ignores),
//! PreToolUse hooks still fire AND block in every mode — so this is how the deny-list is enforced once
//! a session runs under bypass. Backed by the binary (not fragile shell JSON-parsing) so the floor
//! comes straight from the shared `bsc_util::dangerous` registry, with no pattern drift.

use std::io::Read;

/// Dispatch `bsc hook <event>`.
pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str).unwrap_or("") {
        "bash-deny" => bash_deny(),
        "bash-supply" => bash_supply(),
        "" | "help" | "-h" | "--help" => {
            print!(
                "bsc hook — internal PreToolUse deny hooks (#1916)\n\n\
                 USAGE:\n  \
                 bsc hook bash-deny     # exit 2 if a Bash command hits the dangerous floor or a\n                         \
                 # $BSC_DENY_BASH pattern (reads the tool JSON on stdin)\n  \
                 bsc hook bash-supply   # exit 2 if a Bash command ADDS a malicious or known-vulnerable\n                         \
                 # dependency (OSV via `bsc cve`; #3799). Fail-open (reads the tool JSON on stdin)\n"
            );
            Ok(())
        }
        other => Err(format!("unknown hook '{other}'\n\nrun `bsc hook help`")),
    }
}

/// `bsc hook bash-deny`: read the Bash tool JSON from stdin and exit 2 to block the call when its
/// command matches the dangerous floor or a `$BSC_DENY_BASH` pattern. Fail-open on unreadable/
/// unparseable input is acceptable — the floor is also enforced in the bsc-agent runtime and by
/// Claude's built-in circuit-breakers.
fn bash_deny() -> Result<(), String> {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return Ok(());
    }
    let cmd = serde_json::from_str::<serde_json::Value>(&input)
        .ok()
        .and_then(|v| {
            v.get("tool_input")
                .and_then(|t| t.get("command"))
                .and_then(|c| c.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    let denies = std::env::var("BSC_DENY_BASH").unwrap_or_default();
    if let Some(reason) = deny_reason(&cmd, &denies) {
        log_deny(&cmd, &reason);
        eprintln!("blocked: command matches {reason} — #1916 deny-list");
        std::process::exit(2);
    }
    Ok(())
}

/// `bsc hook bash-supply` (#3799, supply-chain #2433): read the Bash tool JSON from stdin and exit 2 to
/// BLOCK the call when it ADDS a malicious or known-vulnerable dependency — vetted against OSV via the
/// `cve` engine (cache-first). **FAIL-OPEN**: a non-install command, an OSV outage, or any engine error
/// ALLOWS the command (the #3795 scripts-off floor is the always-on protection); a fail-open is logged.
fn bash_supply() -> Result<(), String> {
    let cmd = stdin_command();
    let adds = cve::install::parse_install_command(&cmd);
    if adds.is_empty() {
        return Ok(()); // fast path: not a dependency add — the overwhelming majority of commands
    }
    let engine = match cve::Engine::from_env() {
        Ok(e) => e,
        Err(e) => {
            log_supply(&cmd, "failopen", &format!("cve engine unavailable: {e}"));
            return Ok(());
        }
    };
    let min = supply_min_severity();
    for pkg in &adds {
        match engine.check(pkg) {
            Ok(report) => {
                if let Some(reason) = supply_block_reason(&report, min) {
                    log_supply(&cmd, "block", &reason);
                    eprintln!("blocked: {reason} — #3799 supply-chain gate");
                    std::process::exit(2);
                }
            }
            // Offline / rate-limited / bad response: fail-open per package (log, don't block the fleet).
            Err(e) => log_supply(&cmd, "failopen", &format!("OSV check failed for {}: {e}", pkg.name)),
        }
    }
    Ok(())
}

/// Read the Bash `tool_input.command` from a hook's stdin JSON (empty on any read/parse failure).
fn stdin_command() -> String {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return String::new();
    }
    serde_json::from_str::<serde_json::Value>(&input)
        .ok()
        .and_then(|v| {
            v.get("tool_input").and_then(|t| t.get("command")).and_then(|c| c.as_str()).map(str::to_string)
        })
        .unwrap_or_default()
}

/// The block reason for a checked add, if any (pure — the testable core of [`bash_supply`]):
/// (1) a MALICIOUS package (`MAL-…`) is blocked at ANY version; (2) a VERSION-PINNED add whose exact
/// version carries a vulnerability at/above `min` is blocked (OSV's versioned query already scoped the
/// advisories to that version, so every advisory here affects it); (3) a versionless non-malicious add
/// is ALLOWED (the resolved version is unknown pre-install — `bsc cve scan` covers it after). `None` ⇒ allow.
fn supply_block_reason(report: &cve::PackageReport, min: cve::Severity) -> Option<String> {
    let name = &report.package.name;
    if let Some(mal) = report.advisories.iter().find(|a| a.is_malicious()) {
        return Some(format!("{name} is a known-MALICIOUS package ({})", mal.id));
    }
    if let Some(version) = report.package.version.as_deref() {
        if let Some(v) = report.advisories.iter().filter(|a| a.severity >= min).max_by_key(|a| a.severity) {
            return Some(format!("{name}@{version} has a known {} vulnerability ({})", v.severity.as_str(), v.id));
        }
    }
    None
}

/// The version-pinned vulnerability gate: `$BSC_SUPPLY_MIN` (default `high`), matching `bsc cve scan`.
fn supply_min_severity() -> cve::Severity {
    supply_min_from(&std::env::var("BSC_SUPPLY_MIN").unwrap_or_default())
}

/// Pure: parse the min-severity token, defaulting to `high` (empty/unknown → high).
fn supply_min_from(s: &str) -> cve::Severity {
    cve::Severity::parse(s).unwrap_or(cve::Severity::High)
}

/// Append a `supply`-gate row (`ts·pane·supply·verdict·target·reason`) to `$BSC_PERM_LOG` — verdict
/// `block` or `failopen` — so both a supply block and a fail-open are visible to `bsc logs perm`.
fn log_supply(cmd: &str, verdict: &str, reason: &str) {
    let pane = std::env::var("BSC_AUDIT_PANE").unwrap_or_else(|_| "?".into());
    let ts = now_ms();
    append_perm_log(&perm_log_line(ts, &pane, "supply", verdict, cmd, reason));
}

/// Append one pane-tagged denial row — `ts·pane·gate·verdict·target·reason` — to `$BSC_PERM_LOG`
/// (#1607 slice 2), matching the shape the shell deny hooks write via `__bsc_perm`, so a bash-deny
/// block is visible to `bsc logs perm`/`session`. Best-effort. `gate` is `deny`; `target` is the command.
fn log_deny(cmd: &str, reason: &str) {
    let pane = std::env::var("BSC_AUDIT_PANE").unwrap_or_else(|_| "?".into());
    append_perm_log(&deny_log_line(now_ms(), &pane, cmd, reason));
}

/// The shared perm-log appender: create the parent dir + append `line` to `$BSC_PERM_LOG`. Best-effort —
/// any failure (incl. an unset/empty `$BSC_PERM_LOG`) is swallowed so logging never changes a decision.
fn append_perm_log(line: &str) {
    let path = std::env::var("BSC_PERM_LOG").unwrap_or_default();
    if path.is_empty() {
        return;
    }
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Epoch milliseconds (0 on a clock error).
fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Format one `perm.log` row (`ts·pane·gate·verdict·target·reason` + `\n`). Pure — every free field is
/// stripped of tabs/newlines and capped so a single row can never break the TSV.
fn perm_log_line(ts: u128, pane: &str, gate: &str, verdict: &str, cmd: &str, reason: &str) -> String {
    let clean = |s: &str| s.replace(['\t', '\n'], " ").chars().take(160).collect::<String>();
    format!("{ts}\t{pane}\t{}\t{}\t{}\t{}\n", clean(gate), clean(verdict), clean(cmd), clean(reason))
}

/// The `deny`-gate row (`gate=deny`, `verdict=block`) — the bash-deny block's shape (unchanged).
fn deny_log_line(ts: u128, pane: &str, cmd: &str, reason: &str) -> String {
    perm_log_line(ts, pane, "deny", "block", cmd, reason)
}

/// The blocking reason for `cmd`, if any: the always-on dangerous floor (`bsc_util::dangerous`,
/// compiled in — the same source the bsc-agent runtime uses) first, then the newline-separated
/// `env_denies` (`$BSC_DENY_BASH` — the session's role/user deny patterns). `None` ⇒ allow.
/// Pure — the testable core of [`bash_deny`].
fn deny_reason(cmd: &str, env_denies: &str) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }
    // #3948: `dangerous_match` excludes heredoc BODIES written by an inert reader (`cat`/`tee`), so
    // the floor scans the COMMAND and not the FILE CONTENT it writes. A worker was blocked writing a
    // Rust file whose doc comment illustrated an unsafe raw value with `rm -rf /`. A body piped into an
    // interpreter (`bash <<EOF`) is still scanned — that one IS a command.
    if let Some(p) = bsc_util::dangerous::dangerous_match(cmd) {
        return Some(format!("the built-in dangerous-command floor ('{p}')"));
    }
    // #3483: the session's role/user patterns are PROGRAM NAMES (`vi`, `ed`, `tee`), so they match the
    // program TOKEN — never a substring of an argument or a path. Substring-matching them denied `ed`
    // inside `shared/ui` and `vi` inside `Kevin`, i.e. every absolute path on this machine. The floor
    // above deliberately keeps `contains`: its entries are phrases and prefixes (`mkfs.`, `:(){`).
    env_denies
        .split('\n')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .find(|&p| bsc_util::deny::deny_matches(cmd, p))
        .map(|p| format!("the denied pattern '{p}'"))
}

#[cfg(test)]
mod tests {
    use super::{deny_log_line, deny_reason, perm_log_line, supply_block_reason, supply_min_from};
    use cve::{Advisory, Ecosystem, Package, PackageReport, Severity};

    fn adv(id: &str, sev: Severity) -> Advisory {
        Advisory { id: id.into(), summary: String::new(), severity: sev, aliases: vec![], references: vec![] }
    }

    #[test]
    fn deny_log_line_is_a_well_formed_perm_row() {
        let line = deny_log_line(1782468000000, "k:web", "git push --force", "the built-in dangerous-command floor ('git push --force')");
        let f: Vec<&str> = line.trim_end().split('\t').collect();
        assert_eq!(f.len(), 6, "ts·pane·gate·verdict·target·reason");
        assert_eq!(f[0], "1782468000000");
        assert_eq!(f[1], "k:web");
        assert_eq!((f[2], f[3]), ("deny", "block"));
        assert_eq!(f[4], "git push --force");
        assert!(f[5].starts_with("the built-in"));
        assert!(line.ends_with('\n'));
    }

    #[test]
    fn deny_log_line_strips_tabs_and_newlines_from_free_fields() {
        // A command/reason with embedded tabs or newlines must not spill into extra TSV columns/rows.
        let line = deny_log_line(0, "k:x", "a\tb\nc", "r\te\nason");
        assert_eq!(line.matches('\t').count(), 5, "exactly the 5 field separators");
        assert_eq!(line.matches('\n').count(), 1, "only the trailing newline");
    }

    #[test]
    fn floor_blocks_catastrophic_commands_regardless_of_env() {
        // The compiled-in floor (shared with the bsc-agent runtime) blocks with NO env denies set.
        assert!(deny_reason("sudo rm -rf /tmp/x", "").is_some());
        assert!(deny_reason("git push --force origin main", "").is_some());
        // ordinary work is allowed.
        assert!(deny_reason("cargo build", "").is_none());
        assert!(deny_reason("git push origin feature", "").is_none());
    }

    #[test]
    fn env_denies_block_session_role_patterns() {
        // Role/user deny patterns (newline-separated) block by substring.
        let denies = "git push\ngh pr merge";
        assert_eq!(
            deny_reason("git push origin main", denies).as_deref(),
            Some("the denied pattern 'git push'"),
        );
        assert!(deny_reason("gh pr merge 7 --merge", denies).is_some());
        // a command matching neither floor nor env denies is allowed.
        assert!(deny_reason("git commit -m wip", denies).is_none());
        // blank/whitespace env lines are ignored (never block everything).
        assert!(deny_reason("ls -la", "\n  \n").is_none());
    }

    #[test]
    fn a_program_name_deny_matches_the_program_not_a_path_substring() {
        // #3483 REGRESSION. These are the exact commands a designer session could not run: its role
        // denies the file writers by bare program name, and substring-matching them hit `ed` inside
        // `shared/ui` and `vi` inside `Kevin` — i.e. every absolute path on this machine.
        let denies = "ed
vi
tee
cp";
        assert!(deny_reason("bsc ui harvest src/shared/ui", denies).is_none(), "`ed` inside `shared`");
        assert!(deny_reason("ls C:/Users/Kevin/Projects", denies).is_none(), "`vi` inside `Kevin`");
        assert!(deny_reason("cat src/index.ts", denies).is_none(), "`ed`/`ex` inside `index`");
        // …while the programs themselves are still denied, including through a pipeline or `sh -c`.
        assert!(deny_reason("vi notes.txt", denies).is_some());
        assert!(deny_reason("cat a | tee b", denies).is_some());
        assert!(deny_reason("sh -c \"tee out\"", denies).is_some(), "no -c bypass");
        // …and the compiled-in floor keeps its substring semantics regardless of the env list.
        assert!(deny_reason("sudo rm -rf /tmp/x", denies).is_some());
    }

    #[test]
    fn empty_command_is_allowed() {
        assert!(deny_reason("", "git push").is_none());
    }

    #[test]
    fn supply_blocks_malicious_packages_at_any_version() {
        // A MAL- advisory blocks the add regardless of whether a version was requested — the package
        // itself is the payload (the Shai-Hulud case).
        let versionless = PackageReport { package: Package::new(Ecosystem::Npm, "evil", None), advisories: vec![adv("MAL-2024-1", Severity::Unknown)] };
        let r = supply_block_reason(&versionless, Severity::High).unwrap();
        assert!(r.contains("MALICIOUS") && r.contains("MAL-2024-1"), "{r}");
    }

    #[test]
    fn supply_blocks_a_pinned_vuln_only_at_or_above_threshold() {
        // Version-pinned + a high vuln, threshold high → blocked, naming the version + advisory.
        let pinned = PackageReport { package: Package::new(Ecosystem::Npm, "lodash", Some("4.17.0".into())), advisories: vec![adv("GHSA-h", Severity::High)] };
        let r = supply_block_reason(&pinned, Severity::High).unwrap();
        assert!(r.contains("lodash@4.17.0") && r.contains("GHSA-h") && r.contains("high"), "{r}");
        // Below threshold → allowed.
        let low = PackageReport { package: Package::new(Ecosystem::Npm, "x", Some("1.0.0".into())), advisories: vec![adv("GHSA-l", Severity::Low)] };
        assert!(supply_block_reason(&low, Severity::High).is_none());
        // The SAME high vuln but VERSIONLESS + non-malicious → allowed (can't pin to the resolved version).
        let versionless = PackageReport { package: Package::new(Ecosystem::Npm, "lodash", None), advisories: vec![adv("GHSA-h", Severity::High)] };
        assert!(supply_block_reason(&versionless, Severity::High).is_none());
        // Clean → allowed.
        let clean = PackageReport { package: Package::new(Ecosystem::Npm, "safe", Some("1.0.0".into())), advisories: vec![] };
        assert!(supply_block_reason(&clean, Severity::High).is_none());
    }

    #[test]
    fn supply_min_defaults_to_high() {
        assert_eq!(supply_min_from(""), Severity::High);
        assert_eq!(supply_min_from("garbage"), Severity::High);
        assert_eq!(supply_min_from("critical"), Severity::Critical);
        assert_eq!(supply_min_from("moderate"), Severity::Medium);
    }

    #[test]
    fn supply_log_line_is_a_well_formed_supply_row() {
        let line = perm_log_line(1782468000000, "k:web", "supply", "block", "npm add evil", "evil is a known-MALICIOUS package (MAL-2024-1)");
        let f: Vec<&str> = line.trim_end().split('\t').collect();
        assert_eq!(f.len(), 6, "ts·pane·gate·verdict·target·reason");
        assert_eq!((f[2], f[3]), ("supply", "block"));
        assert_eq!(f[4], "npm add evil");
        assert!(f[5].contains("MALICIOUS"));
        assert!(line.ends_with('\n'));
    }
}
