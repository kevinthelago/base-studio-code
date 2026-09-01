//! The session's ACCESS env — three grants, each consumed by Rust and, until now, decided nowhere near
//! it.
//!
//! | variable | what it grants | who enforces it |
//! |---|---|---|
//! | `GH_TOKEN` | a GitHub credential | `gh` / git-over-https |
//! | `BSC_HARVEST_ROOTS` | trees this session may SCAN, read-only | `crates/bsc-ui/src/cli.rs` |
//! | `BSC_STREAM` | scopes `bsc plan` to one fleet stream | `crates/plandb/src/scope.rs` |
//!
//! # The credential gate is the one that matters
//!
//! A role denied BOTH axes — `git: none` AND `github: none` — cannot run git or gh at all, so a
//! credential in its environment widens nothing and risks everything. Those are the app-owned studio
//! sessions (designer, architect, librarian, sound-designer; #3357), the most restricted sessions in
//! the product. Before #3357 they launched through a bespoke hook that passed no token, and this gate
//! is what keeps that true now they run the generic path.
//!
//! The asymmetry is deliberate and must survive exactly: a `triage` pane is `git: none` but
//! `github: write`, so it KEEPS its token; and an ungated pane (no role at all) is unaffected, because
//! there is no capability to deny on.
//!
//! # Harvest roots are symbolic on purpose
//!
//! A role names INTENT (`app-repo`, `projects`) because a role is machine-independent; resolving a
//! token to a path is the launch's job. An UNRESOLVABLE token contributes nothing rather than widening
//! access, mirroring the CLI's own rule that an unresolvable allow-list entry is skipped. The list is
//! NEWLINE-separated because a Windows path contains both `;` and `:`.
//!
//! # `BSC_STREAM` is gated on the WORKER role, not on owning a stream
//!
//! A reviewer or juror judging another stream's landing is a stream pane that must NOT be confined to
//! it — coordinating roles need cross-stream reads. Gating on the stream alone would silently box them
//! in, which is why the role test is separate from the stream test.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it.
#![allow(dead_code)] // wired by `the-launch-derives-its-own-access-env-instead-of-receiving-it`

use super::role_gate::{RoleCapability, Tier};

/// The symbolic root meaning "the base-studio-code source tree this app was built from".
pub const HARVEST_ROOT_APP_REPO: &str = "app-repo";
/// The symbolic root meaning "the `~/.base-studio-code/projects/` tree" — every downloaded repo.
pub const HARVEST_ROOT_PROJECTS: &str = "projects";

/// The role that owns exactly one fleet stream and may be scoped to it.
const STREAM_SCOPED_ROLE: &str = "worker";

/// The three access variables. `None` means the variable is UNSET.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccessEnv {
    pub gh_token: Option<String>,
    pub harvest_roots: Option<String>,
    pub stream: Option<String>,
}

/// Whether this session may be handed a GitHub credential.
///
/// Only a capability denied on BOTH axes is refused. An absent capability (an ungated pane) is NOT a
/// denial — there is no role to reason about, and refusing one would silently break every ad-hoc pane.
pub fn may_hold_git_credential(cap: Option<&RoleCapability>) -> bool {
    !matches!(cap, Some(c) if c.git == Tier::None && c.github == Tier::None)
}

/// Resolve one symbolic harvest token against this machine's paths. `None` when it resolves to
/// nothing, which contributes nothing rather than widening access.
fn resolve_harvest_root(token: &str, app_repo_root: &str, bsc_base_dir: &str) -> Option<String> {
    match token {
        HARVEST_ROOT_APP_REPO => (!app_repo_root.is_empty()).then(|| app_repo_root.to_string()),
        HARVEST_ROOT_PROJECTS => (!bsc_base_dir.is_empty()).then(|| format!("{bsc_base_dir}/projects")),
        _ => None,
    }
}

