//! Parse a Bash command line into the dependency ADDS it performs (#3799, supply-chain #2433) — the
//! pure core the `bsc-supply` PreToolUse hook vets against OSV before an install runs. Recognizes the
//! add-a-named-package forms across npm/yarn/pnpm/bun, pip, and cargo; a bare tree-install
//! (`npm install`, `npm ci`, `pip install -r …`) yields NOTHING (that whole set is covered by
//! `bsc cve scan`, not blocked at add-time).
//!
//! Design for SAFETY over precision: the caller BLOCKS on a match, so a false *package* is far worse
//! than a missed flag. We therefore (a) only pin an EXACT version (a spec starting with a digit — a
//! range/tag/`latest` is treated as versionless, so OSV can't over-match), and (b) skip anything that
//! isn't a plain registry name (flags, paths, URLs, git specs). A stray token that slips through simply
//! finds no advisory and never blocks. Chained commands (`cd x && npm add y`) are split + each parsed.

use crate::types::{Ecosystem, Package};
use std::collections::HashSet;

/// Every dependency add in `cmd`, deduped. Empty for a non-install command (the fast path the hook
/// relies on: most Bash commands parse to nothing with no allocation beyond the split).
pub fn parse_install_command(cmd: &str) -> Vec<Package> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    // Split on shell separators so `cd app && npm add x ; pnpm add y` is fully seen. `&`/`|` cover
    // `&&`/`||`/pipes (the empty halves parse to nothing) — but only OUTSIDE quotes (see `split_segments`).
    for segment in split_segments(cmd) {
        for pkg in parse_segment(segment) {
            if seen.insert((pkg.ecosystem, pkg.name.clone(), pkg.version.clone())) {
                out.push(pkg);
            }
        }
    }
    out
}

