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
        eprintln!("blocked: command matches {reason} — #1916 deny-list");
        std::process::exit(2);
    }
    Ok(())
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
    env_denies
        .split('\n')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .find(|&p| cmd.contains(p))
        .map(|p| format!("the denied pattern '{p}'"))
}

#[cfg(test)]
mod tests {
    use super::deny_reason;

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
    fn empty_command_is_allowed() {
        assert!(deny_reason("", "git push").is_none());
    }
}
