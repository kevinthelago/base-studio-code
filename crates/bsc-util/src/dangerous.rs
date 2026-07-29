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

/// The first word of a shell segment, ignoring leading `env VAR=…` noise and redirections.
fn first_word(seg: &str) -> &str {
    seg.split_whitespace()
        .find(|w| !w.contains('=') && !w.starts_with('<') && !w.starts_with('>'))
        .unwrap_or("")
}

/// Commands that CONSUME a heredoc as data and never execute it. Anything else (`bash`, `sh`, `python`,
/// an unknown program) keeps its heredoc body scanned — a body piped into an interpreter IS a command.
const INERT_HEREDOC_READERS: [&str; 2] = ["cat", "tee"];

/// The heredoc delimiter opened on `line` by an INERT reader, if any — e.g. `cat <<'EOF' > f` ⇒ `EOF`.
/// Handles `<<`/`<<-` and a quoted (`'EOF'`, `"EOF"`) or bare delimiter.
fn inert_heredoc_delimiter(line: &str) -> Option<String> {
    let at = line.find("<<")?;
    // The reader is the first word of the pipeline segment that opens the heredoc.
    let seg = line[..at].rsplit(['|', ';', '&']).next().unwrap_or("");
    let reader = first_word(seg);
    if !INERT_HEREDOC_READERS.contains(&reader) {
        return None;
    }
    let rest = line[at + 2..].trim_start().trim_start_matches('-').trim_start();
    let word: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '>' && *c != '|')
        .collect();
    let d = word.trim_matches(|c| c == '\'' || c == '"').to_string();
    (!d.is_empty()).then_some(d)
}

/// Remove heredoc BODIES fed to a non-executing writer (`cat`/`tee`) so the floor scans the COMMAND and
/// not the FILE CONTENT it writes (#3948).
///
/// A worker was blocked writing `crates/netcon-core/src/primitives.rs` because the Rust doc comment in
/// the heredoc body illustrated an unsafe raw value with `rm -rf /`. Writing a file that MENTIONS a
/// dangerous command is not running one, and the floor made a worker burn a turn rewriting its own
/// source around a security rule that was never aimed at it.
///
/// The reader check is what keeps this safe: `cat <<EOF > f` writes data, while `bash <<EOF` EXECUTES
/// it — only the former is exempted. The opening line, every redirection, and anything after the
/// terminator are all still scanned.
///
/// This does NOT defeat a determined write-then-execute (`cat <<EOF > x.sh … EOF; bash x.sh`) — no
/// substring floor can. Real containment is `bsc-confine` + the sandbox; this floor guards against
/// obvious catastrophe and should not be paid for by blocking ordinary source writes.
pub fn strip_inert_heredoc_bodies(cmd: &str) -> String {
    if !cmd.contains("<<") {
        return cmd.to_string();                       // fast path — no heredoc, nothing to strip
    }
    let mut out = String::with_capacity(cmd.len());
    let mut skip_until: Option<String> = None;
    for line in cmd.split_inclusive('\n') {
        match &skip_until {
            Some(delim) => {
                // The terminator line ends the body; it is kept (it is just the delimiter word).
                if line.trim_end_matches(['\r', '\n']).trim() == delim.as_str() {
                    skip_until = None;
                    out.push_str(line);
                }
                // else: body line — dropped from the scanned text.
            }
            None => {
                out.push_str(line);
                skip_until = inert_heredoc_delimiter(line);
            }
        }
    }
    out
}

