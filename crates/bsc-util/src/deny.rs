//! Matching for the SESSION's bash deny patterns (#3483) — the role/user list (`$BSC_DENY_BASH`,
//! `roleDeniedCommands`), NOT the built-in dangerous floor.
//!
//! ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
//! Both consumers used to test a deny pattern with a plain `cmd.contains(p)` over the WHOLE command.
//! That is correct for the curated floor, whose entries are phrases (`"rm -rf /"`, `"git push
//! --force"`), and catastrophic for the role list, whose entries are bare PROGRAM NAMES. The
//! `code: "none"` roles deny the common file writers — `tee`, `dd`, `cp`, `mv`, `ln`, `ex`, `ed`,
//! `vi` — and a two-letter program name substring-matched against a whole command matches inside
//! ARGUMENTS AND PATHS:
//!
//!   * `ed` matches `shar` + `ed` → every path under `src/shared/**` was denied
//!   * `vi` matches `Ke` + `vi` + `n` → EVERY absolute path on a machine whose user is `Kevin`
//!   * `ex` matches `ind`/`t`/`r` + `ex` → `index`, `text`, `export`, …
//!
//! A designer session found this the hard way: it could not run `bsc ui harvest src/shared/ui` at
//! all, and filed the report with the letters spelled apart (`v-i`, `e-d`) because writing them
//! literally would have tripped the very hook it was reporting.
//!
//! ── THE RULE ────────────────────────────────────────────────────────────────────────────────────
//! A pattern that LOOKS LIKE A PROGRAM NAME (only `[A-Za-z0-9._/\-]`) must match a segment's program
//! TOKEN. Anything else — a phrase, or anything carrying shell punctuation — keeps the old substring
//! test, so `sed -i`, `git push --force` and `:(){` are unchanged. The floor is deliberately NOT
//! routed through here: `"mkfs."` is a prefix and `":(){"` a fragment, and both would stop matching
//! under program-token semantics. Weakening the dangerous floor to fix the role list would be a far
//! worse bug than the one being fixed.

/// Does `pattern` (one role/user deny entry) deny `cmd`? See the module docs for the two kinds of
/// pattern and why they are matched differently.
pub fn deny_matches(cmd: &str, pattern: &str) -> bool {
    if !looks_like_program_name(pattern) {
        return cmd.contains(pattern);
    }
    let want = basename(pattern);
    command_programs(cmd).into_iter().any(|p| p == want)
}

/// Is this deny entry a bare program name (so it should match the program, not any substring)?
/// Only `[A-Za-z0-9._/\-]` qualifies — a space, pipe, brace or paren means the author wrote a
/// PHRASE, whose substring semantics are load-bearing and must be preserved.
fn looks_like_program_name(p: &str) -> bool {
    // A trailing `.` or `/` marks a deliberate PREFIX (`mkfs.` is written to catch `mkfs.ext4`), not a
    // program — treating it as one would silently stop it matching, which is how a fix for the role
    // list could quietly weaken a dangerous-floor-style entry a user had added.
    !p.is_empty()
        && !p.ends_with(['.', '/', '\\'])
        && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '\\'))
}

/// The final path segment — so a deny on `vi` still catches `/usr/bin/vi`, and a deny written as
/// `/usr/bin/vi` still catches a bare `vi`.
fn basename(tok: &str) -> &str {
    tok.rsplit(['/', '\\']).next().unwrap_or(tok)
}

/// The PROGRAM token of every segment of a shell command: the first word, plus the first word after
/// each `|`, `&`, `;`, newline, or sub-shell paren. Leading `VAR=value` assignments are skipped
/// (`FOO=1 vi x` still resolves to `vi`), a leading path is reduced to its basename, and surrounding
/// quotes are stripped.
///
/// `sh -c "<cmd>"` (and `bash`/`zsh`/`dash`) RECURSES into the command string, because otherwise the
/// program-token rule would hand every confined session a one-line bypass of its own deny list.
pub fn command_programs(cmd: &str) -> Vec<&str> {
    let mut out = Vec::new();
    collect_programs(cmd, 0, &mut out);
    out
}

/// Shells whose `-c` argument is itself a command to be inspected.
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "busybox"];