/// Split a command line into segments on the shell separators `\n ; & |`, honouring QUOTES (#4007).
///
/// A separator inside `"…"` or `'…'` is a literal character, not a separator — the same rule a real
/// shell applies. Splitting blind mis-reads prose as a command: a worker's coordination message
/// (`printf … "… out-of-repo worktree; npm install kicked off" … | bsc-checkpoint`) split at the `;`
/// INSIDE the string, so the tail read as `npm install kicked off" "- … is already CLOSED`, classified
/// as an npm add, and handed the word `is` to OSV — which has a real advisory for the real `is`
/// package. The gate then exit-2'd the whole brace-group, killing that worker's `bsc-ask`,
/// `bsc-maintain` and `bsc-checkpoint` together, and it sat idle awaiting an answer nobody received.
/// (Same class as #3948, where the dangerous floor learned to stop scanning heredoc BODIES.)
///
/// Quoting rules, POSIX: inside single quotes NOTHING escapes; outside them, and inside double quotes,
/// a backslash escapes the next character. An unterminated quote runs to end-of-input — the trailing
/// text stays part of one segment, which is the conservative outcome (fewer segments ⇒ fewer chances
/// to invent a package).
fn split_segments(cmd: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut start, mut in_single, mut in_double, mut escaped) = (0usize, false, false, false);
    for (i, c) in cmd.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' if !in_single => escaped = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '\n' | ';' | '&' | '|' if !in_single && !in_double => {
                out.push(&cmd[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(&cmd[start..]);
    out
}

/// Parse ONE command segment (no shell separators) into its adds.
fn parse_segment(segment: &str) -> Vec<Package> {
    // Unquote each token so a QUOTED install is still classified (#4007): `npm install "left-pad"`
    // must reach OSV as `left-pad`, not as the literal `"left-pad"` (which matches no advisory) — else
    // quoting the package name is a way past the gate.
    let mut toks: Vec<&str> = segment.split_whitespace().map(unquote).collect();
    // Drop a leading `sudo` / env-prefix so `sudo npm add x` and `FOO=bar npm add x` still classify.
    while let Some(&first) = toks.first() {
        if first == "sudo" || (first.contains('=') && !first.starts_with('-')) {
            toks.remove(0);
        } else {
            break;
        }
    }
    let Some(&tool) = toks.first() else { return Vec::new() };
    let sub = toks.get(1).copied().unwrap_or("");

    // (ecosystem, does this tool+subcommand ADD named packages?)
    let eco = match (tool_stem(tool), sub) {
        ("npm" | "pnpm" | "bun", "install" | "i" | "add") => Ecosystem::Npm,
        ("yarn", "add") => Ecosystem::Npm,
        ("pip" | "pip3", "install") => Ecosystem::Pypi,
        ("cargo", "add") => Ecosystem::Cargo,
        // `python -m pip install …`
        ("python" | "python3", "-m") if toks.get(2) == Some(&"pip") && toks.get(3) == Some(&"install") => {
            return parse_specs(Ecosystem::Pypi, &toks[4..]);
        }
        _ => return Vec::new(),
    };
    parse_specs(eco, &toks[2..])
}

/// Strip ONE matched pair of surrounding quotes from a token (`"left-pad"` → `left-pad`). Only a
/// MATCHED pair is removed, so a token carrying a lone quote from adjacent prose (`"-`, `off"`) is left
/// exactly as it is rather than being mangled into something that looks more like a package name.
fn unquote(t: &str) -> &str {
    let b = t.as_bytes();
    match b.first() {
        Some(&q @ (b'"' | b'\'')) if b.len() >= 2 && b[b.len() - 1] == q => &t[1..t.len() - 1],
        _ => t,
    }
}

/// The tool name without a path or `.exe`/`.cmd` suffix (`/usr/bin/npm` → `npm`, `npm.cmd` → `npm`).
fn tool_stem(tool: &str) -> &str {
    let base = tool.rsplit(['/', '\\']).next().unwrap_or(tool);
    base.strip_suffix(".cmd").or_else(|| base.strip_suffix(".exe")).unwrap_or(base)
}

/// Turn the argument tokens (everything after `<tool> <sub>`) into package specs. A VALUE-flag's value
/// (e.g. `-r requirements.txt`, `--features x`) is skipped along with the flag, then flags, local paths,
/// URLs, and git/tarball specs; a bare tree-install (no specs at all) yields nothing.
fn parse_specs(eco: Ecosystem, args: &[&str]) -> Vec<Package> {
    let mut out = Vec::new();
    let mut skip_next = false;
    for &t in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        // A REDIRECTION is never a package (#4007). `npm install > ./out.txt 2>&1` — the exact shape a
        // worker used — parsed `>` and `2>` as package names and sent them to OSV. Harmless in that
        // they match no advisory, but they are junk lookups on a security-critical path, and the very
        // next token (`./out.txt`) is a filename we must not vet either.
        match redirection(t) {
            Some(Redirect::WithTarget) => {
                skip_next = true;
                continue;
            }
            Some(Redirect::Alone) => continue,
            None => {}
        }
        if flag_takes_value(eco, t) {
            skip_next = true; // its value is not a package (a requirements file, a feature list, a URL)
            continue;
        }
        if is_registry_spec(t) {
            if let Some(p) = parse_spec(eco, t) {
                out.push(p);
            }
        }
    }
    out
}

/// What a shell redirection token consumes: itself alone (`2>&1`, `>./out.txt` — the target is attached),
/// or itself PLUS the following token (`> ./out.txt`, where the filename is separate).
enum Redirect {
    Alone,
    WithTarget,
}

/// Classify `t` as a shell redirection — `>`, `>>`, `<`, `2>`, `&>`, `2>&1`, `>&2`, `>./out.txt` — none
/// of which is ever a package (#4007). `None` for an ordinary token. A package name may legitimately
/// start with a digit (`2captcha`), so a leading fd number only counts when an actual `<`/`>` follows.
fn redirection(t: &str) -> Option<Redirect> {
    let b = t.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1; // an fd prefix: the `2` of `2>`
    }
    if i + 1 < b.len() && b[i] == b'&' && b[i + 1] == b'>' {
        i += 1; // `&>` — both streams
    }
    if i >= b.len() || (b[i] != b'>' && b[i] != b'<') {
        return None;
    }
    while i < b.len() && (b[i] == b'>' || b[i] == b'<') {
        i += 1; // `>>` / `<<`
    }
    // A trailing `&` names a target FD (`2>&1`, `>&2`) — self-contained, and never a filename.
    if i < b.len() && b[i] == b'&' {
        return Some(Redirect::Alone);
    }
    Some(if i == b.len() { Redirect::WithTarget } else { Redirect::Alone })
}

