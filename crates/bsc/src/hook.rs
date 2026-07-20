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
        "" | "help" | "-h" | "--help" => {
            print!(
                "bsc hook — internal PreToolUse deny hooks (#1916)\n\n\
                 USAGE:\n  \
                 bsc hook bash-deny   # exit 2 if a Bash command hits the dangerous floor or a\n                       \
                 # $BSC_DENY_BASH pattern (reads the tool JSON on stdin)\n"
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

/// Append one pane-tagged denial row — `ts·pane·gate·verdict·target·reason` — to `$BSC_PERM_LOG`
/// (#1607 slice 2), matching the shape the shell deny hooks write via `__bsc_perm`, so a bash-deny
/// block is visible to `bsc logs perm`/`session`. Best-effort: any failure is swallowed so logging
/// never changes the block. `gate` is `deny` (the bash deny-list); `target` is the blocked command.
fn log_deny(cmd: &str, reason: &str) {
    let path = std::env::var("BSC_PERM_LOG").unwrap_or_default();
    if path.is_empty() {
        return;
    }
    let pane = std::env::var("BSC_AUDIT_PANE").unwrap_or_else(|_| "?".into());
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = deny_log_line(ts, &pane, cmd, reason);
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Format one `perm.log` row (`ts·pane·gate·verdict·target·reason` + `\n`) for a bash-deny block.
/// Pure — the free fields (`target`/`reason`) are stripped of tabs/newlines and capped so a single
/// row can never break the TSV. `gate` is fixed `deny`, `verdict` fixed `block`.
fn deny_log_line(ts: u128, pane: &str, cmd: &str, reason: &str) -> String {
    let clean = |s: &str| s.replace(['\t', '\n'], " ").chars().take(160).collect::<String>();
    format!("{ts}\t{pane}\tdeny\tblock\t{}\t{}\n", clean(cmd), clean(reason))
}

/// The blocking reason for `cmd`, if any: the always-on dangerous floor (`bsc_util::dangerous`,
/// compiled in — the same source the bsc-agent runtime uses) first, then the newline-separated
/// `env_denies` (`$BSC_DENY_BASH` — the session's role/user deny patterns). `None` ⇒ allow.
/// Pure — the testable core of [`bash_deny`].
fn deny_reason(cmd: &str, env_denies: &str) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }
    if let Some(p) = bsc_util::dangerous::agent_dangerous_substrings().find(|&p| cmd.contains(p)) {
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
    use super::{deny_log_line, deny_reason};

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
}
