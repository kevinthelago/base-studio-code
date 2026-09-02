//! Which GitHub credential a request or a session may use — ported from
//! `src/shared/lib/github/repoCredentials.ts` under
//! `epic-frontend-logic-over-backend-resources-belongs-in-rust`, proved against
//! `src/shared/lib/github/repoCredentials.fixtures.json`.
//!
//! # Why this side
//!
//! This is a SECURITY boundary of the same shape as the role gate. [`token_for_repo`] picks the
//! credential a worker/triage pane is LAUNCHED with as its `GH_TOKEN` (#158), so a session bound to
//! repo A carries a fine-grained repo-scoped token and cannot act on sibling repos through `gh`/`git`;
//! [`resolve_github_token`] picks the one a proxied REST request carries. Rust owns both ends —
//! `pty_create` builds the session env, and this crate is the API layer — and the choice was made in
//! the renderer.
//!
//! # Which way this fails
//!
//! Every path falls back to the GLOBAL token, never to no token and never to another repo's. A
//! credential choice that failed open — handing a session a token for a repo it is not bound to —
//! would defeat the #158 confinement this exists to enforce; falling back to the global token is the
//! pre-#158 behaviour, which is a loss of scoping rather than a breach of it.
//!
//! # It moved out of `src-tauri` (`the-github-domains-pure-logic-lives-in-bsc-github`)
//!
//! It has no Tauri dependency and never had one, so it was in the app only by where it was written.
//!
//! # The input is ORDERED, and that is not incidental
//!
//! The TypeScript scans `Object.entries(repoTokens)`, so the FIRST matching entry wins. That is only
//! observable when two keys differ solely by case — and only reproducible if the input keeps insertion
//! order. A `HashMap` has none, and a `BTreeMap` would impose sorted order instead, which is a
//! different answer. So these take a slice of pairs.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it — a flip inside a derivation slice
// hides which of the two changed the behaviour, and this one is a security boundary. The ref is a REAL
// open item (checked with `bsc plan get`), because a dangling `wired by` is invisible to every gate.
#![allow(dead_code)] // wired by `the-launch-and-proxy-choose-their-own-github-token`

