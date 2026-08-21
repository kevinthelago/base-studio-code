//! Write-scope matching (#1297) — the one check a mount namespace **cannot** take over.
//!
//! ── WHY THIS IS IN RUST AT ALL ──────────────────────────────────────────────────────────────────
//! `bsc-scope` ships as a shell function (`src-tauri/data/shell/scope.sh`) installed via `BASH_ENV`.
//! A session inside a `bsc-sandbox` mount namespace gets neither `BASH_ENV` nor the `bsc` binary, so
//! that gate does not run there at all. A mount namespace cannot replace it either: the worktree is
//! ONE read-write mount, and this rule is about globs *within* it (`src/features/x/**` yes,
//! `src/store/**` no). Path-granular isolation has nothing to say about that.
//!
//! So a sandboxed session needs this decision compiled into a small static binary it CAN reach.
//!
//! ── THE SEMANTICS ARE THE SHELL'S, DELIBERATELY ─────────────────────────────────────────────────
//! `scope.sh` matches with POSIX `case "$fp" in $g)`, and that is **not** what a glob crate does.
//! In shell pattern matching `*` and `?` cross `/` freely, so `src/x/*` matches `src/x/a/b/c`. Every
//! mainstream Rust glob crate defaults to the opposite (`*` stops at a separator; only `**` crosses),
//! so dropping one in here would silently DIVERGE from the rule that currently ships — quietly
//! denying writes the shell gate allows, or the reverse.
//!
//! Hence a hand-written fnmatch rather than a dependency. It also keeps this crate at **zero
//! dependencies**, which is what lets the hook binary build for `aarch64` (Pi 4/5) and `ARMv6`
//! (Pi Zero) as a static musl target with no vendored C.
//!
//! [`SHARED_CASES`] is the agreement table: the Rust tests below and a shell-side test read the SAME
//! rows, so the two implementations cannot drift without a red test.

/// What the scope gate decides for one file write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// The write is inside scope (or no scope is configured).
    Allow,
    /// The write is refused; the payload is the human reason, matching `scope.sh`'s wording.
    Deny(String),
}

/// The sentinel `$BSC_SCOPE_GLOBS` value meaning "this session may write nothing" (`code: none`).
pub const DENY_ALL: &str = "__bsc_deny_all__";

/// The scope verdict for `file_path` under whitespace-separated `globs`, relative to `root`.
///
/// Mirrors `scope.sh` exactly, including its order of operations — the normalization it does before
/// matching is part of the rule, not incidental:
///
/// 1. `globs == DENY_ALL` ⇒ deny everything (`code: none`).
/// 2. empty `globs` ⇒ allow (no scope configured).
/// 3. empty `file_path` ⇒ allow (the tool call carries no path to judge).
/// 4. backslashes → `/`, then runs of `/` squeezed to one, then a leading `root/` stripped, then a
///    leading `./` stripped.
/// 5. allow if the result matches ANY glob under shell `case` semantics.
pub fn scope_verdict(file_path: &str, globs: &str, root: &str) -> Scope {
    if globs.trim() == DENY_ALL {
        return Scope::Deny("code:none — no write scope".into());
    }
    if globs.trim().is_empty() || file_path.is_empty() {
        return Scope::Allow;
    }
    let fp = normalize(file_path, root);
    let pats: Vec<&str> = globs.split_whitespace().collect();
    let subject: Vec<char> = fp.chars().collect();
    for g in &pats {
        if fnmatch(&g.chars().collect::<Vec<char>>(), &subject) {
            return Scope::Allow;
        }
    }
    Scope::Deny(format!("'{fp}' is outside this session's write scope"))
}

/// `scope.sh`'s path normalization, in its order. Exposed because the agreement test checks it
/// directly — a divergence here is as much a divergence as one in the matcher.
pub fn normalize(file_path: &str, root: &str) -> String {
    let mut fp: String = file_path.replace('\\', "/");
    // `tr -s '/'` — squeeze runs of '/' to one.
    let mut squeezed = String::with_capacity(fp.len());
    let mut prev_slash = false;
    for c in fp.chars() {
        if c == '/' {
            if !prev_slash {
                squeezed.push(c);
            }
            prev_slash = true;
        } else {
            squeezed.push(c);
            prev_slash = false;
        }
    }
    fp = squeezed;
    // Strip a leading `root/`, with root itself squeezed the same way so the comparison is fair.
    if !root.is_empty() {
        let r = normalize_root(root);
        let with_sep = format!("{r}/");
        if let Some(rest) = fp.strip_prefix(&with_sep) {
            fp = rest.to_string();
        }
    }
    fp.strip_prefix("./").unwrap_or(&fp).to_string()
}