/// Whether `t` is a flag whose NEXT token is a value, not a package — so both are skipped. Covers the
/// forms that would otherwise mis-parse a filename/URL/feature as a package (`pip install -r reqs.txt`
/// is the canonical case). The `--flag=value` form is one token (skipped by `is_registry_spec`), so
/// only the space-separated form needs this.
fn flag_takes_value(eco: Ecosystem, t: &str) -> bool {
    match eco {
        Ecosystem::Pypi => matches!(
            t,
            "-r" | "--requirement" | "-c" | "--constraint" | "-e" | "--editable"
                | "-i" | "--index-url" | "--extra-index-url" | "-t" | "--target"
        ),
        Ecosystem::Cargo => matches!(
            t,
            "--features" | "-F" | "--path" | "--git" | "--vers" | "--registry" | "--rename" | "--branch" | "--tag" | "--rev"
        ),
        _ => matches!(t, "--registry" | "-w" | "--workspace" | "--tag"), // npm/pnpm/yarn/bun
    }
}

/// Whether `t` looks like a plain registry package spec (not a flag / path / URL / git or tarball ref).
fn is_registry_spec(t: &str) -> bool {
    if t.is_empty() || t.starts_with('-') || t.starts_with('.') || t.starts_with('/') {
        return false; // flag or a local path
    }
    if t.contains("://") || t.starts_with("git@") || t.starts_with("git+") {
        return false; // a URL / git spec
    }
    if t.ends_with(".tgz") || t.ends_with(".tar.gz") || t.ends_with(".whl") {
        return false; // a tarball / wheel path
    }
    true
}

/// Parse one spec into a [`Package`], extracting an EXACT pinned version where present (a range/tag is
/// treated as versionless so OSV can't over-match). npm: `name`, `name@ver`, `@scope/pkg`,
/// `@scope/pkg@ver`. pip: `name`, `name==ver`, `name[extra]==ver`. cargo: `name`, `name@ver`.
fn parse_spec(eco: Ecosystem, spec: &str) -> Option<Package> {
    let (name, version) = match eco {
        Ecosystem::Pypi => {
            // pip uses `==` for an exact pin; any other operator (`>=`/`~=`/`!=`) is versionless. Extras
            // in `name[extra]` are dropped. `split_once("==")` yields the pin directly (None → no `==`).
            let (n, v) = match spec.split_once("==") {
                Some((n, v)) => (n, exact(v)),
                None => (spec, None),
            };
            let n = n.split(['[', '<', '>', '~', '!', '=', ';']).next().unwrap_or(n);
            (n.trim().to_string(), v)
        }
        _ => {
            // npm/cargo: the version separator is an `@` NOT at index 0 (index 0 = a scope like `@scope`).
            match spec[1..].find('@').map(|i| i + 1) {
                Some(at) => (spec[..at].to_string(), exact(&spec[at + 1..])),
                None => (spec.to_string(), None),
            }
        }
    };
    if name.is_empty() {
        return None;
    }
    Some(Package::new(eco, name, version))
}

