//! Issue PROVENANCE (#738) — the untrusted-issue channel.
//!
//! Ported from `src/shared/lib/github/issueProvenance.ts` under
//! `the-github-domains-pure-logic-lives-in-bsc-github`, proved against
//! `src/shared/lib/github/issueProvenance.fixtures.json`, generated from it.
//!
//! ## Why this is Rust
//!
//! A triage session runs `gh issue list` over EVERY open issue in a repo, so an issue nobody in this
//! system authored can be picked up and acted on by an agent. base-studio-code stamps the issues it
//! publishes with a distinctive label and restricts triage to that label by default. Rust already
//! writes the triage prompt and builds the session that runs the command; the selector it runs was
//! decided in the renderer.
//!
//! ## The caveat is carried over deliberately
//!
//! The label is FORGEABLE by anyone with repo write access. This stops accidental and hand-created
//! pickup and raises the bar; it is not a cryptographic guarantee. A port that quietly presented it
//! as one would be worse than the gap. For a real guarantee, track the issue numbers the app created.
//!
//! ## WHICH WAY THIS FAILS
//!
//! [`triage_issue_list_args`] fails CLOSED on its default: `restrict_to_bsc = true` is the narrow
//! selector. Getting the two arms backwards fails OPEN — triage would read every issue in the repo,
//! which is the exact exposure the label exists to close, and it would do so while every "returns a
//! string" test still passed. That is why the fixture records both arms verbatim.

/// The label base-studio-code stamps on every issue it publishes.
pub const BSC_ISSUE_LABEL: &str = "bsc-generated";

/// GitHub label color (hex, no `#`) for the provenance label.
pub const BSC_ISSUE_LABEL_COLOR: &str = "1f6feb";

/// Add the provenance label to a plan issue's labels (idempotent).
///
/// APPENDS rather than inserting, and preserves the caller's order including any duplicates already
/// there. A set-union port passes a membership assertion and silently reorders the labels that reach
/// the GitHub API.
pub fn with_provenance_label(labels: &[String]) -> Vec<String> {
    let mut out = labels.to_vec();
    if !out.iter().any(|l| l == BSC_ISSUE_LABEL) {
        out.push(BSC_ISSUE_LABEL.to_string());
    }
    out
}

/// The `gh issue list` selector triage uses — restricted to bsc-authored issues by default.
pub fn triage_issue_list_args(restrict_to_bsc: bool) -> String {
    if restrict_to_bsc {
        format!("--state open --label {BSC_ISSUE_LABEL} --limit 100")
    } else {
        "--state open --limit 100".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Resolved BY FILENAME under `src/`, the rule every generated contract in this repo uses — so
    /// moving a feature slice does not break this, but RENAMING the fixture means updating this call.
    fn fixture() -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("issueProvenance.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one issueProvenance.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    }

    /// Reports every mismatch at once — a wrong port is wrong in a pattern.
    #[test]
    fn provenance_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let mut bad: Vec<String> = Vec::new();

        // The CONSTANTS are part of the contract: the label is what a published issue carries AND
        // what triage selects on, so drifting on the string selects nothing rather than failing.
        if BSC_ISSUE_LABEL != doc["label"].as_str().unwrap() {
            bad.push(format!("  label: ts {:?}, rust {BSC_ISSUE_LABEL:?}", doc["label"]));
        }
        if BSC_ISSUE_LABEL_COLOR != doc["labelColor"].as_str().unwrap() {
            bad.push(format!("  labelColor: ts {:?}, rust {BSC_ISSUE_LABEL_COLOR:?}", doc["labelColor"]));
        }

        for c in doc["withProvenanceLabel"].as_array().expect("withProvenanceLabel") {
            let got = with_provenance_label(&strings(&c["input"]));
            let want = strings(&c["output"]);
            // WHOLE VALUE IN ORDER. A set comparison here would call a reordered label list identical.
            if got != want {
                bad.push(format!("  withProvenanceLabel {:?}: ts {want:?}, rust {got:?}", c["label"]));
            }
        }

        for c in doc["triageIssueListArgs"].as_array().expect("triageIssueListArgs") {
            let restrict = c["restrictToBsc"].as_bool().unwrap();
            let got = triage_issue_list_args(restrict);
            let want = c["args"].as_str().unwrap();
            if got != want {
                bad.push(format!("  triageIssueListArgs({restrict}): ts {want:?}, rust {got:?}"));
            }
        }

        assert!(bad.is_empty(), "the Rust provenance rules disagree with the live TypeScript:\n{}", bad.join("\n"));
    }

    /// THE SENTINEL, stated separately from the corpus because it is the failure that is SILENT.
    /// Swapping the two arms still returns a valid `gh` selector; it just reads every issue in the
    /// repo, which is the whole exposure the label closes.
    #[test]
    fn the_unrestricted_selector_is_the_one_without_the_label() {
        assert!(triage_issue_list_args(true).contains(BSC_ISSUE_LABEL), "the default must be NARROW");
        assert!(
            !triage_issue_list_args(false).contains(BSC_ISSUE_LABEL),
            "the opt-out must be the one without the selector"
        );
    }

    /// Idempotent AND order-preserving are two claims: a port that deduplicated into a set would
    /// satisfy the first and fail the second.
    #[test]
    fn the_stamp_is_appended_once_and_never_reorders() {
        let already = vec![BSC_ISSUE_LABEL.to_string(), "bug".to_string()];
        assert_eq!(with_provenance_label(&already), already, "no move, no duplicate");
        let plain = vec!["zeta".to_string(), "alpha".to_string()];
        assert_eq!(with_provenance_label(&plain), vec!["zeta", "alpha", BSC_ISSUE_LABEL]);
    }

    /// A near-miss label is NOT the stamp — substring or case-insensitive matching would let a
    /// forged-looking label suppress the real one.
    #[test]
    fn a_near_miss_label_does_not_count_as_stamped() {
        let near = vec!["bsc-generated-x".to_string(), "BSC-GENERATED".to_string()];
        assert_eq!(with_provenance_label(&near).len(), 3, "the real stamp must still be appended");
    }
}
