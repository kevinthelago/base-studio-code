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
    // `&&`/`||`/pipes (the empty halves parse to nothing).
    for segment in cmd.split(['\n', ';', '&', '|']) {
        for pkg in parse_segment(segment) {
            if seen.insert((pkg.ecosystem, pkg.name.clone(), pkg.version.clone())) {
                out.push(pkg);
            }
        }
    }
    out
}

/// Parse ONE command segment (no shell separators) into its adds.
fn parse_segment(segment: &str) -> Vec<Package> {
    let mut toks: Vec<&str> = segment.split_whitespace().collect();
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
}