/// Keep a version string only if it's an EXACT pin — i.e. begins with a digit (`4.17.0`, `1.0`), not a
/// range/tag (`^4`, `~1`, `>=2`, `*`, `latest`, `next`). An over-broad pin at worst finds no advisory.
fn exact(v: &str) -> Option<String> {
    let v = v.trim();
    match v.chars().next() {
        Some(c) if c.is_ascii_digit() => Some(v.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(cmd: &str) -> Vec<(Ecosystem, String, Option<String>)> {
        parse_install_command(cmd).into_iter().map(|p| (p.ecosystem, p.name, p.version)).collect()
    }

    #[test]
    fn parses_npm_adds_with_scopes_and_exact_versions() {
        assert_eq!(
            one("npm install lodash @scope/pkg@1.2.3 react@^18"),
            vec![
                (Ecosystem::Npm, "lodash".into(), None),
                (Ecosystem::Npm, "@scope/pkg".into(), Some("1.2.3".into())),
                (Ecosystem::Npm, "react".into(), None), // ^18 is a range → versionless
            ]
        );
        assert_eq!(one("yarn add left-pad@1.0.0"), vec![(Ecosystem::Npm, "left-pad".into(), Some("1.0.0".into()))]);
        assert_eq!(one("pnpm add chalk"), vec![(Ecosystem::Npm, "chalk".into(), None)]);
    }

    #[test]
    fn bare_tree_installs_and_non_installs_yield_nothing() {
        assert!(one("npm install").is_empty(), "bare tree install");
        assert!(one("npm ci").is_empty());
        assert!(one("pnpm install").is_empty());
        assert!(one("pip install -r requirements.txt").is_empty(), "-r is a tree install, not a named add");
        assert!(one("cargo build").is_empty());
        assert!(one("ls -la && echo hi").is_empty());
        assert!(one("git commit -m 'npm install foo'").is_empty(), "not actually an install command");
    }

    #[test]
    fn parses_pip_and_cargo() {
        assert_eq!(
            one("pip install requests==2.31.0 flask[async]==3.0.0 django>=4"),
            vec![
                (Ecosystem::Pypi, "requests".into(), Some("2.31.0".into())),
                (Ecosystem::Pypi, "flask".into(), Some("3.0.0".into())),
                (Ecosystem::Pypi, "django".into(), None), // >= is inexact → versionless
            ]
        );
        assert_eq!(one("python3 -m pip install urllib3==2.0.0"), vec![(Ecosystem::Pypi, "urllib3".into(), Some("2.0.0".into()))]);
        assert_eq!(one("cargo add serde@1.0.197"), vec![(Ecosystem::Cargo, "serde".into(), Some("1.0.197".into()))]);
    }

    #[test]
    fn skips_flags_paths_urls_and_chained_segments() {
        // Flags + a local path + a git URL are skipped; the real package remains.
        assert_eq!(
            one("npm install --save-dev ./local git+https://x/y.git express@4.18.2 -g"),
            vec![(Ecosystem::Npm, "express".into(), Some("4.18.2".into()))]
        );
        // Chained: both adds are seen.
        assert_eq!(
            one("cd app && npm add foo@1.0.0 ; pnpm add bar"),
            vec![(Ecosystem::Npm, "foo".into(), Some("1.0.0".into())), (Ecosystem::Npm, "bar".into(), None)]
        );
        // sudo + a path-qualified tool + .cmd suffix still classify.
        assert_eq!(one("sudo /usr/local/bin/npm.cmd add tar@6.1.0"), vec![(Ecosystem::Npm, "tar".into(), Some("6.1.0".into()))]);
    }

    #[test]
    fn dedupes_repeated_specs() {
        assert_eq!(one("npm add lodash lodash"), vec![(Ecosystem::Npm, "lodash".into(), None)]);
    }

    /// #4007 — THE regression. This is the real command a skills worker ran: a brace-group of
    /// `echo`/`printf` piped into the coordination helpers, whose PROSE mentions an npm install. The
    /// blind split cut at the `;` inside the quoted string, read the tail as `npm install kicked off"
    /// "- … is already CLOSED`, and handed OSV the word `is` — a real npm package with a real advisory
    /// (MAL-2025-6020). The gate exit-2'd the whole group, so the worker's `bsc-ask`, `bsc-maintain`
    /// and `bsc-checkpoint` all died and the stream sat idle. Nothing here is an install.
    #[test]
    fn prose_inside_quotes_is_not_an_install() {
        let cmd = concat!(
            "{\n",
            "  echo \"skills stream: no issues assigned yet; checked gh issue list — every skills-scoped ",
            "issue is already closed, so there is no open work right now. npm install now running to fix that).\" | bsc-ask\n",
            "  echo \"---\"\n",
            "  printf '%s\\n' \"# skills stream checkpoint\" \"\" ",
            "\"- npm test (vitest) could not run: no node_modules in this out-of-repo worktree; npm install kicked off\" ",
            "\"- Every skills-scoped GitHub issue found (3905, 1968, ...) is already CLOSED\" | bsc-checkpoint\n",
            "  echo DONE_COORD\n",
            "} > ./.agentscratch_coord.txt 2>&1\n",
            "echo QUEUED",
        );
        assert_eq!(one(cmd), vec![], "prose in a quoted string must never parse as an install");
    }

    #[test]
    fn separators_inside_quotes_do_not_start_a_new_command() {
        // The minimal shape of the #4007 bug: a `;` and a `|` inside a string.
        assert_eq!(one("echo \"oops; npm add evil\""), vec![]);
        assert_eq!(one("echo 'oops | npm add evil'"), vec![]);
        assert_eq!(one("echo \"a && npm add evil\""), vec![]);
        // An escaped quote does not end the string, so the install stays quoted prose.
        assert_eq!(one("echo \"she said \\\"hi\\\"; npm add evil\""), vec![]);
        // An UNTERMINATED quote swallows the rest — conservative: one segment, still `echo`.
        assert_eq!(one("echo \"unterminated; npm add evil"), vec![]);
    }

    #[test]
    fn real_separators_outside_quotes_still_split() {
        // The whole point of splitting — a genuine chain after a quoted argument is still seen.
        assert_eq!(one("echo \"done\"; npm add evil"), vec![(Ecosystem::Npm, "evil".into(), None)]);
        assert_eq!(one("echo 'done' && npm add evil@1.0.0"), vec![(Ecosystem::Npm, "evil".into(), Some("1.0.0".into()))]);
        assert_eq!(one("cat pkgs.txt | xargs npm add\nnpm add tail-pkg"), vec![(Ecosystem::Npm, "tail-pkg".into(), None)]);
    }

    /// Quoting the package name must NOT slip an install past the gate — the token is unquoted before
    /// it is classified, so OSV sees `left-pad`, not `"left-pad"` (which matches no advisory).
    #[test]
    fn a_quoted_package_name_is_still_an_install() {
        assert_eq!(one("npm install \"left-pad\""), vec![(Ecosystem::Npm, "left-pad".into(), None)]);
        assert_eq!(one("npm install 'is'"), vec![(Ecosystem::Npm, "is".into(), None)]);
        assert_eq!(one("pip install \"requests==2.31.0\""), vec![(Ecosystem::Pypi, "requests".into(), Some("2.31.0".into()))]);
        // A lone quote from adjacent prose is NOT a matched pair — the token is left alone.
        assert_eq!(unquote("\"-"), "\"-");
        assert_eq!(unquote("off\""), "off\"");
        assert_eq!(unquote("\"\""), "");
    }

    /// A bare tree-install is still nothing to vet (unchanged by #4007) — that whole set is
    /// `bsc cve scan`'s job, not the add-time gate's.
    #[test]
    fn a_bare_tree_install_still_yields_nothing() {
        assert_eq!(one("npm install"), vec![]);
        assert_eq!(one("npm install > ./out.txt 2>&1; echo DONE >> ./out.txt"), vec![]);
        assert_eq!(one("npm ci"), vec![]);
    }

    /// A redirection is not a package (#4007). Found by the test above: `npm install > ./out.txt 2>&1`
    /// — the exact shape a worker ran — used to yield packages named `>` and `2>`.
    #[test]
    fn redirections_are_never_packages() {
        // Separate target, attached target, both-streams, and fd-to-fd forms.
        assert_eq!(one("npm add foo > out.txt"), vec![(Ecosystem::Npm, "foo".into(), None)]);
        assert_eq!(one("npm add foo >out.txt"), vec![(Ecosystem::Npm, "foo".into(), None)]);
        assert_eq!(one("npm add foo >> out.txt 2> err.txt"), vec![(Ecosystem::Npm, "foo".into(), None)]);
        assert_eq!(one("npm add foo &> out.txt"), vec![(Ecosystem::Npm, "foo".into(), None)]);
        assert_eq!(one("npm add foo 2>&1"), vec![(Ecosystem::Npm, "foo".into(), None)]);
        assert_eq!(one("npm add foo >&2"), vec![(Ecosystem::Npm, "foo".into(), None)]);
        assert_eq!(one("pip install requests < in.txt"), vec![(Ecosystem::Pypi, "requests".into(), None)]);
        // A package name may start with a digit — an fd prefix only counts when a `<`/`>` follows.
        assert_eq!(one("npm add 2captcha"), vec![(Ecosystem::Npm, "2captcha".into(), None)]);
    }
}
