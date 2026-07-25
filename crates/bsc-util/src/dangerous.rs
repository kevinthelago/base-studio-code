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
    // ── gh credential-exfiltration + CI-seeding surface (#3793, supply-chain #2433) ──
    // base-studio-code runs many parallel agent sessions with LIVE `gh` auth. These subcommands
    // exfiltrate the token (`gh auth token` prints it to stdout), re-point auth, plant attacker
    // creds/keys, or trigger/enable/disable CI — the exact moves of a Shai-Hulud-class worm. Unlike the
    // role gate's `GH_WRITE_DENY` (which only applies to a `github: "read"` role, and covers the ordinary
    // issue/pr/repo mutations, not these), the floor blocks them in EVERY posture and for EVERY role
    // incl. a `github: "write"` director. Reads (`gh pr view`, `gh issue list`, `gh api` GET, `gh auth
    // status`) and the flow-granted `gh pr create` stay allowed — these are the credential/CI plane only.
    DangerousCmd { claude_rule: Some("Bash(gh auth token*)"), agent_substring: Some("gh auth token") },
    DangerousCmd { claude_rule: Some("Bash(gh auth login*)"), agent_substring: Some("gh auth login") },
    DangerousCmd { claude_rule: Some("Bash(gh auth switch*)"), agent_substring: Some("gh auth switch") },
    DangerousCmd { claude_rule: Some("Bash(gh auth setup-git*)"), agent_substring: Some("gh auth setup-git") },
    DangerousCmd { claude_rule: Some("Bash(gh secret *)"), agent_substring: Some("gh secret ") },
    DangerousCmd { claude_rule: Some("Bash(gh ssh-key add*)"), agent_substring: Some("gh ssh-key add") },
    DangerousCmd { claude_rule: Some("Bash(gh gpg-key add*)"), agent_substring: Some("gh gpg-key add") },
    DangerousCmd { claude_rule: Some("Bash(gh workflow run*)"), agent_substring: Some("gh workflow run") },
    DangerousCmd { claude_rule: Some("Bash(gh workflow enable*)"), agent_substring: Some("gh workflow enable") },
    DangerousCmd { claude_rule: Some("Bash(gh workflow disable*)"), agent_substring: Some("gh workflow disable") },
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
    fn claude_floor_pins_the_full_deny_list() {
        // Pins the exact `.claude/settings.json` deny rules — same rules, same order — so the floor can't
        // drift. The legacy catastrophic set (#1844) followed by the gh credential/CI floor (#3793).
        let rules: Vec<&str> = claude_deny_rules().collect();
        assert_eq!(
            rules,
            [
                // legacy catastrophic floor (#1844) — unchanged
                "Bash(sudo *)", "Bash(rm -rf /*)", "Bash(rm -fr /*)", "Bash(rm -rf ~*)", "Bash(dd *)",
                "Bash(mkfs *)", "Bash(shutdown *)", "Bash(reboot *)", "Bash(git push --force*)",
                "Bash(git push -f *)", "Bash(curl *| sh)", "Bash(curl *| bash)", "Bash(wget *| sh)",
                // gh credential-exfiltration + CI-seeding floor (#3793)
                "Bash(gh auth token*)", "Bash(gh auth login*)", "Bash(gh auth switch*)",
                "Bash(gh auth setup-git*)", "Bash(gh secret *)", "Bash(gh ssh-key add*)",
                "Bash(gh gpg-key add*)", "Bash(gh workflow run*)", "Bash(gh workflow enable*)",
                "Bash(gh workflow disable*)",
            ],
        );
    }

    #[test]
    fn agent_floor_pins_the_full_substring_list() {
        // Pins the exact bsc-agent runtime substrings — same set, same order. Legacy floor (#1844) then
        // the gh credential/CI floor (#3793), so the model-agnostic harness gets the same coverage.
        let subs: Vec<&str> = agent_dangerous_substrings().collect();
        assert_eq!(
            subs,
            [
                "sudo ", "rm -rf /", "rm -fr /", "rm -rf ~", "mkfs.", ":(){", "git push --force", "git push -f ",
                "gh auth token", "gh auth login", "gh auth switch", "gh auth setup-git", "gh secret ",
                "gh ssh-key add", "gh gpg-key add", "gh workflow run", "gh workflow enable", "gh workflow disable",
            ],
        );
    }

    #[test]
    fn gh_credential_and_ci_commands_are_floored_in_both_harnesses() {
        // #3793: every gh credential/CI-abuse command is denied in BOTH harnesses (so it's blocked under
        // every posture + role — the role gate's GH_WRITE_DENY is not enough, it skips a `github: write`
        // role). The exfil/plant/seed verbs must all be covered; the read plane must NOT be.
        let rules: Vec<&str> = claude_deny_rules().collect();
        let subs: Vec<&str> = agent_dangerous_substrings().collect();
        for (rule, sub) in [
            ("Bash(gh auth token*)", "gh auth token"),   // prints the live OAuth token → exfiltration
            ("Bash(gh secret *)", "gh secret "),         // plant/exfil via repo/org secrets
            ("Bash(gh ssh-key add*)", "gh ssh-key add"), // add an attacker key to the account
            ("Bash(gh workflow run*)", "gh workflow run"), // seed/trigger malicious CI
        ] {
            assert!(rules.contains(&rule), "Claude floor must deny {rule}");
            assert!(subs.contains(&sub), "bsc-agent floor must deny {sub}");
        }
        // The read plane stays open — `gh auth status` / `gh pr view` are NOT floored.
        assert!(!subs.iter().any(|s| *s == "gh auth status" || *s == "gh pr view"));
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