/// The floor's verdict for `cmd`: the matched substring, or `None` to allow. Heredoc bodies written by
/// an inert reader are excluded from the scan (#3948). The ONE entry point both harnesses use, so the
/// Claude hook and the bsc-agent runtime cannot drift on what "dangerous" means.
pub fn dangerous_match(cmd: &str) -> Option<&'static str> {
    let scanned = strip_inert_heredoc_bodies(cmd);
    agent_dangerous_substrings().find(|&p| scanned.contains(p))
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

    // ── #3948: the floor scans the COMMAND, not the file CONTENT it writes ───────────────────────
    //
    // A worker was blocked writing crates/netcon-core/src/primitives.rs because the Rust doc comment
    // in the heredoc body illustrated an unsafe raw value with `rm -rf /`. The exemption is scoped by
    // the READER: `cat`/`tee` consume a heredoc as data, an interpreter executes it.

    #[test]
    fn a_file_whose_content_mentions_a_dangerous_command_can_be_written() {
        let cmd = "cat <<'RUSTEOF' > crates/netcon-core/src/primitives.rs\n\
                   //! A raw string could carry `rm -rf /` all the way to a shell.\n\
                   pub struct Command(String);\n\
                   RUSTEOF";
        assert_eq!(dangerous_match(cmd), None, "writing a file that MENTIONS the pattern is not running it");
    }

    #[test]
    fn a_heredoc_piped_into_an_interpreter_is_still_floored() {
        // The whole safety argument: `bash` EXECUTES its heredoc, so the body is a command.
        for reader in ["bash", "sh", "zsh", "python"] {
            let cmd = format!("{reader} <<'EOF'\nrm -rf /\nEOF");
            assert_eq!(dangerous_match(&cmd), Some("rm -rf /"), "{reader} executes its heredoc body");
        }
    }

    #[test]
    fn a_real_dangerous_command_on_the_line_is_still_floored() {
        assert_eq!(dangerous_match("rm -rf / --no-preserve-root"), Some("rm -rf /"));
        assert_eq!(dangerous_match("sudo whoami"), Some("sudo "));
        assert_eq!(dangerous_match("git push --force origin main"), Some("git push --force"));
        assert_eq!(dangerous_match("gh auth token"), Some("gh auth token"));
    }

    #[test]
    fn a_dangerous_command_after_the_terminator_is_still_floored() {
        // Only the body is exempt — the scan resumes at the terminator. This is the obvious bypass
        // attempt and it must not work.
        let cmd = "cat <<'EOF' > f.txt\nharmless\nEOF\nrm -rf /";
        assert_eq!(dangerous_match(cmd), Some("rm -rf /"));
    }

    #[test]
    fn the_heredoc_opening_line_is_still_scanned() {
        // Redirections and anything else on the opener are commands, not data.
        let cmd = "cat <<'EOF' > /dev/null; sudo sh\nbody\nEOF";
        assert_eq!(dangerous_match(cmd), Some("sudo "));
    }

    #[test]
    fn tee_is_inert_too_and_bare_or_quoted_delimiters_both_work() {
        for open in ["tee f <<EOF", "tee f <<'EOF'", "tee f <<\"EOF\"", "tee f <<-EOF"] {
            let cmd = format!("{open}\nrm -rf /\nEOF");
            assert_eq!(dangerous_match(&cmd), None, "{open} writes its body as data");
        }
    }

    #[test]
    fn an_unterminated_heredoc_does_not_swallow_the_rest_of_the_command() {
        // A malformed/truncated command must not become a blanket exemption... but it also cannot
        // resurrect a terminator that never arrives. Documented: everything after an unterminated
        // inert heredoc is treated as body. The opener is still scanned, and `bsc-confine` +
        // the sandbox remain the real containment.
        let cmd = "cat <<'EOF' > f\nrm -rf /";
        assert_eq!(dangerous_match(cmd), None);
        // ...whereas the same shape with an interpreter is never exempt at all.
        assert_eq!(dangerous_match("bash <<'EOF'\nrm -rf /"), Some("rm -rf /"));
    }

    #[test]
    fn a_command_with_no_heredoc_is_returned_unchanged_by_the_stripper() {
        let cmd = "echo hello && ls -la";
        assert_eq!(strip_inert_heredoc_bodies(cmd), cmd);
    }

    #[test]
    fn two_heredocs_in_one_command_are_each_bounded() {
        let cmd = "cat <<'A' > x\nrm -rf /\nA\ncat <<'B' > y\nsudo sh\nB\ngit push --force";
        assert_eq!(dangerous_match(cmd), Some("git push --force"), "both bodies exempt, the tail is not");
    }
}