/// Derive the access env for a pane.
///
/// `stream_id` is the fleet stream this pane owns, if any; it is applied only when `cap`'s role is the
/// stream-scoped one.
pub fn access_env(
    cap: Option<&RoleCapability>,
    gh_token: &str,
    stream_id: Option<&str>,
    app_repo_root: &str,
    bsc_base_dir: &str,
) -> AccessEnv {
    let roots: Vec<String> = cap
        .map(|c| c.harvest_roots.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter_map(|t| resolve_harvest_root(t, app_repo_root, bsc_base_dir))
        .collect();

    AccessEnv {
        gh_token: (!gh_token.is_empty() && may_hold_git_credential(cap)).then(|| gh_token.to_string()),
        harvest_roots: (!roots.is_empty()).then(|| roots.join("\n")),
        stream: stream_id
            .filter(|s| !s.is_empty())
            .filter(|_| cap.map(|c| c.role == STREAM_SCOPED_ROLE).unwrap_or(false))
            .map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("accessEnv.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one accessEnv.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// Reports every mismatch at once — a wrong port is usually wrong in a pattern.
    #[test]
    fn the_access_env_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 24, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut refused, mut granted, mut scoped, mut with_roots) = (0usize, 0usize, 0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let cap: Option<RoleCapability> = match &case["capability"] {
                serde_json::Value::Null => None,
                v => Some(serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{label}: {e}"))),
            };
            let got = access_env(
                cap.as_ref(),
                case["token"].as_str().unwrap_or(""),
                case["stream"].as_str(),
                case["appRepoRoot"].as_str().unwrap_or(""),
                case["bscBaseDir"].as_str().unwrap_or(""),
            );
            let want_token = case["ghToken"].as_str().map(str::to_string);
            let want_roots = case["harvestRoots"].as_str().map(str::to_string);
            let want_stream = case["stream_env"].as_str().map(str::to_string);

            // Count only the cases where a token was actually offered, so "refused" means the GATE
            // refused it rather than there being nothing to place.
            if !case["token"].as_str().unwrap_or("").is_empty() {
                if want_token.is_some() {
                    granted += 1;
                } else {
                    refused += 1;
                }
            }
            if want_stream.is_some() {
                scoped += 1;
            }
            if want_roots.is_some() {
                with_roots += 1;
            }

            for (what, g, w) in [
                ("GH_TOKEN", &got.gh_token, &want_token),
                ("BSC_HARVEST_ROOTS", &got.harvest_roots, &want_roots),
                ("BSC_STREAM", &got.stream, &want_stream),
            ] {
                if g != w {
                    mismatches.push(format!("  {label} [{what}]\n    ts   {w:?}\n    rust {g:?}"));
                }
            }
        }
        assert!(refused >= 3, "only {refused} roles were REFUSED a credential — the gate is untested");
        assert!(granted >= 5, "only {granted} roles were granted one");
        assert!(scoped >= 1, "no case set BSC_STREAM");
        assert!(with_roots >= 3, "only {with_roots} cases resolved harvest roots");
        assert!(
            mismatches.is_empty(),
            "the Rust access env disagrees with the live TypeScript on {} point(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    fn cap(role: &str, git: &str, github: &str, roots: &[&str]) -> RoleCapability {
        serde_json::from_value(serde_json::json!({
            "role": role, "git": git, "github": github, "net": "none", "code": "none",
            "writeGlobs": [], "ui": "read", "harvestRoots": roots
        }))
        .unwrap()
    }

    /// THE CREDENTIAL GATE, stated directly — including the asymmetry that makes it non-obvious.
    #[test]
    fn only_a_role_denied_on_both_axes_is_refused_the_credential() {
        // Denied on both: the app-owned studio sessions.
        assert!(!may_hold_git_credential(Some(&cap("designer", "none", "none", &[]))));
        // git:none but github:write — a triage pane KEEPS its token.
        assert!(may_hold_git_credential(Some(&cap("triage", "none", "write", &[]))));
        // github:none but git:write.
        assert!(may_hold_git_credential(Some(&cap("x", "write", "none", &[]))));
        // An ungated pane has no capability to deny on, and must not be broken by this gate.
        assert!(may_hold_git_credential(None), "an ad-hoc pane keeps its token");

        assert_eq!(access_env(Some(&cap("designer", "none", "none", &[])), "ghp_x", None, "", "").gh_token, None);
        assert_eq!(
            access_env(Some(&cap("triage", "none", "write", &[])), "ghp_x", None, "", "").gh_token.as_deref(),
            Some("ghp_x")
        );
    }

    /// An empty token is nothing to place — distinct from a refusal, and it must not render an empty
    /// `GH_TOKEN=` into the environment, which reads to `gh` as a present-but-invalid credential.
    #[test]
    fn an_empty_token_is_absent_not_empty() {
        assert_eq!(access_env(Some(&cap("worker", "write", "read", &[])), "", None, "", "").gh_token, None);
    }

    /// An unresolvable token contributes nothing rather than widening access, and each resolves
    /// independently — losing one path must not lose the other.
    #[test]
    fn harvest_tokens_resolve_independently_and_an_unresolvable_one_contributes_nothing() {
        let c = cap("designer", "none", "none", &[HARVEST_ROOT_APP_REPO, HARVEST_ROOT_PROJECTS]);
        assert_eq!(
            access_env(Some(&c), "", None, "/repo", "/base").harvest_roots.as_deref(),
            Some("/repo\n/base/projects"),
            "newline-separated: a Windows path contains both ; and :"
        );
        assert_eq!(access_env(Some(&c), "", None, "", "/base").harvest_roots.as_deref(), Some("/base/projects"));
        assert_eq!(access_env(Some(&c), "", None, "/repo", "").harvest_roots.as_deref(), Some("/repo"));
        assert_eq!(access_env(Some(&c), "", None, "", "").harvest_roots, None, "neither resolves ⇒ unset");

        let unknown = cap("designer", "none", "none", &["some-future-token"]);
        assert_eq!(
            access_env(Some(&unknown), "", None, "/repo", "/base").harvest_roots,
            None,
            "an unknown token must not silently resolve to something"
        );
    }

    /// The stream scope is gated on the ROLE, not on owning a stream.
    #[test]
    fn only_a_worker_is_scoped_to_its_stream() {
        for role in ["reviewer", "juror", "director", "triage", "planner"] {
            assert_eq!(
                access_env(Some(&cap(role, "read", "read", &[])), "", Some("kernel"), "", "").stream,
                None,
                "{role} judges or coordinates across streams and must not be boxed into one"
            );
        }
        assert_eq!(
            access_env(Some(&cap("worker", "write", "read", &[])), "", Some("kernel"), "", "").stream.as_deref(),
            Some("kernel")
        );
        assert_eq!(
            access_env(Some(&cap("worker", "write", "read", &[])), "", None, "", "").stream,
            None,
            "a worker with no stream is unscoped"
        );
        assert_eq!(
            access_env(None, "", Some("kernel"), "", "").stream,
            None,
            "an ungated pane has no role, so it is never stream-scoped"
        );
    }

    /// The field this struct used to DROP. `RoleCapability` had no `harvest_roots`, and serde ignores
    /// unknown keys, so a capability carrying two roots deserialized as none — the same silent-drop
    /// shape as the `writeGlobs` casing bug the role-gate parity caught on its first run.
    #[test]
    fn the_capability_actually_carries_its_harvest_roots() {
        let c: RoleCapability = serde_json::from_value(serde_json::json!({
            "role": "designer", "git": "none", "github": "none", "net": "none", "code": "none",
            "writeGlobs": [], "ui": "read", "harvestRoots": ["app-repo", "projects"]
        }))
        .unwrap();
        assert_eq!(c.harvest_roots, vec!["app-repo", "projects"], "camelCase key silently dropped");
    }
}