fn normalize_root(root: &str) -> String {
    let r = root.replace('\\', "/");
    let mut out = String::with_capacity(r.len());
    let mut prev = false;
    for c in r.chars() {
        if c == '/' {
            if !prev {
                out.push(c);
            }
            prev = true;
        } else {
            out.push(c);
            prev = false;
        }
    }
    out.trim_end_matches('/').to_string()
}

/// POSIX shell `case` pattern matching: `*` and `?` cross `/`, `[...]` is a bracket expression, and
/// an unterminated `[` is a literal. Iterative with backtracking, so no recursion depth to blow.
fn fnmatch(pat: &[char], s: &[char]) -> bool {
    let (mut p, mut i) = (0usize, 0usize);
    // The most recent `*` and the subject index it was allowed to consume up to.
    let mut star: Option<(usize, usize)> = None;
    loop {
        if i < s.len() {
            let c = s[i];
            let advanced = if p < pat.len() {
                match pat[p] {
                    '*' => {
                        star = Some((p, i));
                        p += 1;
                        continue;
                    }
                    '?' => {
                        p += 1;
                        i += 1;
                        true
                    }
                    '[' => match bracket(pat, p, c) {
                        Some((true, np)) => {
                            p = np;
                            i += 1;
                            true
                        }
                        Some((false, _)) => false,
                        // Unterminated `[` is a literal bracket, per POSIX.
                        None => {
                            if c == '[' {
                                p += 1;
                                i += 1;
                                true
                            } else {
                                false
                            }
                        }
                    },
                    pc => {
                        if pc == c {
                            p += 1;
                            i += 1;
                            true
                        } else {
                            false
                        }
                    }
                }
            } else {
                false
            };
            if advanced {
                continue;
            }
            match star {
                Some((sp, si)) if si < s.len() => {
                    star = Some((sp, si + 1));
                    p = sp + 1;
                    i = si + 1;
                }
                _ => return false,
            }
        } else {
            // Subject exhausted: a trailing run of `*` may still match empty.
            let mut q = p;
            while q < pat.len() && pat[q] == '*' {
                q += 1;
            }
            if q == pat.len() {
                return true;
            }
            match star {
                Some((sp, si)) if si < s.len() => {
                    star = Some((sp, si + 1));
                    p = sp + 1;
                    i = si + 1;
                }
                _ => return false,
            }
        }
    }
}

/// One bracket expression at `pat[p] == '['`. Returns `(matched, index past ']')`, or `None` when
/// the expression is unterminated — in which case the caller treats `[` as a literal.
fn bracket(pat: &[char], p: usize, c: char) -> Option<(bool, usize)> {
    let mut i = p + 1;
    let negated = i < pat.len() && (pat[i] == '!' || pat[i] == '^');
    if negated {
        i += 1;
    }
    let mut matched = false;
    let mut first = true;
    while i < pat.len() {
        if pat[i] == ']' && !first {
            return Some((matched != negated, i + 1));
        }
        first = false;
        // A range `a-z`, but a `-` just before the closing `]` is a literal.
        if i + 2 < pat.len() && pat[i + 1] == '-' && pat[i + 2] != ']' {
            if pat[i] <= c && c <= pat[i + 2] {
                matched = true;
            }
            i += 3;
        } else {
            if pat[i] == c {
                matched = true;
            }
            i += 1;
        }
    }
    None
}