fn collect_programs<'a>(cmd: &'a str, depth: usize, out: &mut Vec<&'a str>) {
    // A hostile nest can't spin forever; two levels is far past anything real.
    if depth > 2 {
        return;
    }
    for seg in cmd.split(['|', '&', ';', '\n', '(', ')']) {
        let mut toks = seg.split_whitespace().map(strip_quotes).filter(|t| !t.is_empty());
        // Skip `VAR=value` prefixes to reach the real program.
        let Some(prog) = toks.find(|t| !is_env_assignment(t)) else { continue };
        let prog = basename(prog);
        out.push(prog);
        // `sh -c "vi x"` — the payload is a command, so inspect it too.
        if SHELLS.contains(&prog) {
            let mut rest = toks;
            while let Some(t) = rest.next() {
                if is_command_flag(t) {
                    if let Some(payload) = rest.next() {
                        collect_programs(payload, depth + 1, out);
                    }
                    break;
                }
            }
        }
    }
}

/// Does this token mean "the NEXT argument is a command string"?
///
/// `-c`, but also the CLUSTERED short flags a real command line uses — `bash -lc '…'`,
/// `sh -ic '…'`, `bash -xc '…'`. An exact `t == "-c"` check missed every one of them, so
/// `bash -lc 'jq …'` laundered a deny that `sh -c 'jq …'` was caught by: a one-line bypass of
/// exactly the kind this recursion exists to close, in the flag form people actually type.
///
/// A long option (`--command`) is NOT this: bash has no such flag, and matching one would let an
/// unrelated tool's `--config <file>` be read as a command payload.
fn is_command_flag(t: &str) -> bool {
    t.starts_with('-') && !t.starts_with("--") && t.len() > 1 && t.ends_with('c')
}

fn strip_quotes(t: &str) -> &str {
    t.trim_matches(|c| c == '"' || c == '\'' || c == '`')
}

