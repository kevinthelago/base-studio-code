//! The blocking decision for one Bash tool call — **one implementation, two callers**.
//!
//! This function used to live in `crates/bsc/src/hook.rs` as a private `deny_reason`. It moved here
//! for a specific reason: a session inside a `bsc-sandbox` mount namespace cannot reach the `bsc`
//! umbrella binary (binding it would mean binding a writable SQLite store — the exact ambient
//! authority the isolation removes), so the check has to be compiled into a small static binary
//! that IS bound. That is a second caller, and a second caller is how a rule gets written twice and
//! drifts.
//!
//! `dangerous.rs` exists *because* this floor was once expressed twice and drifted. Rather than
//! repeat that, the decision lives in one place with zero dependencies and both binaries call it:
//! `bsc hook bash-deny` on a host with no namespace, `bsc-hook` inside one.

/// The blocking reason for `cmd`, if any: the always-on dangerous floor ([`crate::dangerous`],
/// compiled in — the same source the bsc-agent runtime uses) first, then the newline-separated
/// `env_denies` (`$BSC_DENY_BASH` — the session's role/user deny patterns). `None` ⇒ allow.
///
/// Pure: no I/O, no env reads. The caller supplies `env_denies`, which is what makes it testable
/// and what lets the sandboxed binary receive the value through the namespace's declared env rather
/// than by inheriting one.
pub fn deny_reason(cmd: &str, env_denies: &str) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }
    // #3948: `dangerous_match` excludes heredoc BODIES written by an inert reader (`cat`/`tee`), so
    // the floor scans the COMMAND and not the FILE CONTENT it writes. A worker was blocked writing a
    // Rust file whose doc comment illustrated an unsafe raw value with `rm -rf /`. A body piped into an
    // interpreter (`bash <<EOF`) is still scanned — that one IS a command.
    if let Some(p) = crate::dangerous::dangerous_match(cmd) {
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
        .find(|&p| crate::deny::deny_matches(cmd, p))
        .map(|p| format!("the denied pattern '{p}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_command_is_allowed() {
        assert_eq!(deny_reason("", "rm"), None);
    }

    #[test]
    fn the_builtin_floor_blocks_without_any_session_denies() {
        // The floor is compiled in, so it holds even when the session supplies no patterns — which
        // is exactly the state a sandboxed session is in if its env carries no BSC_DENY_BASH.
        let r = deny_reason("rm -rf /", "").expect("the floor must block this");
        assert!(r.contains("dangerous-command floor"), "{r}");
    }

    #[test]
    fn a_session_deny_matches_the_program_token_not_a_path_substring() {
        // #3483's regression, pinned at the shared location now that two binaries depend on it.
        assert!(deny_reason("vi notes.txt", "vi").is_some());
        assert_eq!(deny_reason("ls /home/Kevin/src", "vi"), None);
        assert_eq!(deny_reason("cat src/shared/ui/x.ts", "ed"), None);
    }

    #[test]
    fn denies_are_newline_separated_and_blank_entries_are_ignored() {
        assert!(deny_reason("tee out.txt", "\n\n tee \n").is_some());
        assert_eq!(deny_reason("echo hi", "\n\n  \n"), None);
    }
}