/// The agreement table between this matcher and `scope.sh`.
///
/// `(file_path, globs, root, expect_allow)`. The Rust tests below assert against it directly; the
/// shell-side test drives `bsc-scope` with the same rows. Adding a case here without teaching both
/// sides is what a red test is for — this table is the reason the two implementations of one rule
/// are tolerable at all.
pub const SHARED_CASES: &[(&str, &str, &str, bool)] = &[
    // The load-bearing one: `*` CROSSES `/` in shell case semantics. A glob crate would say false.
    ("src/x/a/b/c.rs", "src/x/*", "", true),
    ("src/x/a/b/c.rs", "src/x/**", "", true),
    ("src/store/s.rs", "src/features/**", "", false),
    ("src/features/a/deep/f.ts", "src/features/**", "", true),
    // Multiple globs — any match allows.
    ("crates/b/l.rs", "src/** crates/**", "", true),
    // Root stripping, and backslashes normalized first.
    ("/repo/src/a.rs", "src/**", "/repo", true),
    ("C:\\repo\\src\\a.rs", "src/**", "C:/repo", true),
    // Repeated slashes squeezed before matching.
    ("src//x///a.rs", "src/x/a.rs", "", true),
    // A leading ./ is stripped.
    ("./src/a.rs", "src/*", "", true),
    // `?` matches exactly one char, and crosses `/` like `*` does.
    ("src/a.rs", "src/?.rs", "", true),
    ("src/ab.rs", "src/?.rs", "", false),
    // Bracket expressions.
    ("src/a.rs", "src/[abc].rs", "", true),
    ("src/d.rs", "src/[abc].rs", "", false),
    ("src/d.rs", "src/[!abc].rs", "", true),
    ("src/b.rs", "src/[a-c].rs", "", true),
    // No scope configured ⇒ allow. Empty path ⇒ allow.
    ("anything/at/all", "", "", true),
    ("", "src/**", "", true),
    // Exact literal.
    ("Cargo.toml", "Cargo.toml", "", true),
    ("Cargo.lock", "Cargo.toml", "", false),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_agreement_table_holds_on_the_rust_side() {
        for (fp, globs, root, want_allow) in SHARED_CASES {
            let got = scope_verdict(fp, globs, root);
            let allowed = got == Scope::Allow;
            assert_eq!(
                allowed, *want_allow,
                "path {fp:?} globs {globs:?} root {root:?} — wanted allow={want_allow}, got {got:?}"
            );
        }
    }

    #[test]
    fn star_crosses_a_slash_because_the_shell_it_mirrors_does() {
        // The single most important divergence from every glob crate. If this ever flips, a
        // sandboxed session starts refusing writes the unsandboxed one allows.
        assert_eq!(scope_verdict("a/b/c/d.rs", "a/*", ""), Scope::Allow);
        assert_eq!(scope_verdict("a/b/c/d.rs", "a/*/d.rs", ""), Scope::Allow);
    }

    #[test]
    fn deny_all_is_a_sentinel_not_a_glob() {
        match scope_verdict("anything", DENY_ALL, "") {
            Scope::Deny(r) => assert!(r.contains("code:none"), "{r}"),
            other => panic!("code:none must deny, got {other:?}"),
        }
        // And it denies even a path that would otherwise be in scope.
        assert!(matches!(scope_verdict("src/a.rs", DENY_ALL, ""), Scope::Deny(_)));
    }

    #[test]
    fn an_unterminated_bracket_is_a_literal() {
        assert_eq!(scope_verdict("src/[a.rs", "src/[a.rs", ""), Scope::Allow);
    }

    #[test]
    fn normalization_order_matches_the_shell() {
        // squeeze happens BEFORE root stripping, so a doubled slash in the root still strips.
        assert_eq!(normalize("/repo//src/a.rs", "/repo"), "src/a.rs");
        assert_eq!(normalize("C:\\repo\\src\\a.rs", "C:/repo"), "src/a.rs");
        // A path that merely starts with the root's characters is NOT stripped without the separator.
        assert_eq!(normalize("/repository/x.rs", "/repo"), "/repository/x.rs");
    }

    #[test]
    fn a_star_only_glob_allows_everything_in_the_tree() {
        assert_eq!(scope_verdict("any/deep/path.rs", "*", ""), Scope::Allow);
    }

    #[test]
    fn backtracking_terminates_on_a_pathological_pattern() {
        // Guards the matcher's loop: many stars against a long non-matching subject must return,
        // not spin. A recursive implementation is what usually dies here.
        let subject = "a".repeat(64);
        let pat = "*a*a*a*a*a*b";
        assert!(matches!(scope_verdict(&subject, pat, ""), Scope::Deny(_)));
    }
}