/// `VAR=value` — an environment assignment standing before the program, not the program itself.
fn is_env_assignment(t: &str) -> bool {
    match t.find('=') {
        Some(i) if i > 0 => t[..i].chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact commands the designer could not run (#3483) — the regression this exists for.
    #[test]
    fn a_short_program_name_no_longer_matches_inside_an_argument_or_path() {
        assert!(!deny_matches("bsc ui harvest src/shared/ui", "ed"), "`ed` inside `shared`");
        assert!(!deny_matches("bsc ui harvest C:/Users/Kevin/p/src", "vi"), "`vi` inside `Kevin`");
        assert!(!deny_matches("cat src/index.ts", "ex"), "`ex` inside `index`");
        assert!(!deny_matches("ls src/added/text", "dd"), "`dd` inside `added`");
        assert!(!deny_matches("grep vulnerable .", "ln"), "`ln` inside `vulnerable`");
    }

    #[test]
    fn the_program_itself_is_still_denied() {
        for (cmd, pat) in [
            ("vi notes.txt", "vi"),
            ("ed", "ed"),
            ("tee out.log", "tee"),
            ("cp a b", "cp"),
            ("/usr/bin/vim x", "vim"),      // a leading path is reduced to its basename
            ("FOO=1 BAR=2 vi x", "vi"),     // env assignments are skipped
            ("cat x | tee out", "tee"),     // every pipeline segment is a program
            ("make && cp a b", "cp"),
            ("echo hi; nano f", "nano"),
        ] {
            assert!(deny_matches(cmd, pat), "{pat} must still deny {cmd:?}");
        }
    }

    #[test]
    fn a_shell_dash_c_payload_cannot_launder_a_denied_program() {
        // Without the recursion, program-token matching would hand every confined session a
        // one-line bypass of its own deny list.
        assert!(deny_matches(r#"sh -c "tee out""#, "tee"));
        assert!(deny_matches(r#"bash -c 'vi x'"#, "vi"));
        assert!(deny_matches("sh -c \"cat a | tee b\"", "tee"));
    }

    #[test]
    fn a_phrase_pattern_keeps_its_substring_semantics() {
        // Phrases and punctuation-bearing patterns are matched as before — the curated floor and any
        // multi-word role deny must not regress.
        assert!(deny_matches("git push --force origin main", "git push --force"));
        assert!(deny_matches("sed -i 's/a/b/' f", "sed -i"));
        assert!(deny_matches("sudo rm x", "sudo "));
        assert!(deny_matches("mkfs.ext4 /dev/sda", "mkfs."), "a prefix pattern still matches");
        assert!(deny_matches(":(){ :|:& };:", ":(){"), "the fork bomb fragment still matches");
    }

    /// The #4000 worker deny, end to end through the matcher that actually enforces it.
    ///
    /// The TS side only knows it emitted the string; THIS is the half that decides whether a command
    /// is blocked. Both halves matter and neither can see the other, so the pattern is pinned here as
    /// well as at the producer.
    #[test]
    fn the_tooling_request_deny_blocks_the_subcommand_without_denying_the_whole_cli() {
        // Blocked: the global tooling queue a project role must not reach.
        assert!(deny_matches("bsc request new \"tooling is broken\"", "bsc request"));
        assert!(deny_matches("bsc request list", "bsc request"));
        // And it cannot be laundered through a shell, like any other deny.
        assert!(deny_matches(r#"sh -c "bsc request new x""#, "bsc request"));

        // NOT blocked: everything else the CLI does. `bsc` is in the permission model's `mandatory`
        // tier because the whole plan/fleet workflow runs on it — a deny that caught the bare program
        // would take every store down with it, which is why the pattern carries a space.
        for allowed in [
            "bsc plan request new \"no develop branch\"",   // the PROJECT lane — the whole point
            "bsc plan list",
            "bsc skill get x",
            "bsc logs tail",
            "bsc ui harvest src/shared/ui",
        ] {
            assert!(!deny_matches(allowed, "bsc request"), "{allowed} must still run");
        }
    }

    #[test]
    fn command_programs_reads_the_program_of_each_segment() {
        assert_eq!(command_programs("bsc ui harvest src/shared/ui"), vec!["bsc"]);
        assert_eq!(command_programs("cat a | tee b && ls"), vec!["cat", "tee", "ls"]);
        assert_eq!(command_programs("FOO=1 /usr/local/bin/node x.js"), vec!["node"]);
        assert!(command_programs("").is_empty());
    }
}

// ── a piped interpreter is the shape a workaround takes ─────────────────────────────────────────
//
// The restricted studio specs forbid "pipe into an interpreter", and the deny that now enforces it
// is written as a bare program name. That only works if a bare name matches inside a PIPELINE —
// which is where the observed misuse lived: `bsc ui get x | python3 -c '…'`, 37 times in one
// session. A prefix rule (`python3 *`) would have matched none of them.

#[cfg(test)]
mod piped_interpreter_tests {
    use super::deny_matches;

    /// The exact commands a designer session actually ran, taken from its transcript.
    #[test]
    fn the_real_workarounds_are_caught_by_a_bare_program_name() {
        let observed = [
            r#"bsc ui get ui-tree --field props --raw 2>&1 | python3 -c "import json,sys; d=json.load(sys.stdin)""#,
            r#"bsc graph impl get trace.ts 2>&1 | python3 -c " import json,sys; print(len(code)) ""#,
            r#"for id in a b c; do bsc ui get "$id" --pretty 2>&1 | python3 -c "..."; done"#,
        ];
        for cmd in observed {
            assert!(deny_matches(cmd, "python3"), "must be denied: {cmd}");
        }
    }

    /// The one-line bypass a program-token rule has to close: wrapping it in a shell.
    ///
    /// `-lc` is the case that was open. The recursion matched an exact `-c` token, so
    /// `sh -c 'jq …'` was caught and `bash -lc 'jq …'` was not — and `-lc` is the form people
    /// actually type. Found by this test, which was written expecting it to pass.
    #[test]
    fn a_shell_wrapper_does_not_launder_it() {
        assert!(deny_matches(r#"sh -c "bsc ui list | python3 -c 'x'""#, "python3"));
        for wrapped in [
            r#"bash -lc 'jq . < f.json'"#,
            r#"bash -ic 'jq . < f.json'"#,
            r#"sh -xc 'jq . < f.json'"#,
            r#"bash -c 'jq . < f.json'"#,
        ] {
            assert!(deny_matches(wrapped, "jq"), "must not launder: {wrapped}");
        }
    }

    /// ...but a LONG option is not a command flag. bash has no `--command`, and reading one as a
    /// payload would let an unrelated tool's `--config <file>` be inspected as a command.
    #[test]
    fn a_long_option_is_not_read_as_a_command_payload() {
        assert!(!deny_matches("bsc ui set --config jq.json", "jq"));
    }

    /// ...and the allowed surface is untouched. A deny that also blocked the session's own store CLI
    /// would be worse than the gap it closes.
    #[test]
    fn the_stores_own_verbs_are_not_denied() {
        for cmd in [
            "bsc ui get card --pretty",
            "bsc ui set --file scratch/card.json",
            "bsc shot preview card",
        ] {
            for pat in ["python", "python3", "node", "jq", "perl", "ruby"] {
                assert!(!deny_matches(cmd, pat), "{pat} must not match {cmd}");
            }
        }
    }

    /// A component NAMED like an interpreter is content, not a program — the token rule is what
    /// keeps `bsc ui get node-card` runnable while `| node` is not.
    #[test]
    fn a_name_that_merely_contains_an_interpreter_is_not_a_program() {
        assert!(!deny_matches("bsc ui get node-card", "node"));
        assert!(!deny_matches("bsc ui get python-logo", "python"));
    }
}
