//! `bsc github` — the READ-ONLY surface over this crate's derived rules.
//!
//! ## Why a surface at all
//!
//! Without one, this crate is linked into `bsc` and unreachable from it: `bsc help` listed no
//! `github`, so a live session could not ask any of these questions. Re-homing modules out of
//! `src-tauri` without a surface would be moving files, not migrating logic — the epic's criterion is
//! that a migrated concern is reachable by every role without a permission grant, and `bsc` is in the
//! 3-command mandatory tier while `node` is not.
//!
//! ## READ-ONLY, AND IT NEVER READS A CREDENTIAL BACK
//!
//! [`crate::repo_credentials`] picks a TOKEN, and this surface deliberately does not expose that
//! choice — the same rule `bsc secret` follows, where no verb reads a secret back. What it exposes is
//! the ROUTING half: which repo a REST path targets, which is the input to the credential decision
//! and carries nothing sensitive. A verb that printed the selected token would turn an agent-readable
//! surface into a credential oracle.
//!
//! ## WHICH WAY THESE FAIL
//!
//! Every verb fails LOUD — a bad path, unreadable file or malformed payload is an `Err`, not an empty
//! answer. That is the opposite of the library functions underneath, which fail empty on purpose, and
//! the difference is the caller: a board VIEW showing no columns self-corrects on the next fetch,
//! while an agent that asked a question and got a confident empty answer acts on it.

use bsc_cli_util::CmdDoc;

pub const TAGLINE: &str = "GitHub rules a session can ask about: issue provenance, REST path routing, board shape";

