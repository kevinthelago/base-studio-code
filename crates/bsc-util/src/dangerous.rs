//! The canonical always-on dangerous-bash floor (#1844).
//!
//! The catastrophic-`bash` floor was expressed twice, in two forms, with a comment admitting the
//! hazard: the Claude harness wrote `Bash(<glob>)` deny rules into `.claude/settings.json`
//! (`console/settings.rs`'s `DEFAULT_DENY`), and the `bsc-agent` runtime substring-matched its own
//! `BASE_DANGEROUS_BASH` (doc: *"Keep roughly in sync with `DEFAULT_DENY`"*).
//!
//! This is the ONE list both render from. Each entry carries the two renderings side by side — the
//! Claude `Bash(<glob>)` rule and the bsc-agent substring — so the relationship is stated once and
//! can't drift. The two floors are NOT identical sets (by design: the Claude floor adds
//! `dd`/`shutdown`/`reboot` + the `curl|sh` exfil tail, which bsc-agent leaves to the `bsc-taint`
//! hook #1167; the bsc-agent floor adds the `:(){` fork bomb), so each rendering is the `Option` it
//! applies to. The entry order reproduces BOTH legacy lists verbatim (a regression test pins each).

/// One catastrophic `bash` pattern in the always-on floor, with its per-harness rendering.
pub struct DangerousCmd {
    /// The Claude Code `Bash(<glob>)` deny rule written into `.claude/settings.json`, if this pattern
    /// is in the Claude harness floor. `None` ⇒ not in the Claude floor.
    pub claude_rule: Option<&'static str>,
    /// The substring the `bsc-agent` runtime matches against a command (`Permissions::check`), if this
    /// pattern is in the bsc-agent floor. Coarser than Claude's prefix glob. `None` ⇒ not in it.
    pub agent_substring: Option<&'static str>,
}

/// The canonical floor. Order is the legacy `DEFAULT_DENY` order with the bsc-agent-only fork bomb
/// slotted where `BASE_DANGEROUS_BASH` had it (after `mkfs`), so filtering by either rendering
/// reproduces that harness's legacy list verbatim — order and all.
pub const DANGEROUS_BASH: &[DangerousCmd] = &[
    DangerousCmd { claude_rule: Some("Bash(sudo *)"), agent_substring: Some("sudo ") },
    DangerousCmd { claude_rule: Some("Bash(rm -rf /*)"), agent_substring: Some("rm -rf /") },
    DangerousCmd { claude_rule: Some("Bash(rm -fr /*)"), agent_substring: Some("rm -fr /") },
    DangerousCmd { claude_rule: Some("Bash(rm -rf ~*)"), agent_substring: Some("rm -rf ~") },
    DangerousCmd { claude_rule: Some("Bash(dd *)"), agent_substring: None },
    DangerousCmd { claude_rule: Some("Bash(mkfs *)"), agent_substring: Some("mkfs.") },
    DangerousCmd { claude_rule: None, agent_substring: Some(":(){") }, // fork bomb (bsc-agent only)
    DangerousCmd { claude_rule: Some("Bash(shutdown *)"), agent_substring: None },
    DangerousCmd { claude_rule: Some("Bash(reboot *)"), agent_substring: None },
    DangerousCmd { claude_rule: Some("Bash(git push --force*)"), agent_substring: Some("git push --force") },
    DangerousCmd { claude_rule: Some("Bash(git push -f *)"), agent_substring: Some("git push -f ") },
    DangerousCmd { claude_rule: Some("Bash(curl *| sh)"), agent_substring: None },
    DangerousCmd { claude_rule: Some("Bash(curl *| bash)"), agent_substring: None },
    DangerousCmd { claude_rule: Some("Bash(wget *| sh)"), agent_substring: None },
];

/// The Claude harness deny rules — the `Bash(<glob>)` floor written into `.claude/settings.json`'s
/// deny array. (Replaces the legacy `DEFAULT_DENY` const.)
pub fn claude_deny_rules() -> impl Iterator<Item = &'static str> {
    DANGEROUS_BASH.iter().filter_map(|d| d.claude_rule)
}

/// The bsc-agent runtime substring floor — matched against each `bash` command in `Permissions::check`.
/// (Replaces the legacy `BASE_DANGEROUS_BASH` const.)
pub fn agent_dangerous_substrings() -> impl Iterator<Item = &'static str> {
    DANGEROUS_BASH.iter().filter_map(|d| d.agent_substring)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_floor_is_byte_identical_to_the_legacy_default_deny() {
        // Pins the exact `.claude/settings.json` deny rules the Claude harness wrote before #1844 —
        // same rules, same order — so unifying the floor changes no Claude behavior.
        let rules: Vec<&str> = claude_deny_rules().collect();
        assert_eq!(
            rules,
            [
                "Bash(sudo *)", "Bash(rm -rf /*)", "Bash(rm -fr /*)", "Bash(rm -rf ~*)", "Bash(dd *)",
                "Bash(mkfs *)", "Bash(shutdown *)", "Bash(reboot *)", "Bash(git push --force*)",
                "Bash(git push -f *)", "Bash(curl *| sh)", "Bash(curl *| bash)", "Bash(wget *| sh)",
            ],
        );
    }

    #[test]
    fn agent_floor_is_byte_identical_to_the_legacy_base_dangerous_bash() {
        // Pins the exact bsc-agent runtime substrings — same set, same order — so the runtime floor is
        // unchanged (no security regression on the model-agnostic harness).
        let subs: Vec<&str> = agent_dangerous_substrings().collect();
        assert_eq!(
            subs,
            ["sudo ", "rm -rf /", "rm -fr /", "rm -rf ~", "mkfs.", ":(){", "git push --force", "git push -f "],
        );
    }

    #[test]
    fn every_entry_is_in_at_least_one_floor() {
        for d in DANGEROUS_BASH {
            assert!(
                d.claude_rule.is_some() || d.agent_substring.is_some(),
                "a dangerous-floor entry must render into at least one harness",
            );
        }
    }
}