/// The `owner/name` a GitHub REST path targets, or `None` when it is not repo-scoped.
///
/// Mirrors `^/?repos/([^/]+)/([^/?#]+)` — a leading slash is optional, the owner runs to the next
/// slash, and the name stops at a slash, `?` or `#`. BOTH segments are required, so `/repos/acme` is
/// not repo-scoped; a path like `/user/repos` never was.
pub fn repo_from_github_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix('/').unwrap_or(path);
    let rest = rest.strip_prefix("repos/")?;
    let (owner, rest) = rest.split_once('/')?;
    if owner.is_empty() {
        return None;
    }
    let name: &str = rest.split(['/', '?', '#']).next().unwrap_or("");
    if name.is_empty() {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

/// The token for a session bound to `repo`: its assigned credential when there is one, else `global`.
///
/// THREE RULES, each of which a realistic corpus would not separate:
///   * the assigned value is tested for TRUTHINESS, so a repo with an assigned but EMPTY token falls
///     back to the global one — and the scan CONTINUES, so a later case-variant entry can still match;
///   * matching is case-insensitive on `owner/name`, because GitHub repo names are;
///   * the FIRST match wins, which is why `repo_tokens` is ordered pairs rather than a map.
///
/// An absent or empty `repo` — the director, or a console with no bound repo — takes the global token.
pub fn token_for_repo(repo: Option<&str>, repo_tokens: &[(String, String)], global: &str) -> String {
    let Some(repo) = repo.filter(|r| !r.is_empty()) else { return global.to_string() };
    let lower = repo.to_lowercase();
    for (k, v) in repo_tokens {
        if !v.is_empty() && k.to_lowercase() == lower {
            return v.clone();
        }
    }
    global.to_string()
}

/// The token for a proxied REST request: the repo-scoped credential when the path targets a repo that
/// has one, else the global token.
pub fn resolve_github_token(path: &str, repo_tokens: &[(String, String)], global: &str) -> String {
    token_for_repo(repo_from_github_path(path).as_deref(), repo_tokens, global)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Resolved BY FILENAME under `src/`, the rule every generated contract here uses.
    fn fixture() -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("repoCredentials.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one repoCredentials.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// ORDER PRESERVED out of the fixture's pair array — reading it into a map here would destroy the
    /// very property the corpus exists to pin.
    fn pairs_of(v: &Value) -> Vec<(String, String)> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .map(|p| (p[0].as_str().unwrap().to_string(), p[1].as_str().unwrap().to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Reports every mismatch at once — a wrong port is wrong in a pattern.
    #[test]
    fn the_credential_choice_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let mut bad: Vec<String> = Vec::new();

        for c in doc["paths"].as_array().expect("paths") {
            let got = repo_from_github_path(c["path"].as_str().unwrap());
            let want = c["repo"].as_str().map(str::to_string);
            if got != want {
                bad.push(format!("  path {:?}: ts {want:?}, rust {got:?}", c["path"]));
            }
        }

        for c in doc["tokenForRepo"].as_array().expect("tokenForRepo") {
            let got = token_for_repo(c["repo"].as_str(), &pairs_of(&c["pairs"]), c["global"].as_str().unwrap());
            let want = c["token"].as_str().unwrap();
            if got != want {
                bad.push(format!("  tokenForRepo {:?}: ts {want:?}, rust {got:?}", c["label"]));
            }
        }

        for c in doc["resolve"].as_array().expect("resolve") {
            let got = resolve_github_token(c["path"].as_str().unwrap(), &pairs_of(&c["pairs"]), c["global"].as_str().unwrap());
            let want = c["token"].as_str().unwrap();
            if got != want {
                bad.push(format!("  resolve {:?}: ts {want:?}, rust {got:?}", c["label"]));
            }
        }

        assert!(bad.is_empty(), "the Rust credential choice disagrees with the live TypeScript:\n{}", bad.join("\n"));
    }

    /// THE SENTINEL. An assigned-but-empty token is skipped, and the scan CONTINUES past it — two
    /// separate claims, because a port that returned `global` on the first empty match would satisfy
    /// the first and fail the second.
    #[test]
    fn an_assigned_but_empty_token_is_skipped_and_the_scan_continues() {
        let only_empty = vec![("acme/web".to_string(), String::new())];
        assert_eq!(token_for_repo(Some("acme/web"), &only_empty, "GLOBAL"), "GLOBAL");

        let empty_then_real = vec![("acme/web".to_string(), String::new()), ("ACME/WEB".to_string(), "T2".to_string())];
        assert_eq!(
            token_for_repo(Some("acme/web"), &empty_then_real, "GLOBAL"),
            "T2",
            "the empty entry is skipped, not treated as the answer"
        );
    }

    /// FIRST match wins, which only two case-variant keys can show.
    #[test]
    fn the_first_matching_entry_wins() {
        let pairs = vec![("acme/web".to_string(), "FIRST".to_string()), ("ACME/WEB".to_string(), "SECOND".to_string())];
        assert_eq!(token_for_repo(Some("acme/web"), &pairs, "GLOBAL"), "FIRST");
    }

    /// An unbound session — the director, or a console with no repo — takes the global token.
    #[test]
    fn an_absent_or_empty_repo_takes_the_global_token() {
        let pairs = vec![("acme/web".to_string(), "T1".to_string())];
        assert_eq!(token_for_repo(None, &pairs, "GLOBAL"), "GLOBAL");
        assert_eq!(token_for_repo(Some(""), &pairs, "GLOBAL"), "GLOBAL");
    }

    /// Both segments are required, and the name stops at a slash, `?` or `#`.
    #[test]
    fn a_repo_path_needs_both_segments() {
        assert_eq!(repo_from_github_path("/repos/acme/web").as_deref(), Some("acme/web"));
        assert_eq!(repo_from_github_path("/repos/acme/web/issues").as_deref(), Some("acme/web"));
        assert_eq!(repo_from_github_path("/repos/acme/web?x=1").as_deref(), Some("acme/web"));
        assert!(repo_from_github_path("/repos/acme").is_none());
        assert!(repo_from_github_path("/repos/acme/").is_none());
        assert!(repo_from_github_path("/user/repos").is_none());
    }
}