pub fn command_docs() -> &'static [CmdDoc] {
    &[
        CmdDoc {
            name: "provenance",
            summary: "the issue-provenance label and the `gh issue list` selector triage should use",
            usage: "\
USAGE:
  bsc github provenance [--unrestricted] [--json]

    --unrestricted   the selector WITHOUT the label — every open issue in the repo

GitHub issues are an UNTRUSTED input (#738). A triage session runs `gh issue list` over every open
issue, so an issue nobody in this system authored can be picked up and acted on by an agent.
base-studio-code stamps the issues it publishes with `bsc-generated` and triage restricts to that
label BY DEFAULT — ask this verb for the selector rather than hardcoding one.

THE CAVEAT IS REAL: the label is FORGEABLE by anyone with repo write access. This stops accidental
and hand-created pickup and raises the bar; it is not a cryptographic guarantee.",
        },
        CmdDoc {
            name: "repo-for",
            summary: "which `owner/name` a GitHub REST path targets, or nothing when it is not repo-scoped",
            usage: "\
USAGE:
  bsc github repo-for <path> [--json]

The ROUTING half of the repo-scoped credential decision (#158): a session bound to repo A carries a
repo-scoped token and cannot act on sibling repos. This answers which repo a path targets; it does
NOT read a credential back, the same rule `bsc secret` follows.

BOTH segments are required, so `/repos/acme` is not repo-scoped, and the name stops at a slash, `?`
or `#`. Exit is non-zero when the path targets no repo, so a shell can branch on it.",
        },
        CmdDoc {
            name: "board",
            summary: "parse a projectsV2 GraphQL payload: the Status options, and which items are real issues",
            usage: "\
USAGE:
  bsc github board --file <payload.json> [--json]

Reads the `node` of a `projectsV2` response — as returned by the GraphQL query the app and
`bsc publish` both issue — and reports the Status single-select options IN BOARD ORDER plus the ids
of the items whose content is a real `Issue`.

TWO RULES IT APPLIES that a naive read gets wrong: a Status field with NO options does not match (so
a degenerate field cannot shadow the real one behind it and empty the board), and an item is kept
only when its `__typename` is exactly `Issue` — a draft item or a PullRequest on the board is not
work for an agent.",
        },
    ]
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let docs = command_docs();
    if bsc_cli_util::handle_help(prog, TAGLINE, docs, &args) {
        return Ok(());
    }
    let json = has(&args, "--json");
    match args.first().map(String::as_str) {
        Some("provenance") => cmd_provenance(&args, json),
        Some("repo-for") => cmd_repo_for(&args, json),
        Some("board") => cmd_board(&args, json),
        Some(other) => Err(bsc_cli_util::unknown_command(prog, TAGLINE, docs, other)),
        None => Err(bsc_cli_util::help_overview(prog, TAGLINE, docs)),
    }
}

fn cmd_provenance(args: &[String], json: bool) -> Result<(), String> {
    let restrict = !has(args, "--unrestricted");
    let selector = crate::issue_provenance::triage_issue_list_args(restrict);
    if json {
        let v = serde_json::json!({
            "label": crate::issue_provenance::BSC_ISSUE_LABEL,
            "labelColor": crate::issue_provenance::BSC_ISSUE_LABEL_COLOR,
            "restrictToBsc": restrict,
            "ghIssueListArgs": selector,
        });
        bsc_cli_util::print_raw(&serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
    } else {
        bsc_cli_util::print_raw_lines([
            format!("label      {}", crate::issue_provenance::BSC_ISSUE_LABEL),
            format!("color      {}", crate::issue_provenance::BSC_ISSUE_LABEL_COLOR),
            format!("restricted {restrict}"),
            format!("gh issue list {selector}"),
        ]);
    }
    Ok(())
}

fn cmd_repo_for(args: &[String], json: bool) -> Result<(), String> {
    let path = args
        .iter()
        .skip(1)
        .find(|a| !a.starts_with("--"))
        .ok_or_else(|| "usage: bsc github repo-for <path> [--json]".to_string())?;
    let repo = crate::repo_credentials::repo_from_github_path(path);
    if json {
        let v = serde_json::json!({ "path": path, "repo": repo });
        bsc_cli_util::print_raw(&serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
        return Ok(());
    }
    match repo {
        Some(r) => {
            bsc_cli_util::print_raw(&r);
            Ok(())
        }
        // Non-zero so a shell can branch on it, and the message says WHY rather than printing
        // nothing — "not repo-scoped" and "I could not tell" are different answers.
        None => Err(format!("{path} does not target a repo (a REST path needs both owner and name)")),
    }
}

fn cmd_board(args: &[String], json: bool) -> Result<(), String> {
    let file = flag(args, "--file").ok_or_else(|| "usage: bsc github board --file <payload.json>".to_string())?;
    let text = std::fs::read_to_string(&file).map_err(|e| format!("could not read {file}: {e}"))?;
    let raw: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{file} is not valid JSON: {e}"))?;
    // Accept either the bare `node` or a full GraphQL envelope, because both are things a caller
    // actually has in hand — `data.node` is what the query returns.
    let node_value = if raw.get("data").and_then(|d| d.get("node")).is_some() {
        raw["data"]["node"].clone()
    } else {
        raw
    };
    let node: crate::project_v2::Node =
        serde_json::from_value(node_value).map_err(|e| format!("{file} is not a projectsV2 node: {e}"))?;

    let options = crate::project_v2::status_options(Some(&node));
    let issues: Vec<&crate::project_v2::Item> = crate::project_v2::issue_items(Some(&node));
    if json {
        let v = serde_json::json!({
            "statusOptions": options,
            "issueItemIds": issues.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
            "totalItems": node.items.nodes.len(),
        });
        bsc_cli_util::print_raw(&serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
        return Ok(());
    }
    let mut lines = vec![format!("status options ({})", options.len())];
    for o in &options {
        lines.push(format!("  {:<20} {:<10} {}", o.name, o.color, o.id));
    }
    lines.push(format!("issue items ({} of {} total)", issues.len(), node.items.nodes.len()));
    for i in &issues {
        let status = crate::project_v2::status_field_value(i)
            .and_then(|fv| fv.name.clone())
            .unwrap_or_else(|| "—".to_string());
        lines.push(format!("  {:<24} {status}", i.id));
    }
    bsc_cli_util::print_raw_lines(lines);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn every_advertised_verb_dispatches() {
        // The catalog and the dispatch must not disagree — the failure `bsc perf` and `bsc serve`
        // shipped with, where a real verb appeared in no help output.
        for doc in command_docs() {
            let r = run(args(&[doc.name]), "bsc github");
            if let Err(e) = r {
                assert!(!e.contains("unknown command"), "{} fell through to unknown: {e}", doc.name);
            }
        }
    }

    #[test]
    fn an_unknown_verb_is_named_rather_than_silently_ignored() {
        let e = run(args(&["frobnicate"]), "bsc github").unwrap_err();
        assert!(e.contains("frobnicate"), "{e}");
    }

    #[test]
    fn repo_for_exits_non_zero_when_a_path_targets_no_repo() {
        // "not repo-scoped" and "I could not tell" are different answers, and a shell branches on
        // the exit status — so this must not succeed with empty output.
        assert!(run(args(&["repo-for", "/user/repos"]), "bsc github").is_err());
        assert!(run(args(&["repo-for", "/repos/acme/web"]), "bsc github").is_ok());
    }

    #[test]
    fn board_reads_either_a_bare_node_or_a_graphql_envelope() {
        let dir = std::env::temp_dir().join(format!("bsc-gh-cli-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let node = serde_json::json!({
            "fields": { "nodes": [{ "id": "f1", "name": "Status", "options": [{ "id": "o1", "name": "Todo", "color": "GRAY" }] }] },
            "items": { "nodes": [{ "id": "i1", "fieldValues": { "nodes": [] }, "content": { "__typename": "Issue" } }] }
        });
        let bare = dir.join("bare.json");
        std::fs::write(&bare, serde_json::to_string(&node).unwrap()).unwrap();
        assert!(run(args(&["board", "--file", bare.to_str().unwrap(), "--json"]), "bsc github").is_ok());

        let wrapped = dir.join("wrapped.json");
        std::fs::write(&wrapped, serde_json::to_string(&serde_json::json!({ "data": { "node": node } })).unwrap()).unwrap();
        assert!(run(args(&["board", "--file", wrapped.to_str().unwrap(), "--json"]), "bsc github").is_ok());

        // Fails LOUD, not empty — an agent that asked and got a confident empty answer acts on it.
        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{ not json").unwrap();
        assert!(run(args(&["board", "--file", bad.to_str().unwrap()]), "bsc github").is_err());
        assert!(run(args(&["board", "--file", "/definitely/not/here"]), "bsc github").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
