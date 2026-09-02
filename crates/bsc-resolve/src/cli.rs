//! `bsc resolve` — answer "what would this session receive?" without the app running.
//!
//! ## Why the verb exists at all
//!
//! Before the move, the only way to know which skills or MCP servers a session would get was to
//! launch it and look at what landed in `.claude/skills` / `.mcp.json`. The decision lived in a
//! process behind a webview, so nothing could ask it — not a worker, not a director diagnosing a
//! session that came up wrong, not a test. That is the same undiscoverability the whole `bsc` surface
//! exists to end: a capability only the app can reach may as well not exist.
//!
//! ## BATCHED BY CONSTRUCTION
//!
//! Both verbs take a LIST of sessions on stdin and read each store ONCE. A per-session command is the
//! shape #3908 and then #3954 were filed to undo: at ~39 panes it saturated the command pool and
//! `pty_write` measured 3280 ms. `skills.db` is opened once per CALL here, so a per-session verb
//! would reopen it once per pane — the exact regression, reintroduced one level down.
//!
//! ## READ-ONLY
//!
//! Neither verb writes anything. `write_session_skills` and `write_mcp_json` stay in the app, because
//! writing into a live session's directory is host-owned. This answers; it does not act.

use crate::{mcp, skill};
use std::path::PathBuf;

pub const TAGLINE: &str = "what a session RECEIVES: its resolved skills and MCP servers (read-only)";

pub fn command_docs() -> &'static [bsc_cli_util::CmdDoc] {
    &[
        bsc_cli_util::CmdDoc {
            name: "skills",
            summary: "which library skills resolve for each of N sessions",
            usage: "\
USAGE:
  bsc resolve skills [--db <skills.db>] [--json]      # a JSON array of sessions on stdin

Each session is `{ \"label\": \"...\", \"projectId\": \"...\", \"override\": {\"add\":[],\"remove\":[]},
\"groupIds\": [...] }`. `label` is echoed back so a batch answer can be zipped to its request; every
other field is optional.

BATCHED ON PURPOSE: the library and the group memberships are read ONCE for the whole list. Asking
per session reopens skills.db per pane, which is the regression #3908/#3954 exist to undo.

THE PRECEDENCE CHAIN, which is what this verb is really for:
  1. a DISABLED skill is off, whatever anything else says — nothing can turn it on
  2. IN SCOPE  = the skill names no projects (global), or names this one
  3. VIA GROUP = a toggled-on skill group carries it
  4. the baseline is in-scope OR via-group
  5. an explicit REMOVE beats the baseline, an explicit ADD beats that
  6. `overridden` is `on != baseline` — NOT 'an override mentions it', so a REDUNDANT choice (an add
     for something already on) is not reported as a deviation
  7. `reason` is layered: added/removed when overridden, else pinned > global > project > group,
     else out-of-scope

DEGRADES TO AN EMPTY LIBRARY when the store is missing or unreadable, which reports NO skills. That
is safe in the launch path only because the caller unions with what the renderer sent. Reading a `[]`
here as 'this session gets nothing' is the misreading to avoid — check the store exists.",
        },
        bsc_cli_util::CmdDoc {
            name: "mcp",
            summary: "which MCP servers resolve for a persona, and which survive a sandbox",
            usage: "\
USAGE:
  bsc resolve mcp [--sandboxed] [--json]              # a JSON body on stdin

Stdin is `{ \"library\": [ ...McpServer ], \"personaMcpIds\": [ ... ] }`. The packaged built-ins are
read for you, from the same on-disk-wins-then-packaged `mcp/builtin-servers.json` the app sees.

THE THREE RULES:
  * AMBIENT  — an ENABLED built-in reaches every session; it is the app's own capability, not
    something anybody chose.
  * CARRIED  — anything a persona names is included REGARDLESS of its enabled toggle, because
    carrying is INTENT. That is what lets a DISABLED built-in go to one persona and not the fleet.
  * HALF-CONFIGURED IS SKIPPED — stdio needs a command, http needs a url, so a broken line never
    reaches a session's .mcp.json.

ORDER IS LOAD-BEARING: built-ins come FIRST so .mcp.json keeps a stable order and its diff stays
readable across launches.

--sandboxed applies the namespace narrowing: the BUILT-INS drop, because their marker command
resolves to a host path that does not exist inside the cage (measured — a director declared two
servers and both failed to spawn). Only the built-ins, and only under a namespace: a repo-authored
stdio server legitimately works in there.

DEGRADES TO NO BUILT-INS when builtin-servers.json is unreadable. Everything a persona CARRIES still
resolves, because that comes from the body you passed in.",
        },
    ]
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn read_stdin() -> Result<serde_json::Value, String> {
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("could not read stdin: {e}"))?;
    if buf.trim().is_empty() {
        return Err("expected a JSON body on stdin".to_string());
    }
    serde_json::from_str(&buf).map_err(|e| format!("stdin is not valid JSON: {e}"))
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let docs = command_docs();
    if bsc_cli_util::handle_help(prog, TAGLINE, docs, &args) {
        return Ok(());
    }
    match args.first().map(String::as_str) {
        Some("skills") => cmd_skills(&args),
        Some("mcp") => cmd_mcp(&args),
        Some(other) => Err(bsc_cli_util::unknown_command(prog, TAGLINE, docs, other)),
        None => Err(bsc_cli_util::help_overview(prog, TAGLINE, docs)),
    }
}

/// The default skills store, mirroring the app's `skills_db()`.
fn default_skills_db() -> PathBuf {
    bsc_util::bsc_base_dir().unwrap_or_default().join("skills.db")
}

fn cmd_skills(args: &[String]) -> Result<(), String> {
    let db = flag(args, "--db").map(PathBuf::from).unwrap_or_else(default_skills_db);
    let sessions = read_stdin()?;
    let sessions = sessions.as_array().ok_or("expected a JSON ARRAY of sessions on stdin")?;

    // ONCE for the whole batch — see the module note on #3908/#3954.
    let library = skill::library(&db);

    let mut out = Vec::new();
    for s in sessions {
        let project_id = s["projectId"].as_str().unwrap_or_default();
        let over: Option<skill::SessionSkillOverride> = match &s["override"] {
            serde_json::Value::Null => None,
            v => serde_json::from_value(v.clone()).map_err(|e| format!("bad override: {e}"))?,
        };
        let group_ids: Vec<String> = s["groupIds"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let groups = skill::group_skill_ids(&db, &group_ids);
        let resolved = skill::effective_session_skills(&library, project_id, over.as_ref(), &groups);
        // An ORDERED LIST, not a map: a JSON object's key order does not survive a Rust
        // deserializer, and the order here is the order the skills are written.
        let states: Vec<serde_json::Value> = library
            .iter()
            .map(|sk| {
                let st = skill::session_skill_state(sk, project_id, over.as_ref(), &groups);
                serde_json::json!({
                    "id": sk.id, "name": sk.name,
                    "on": st.on, "reason": st.reason.as_str(), "overridden": st.overridden,
                })
            })
            .collect();
        out.push(serde_json::json!({
            "label": s["label"].as_str().unwrap_or_default(),
            "projectId": project_id,
            "skills": skill::to_skill_cfgs(&resolved),
            "states": states,
        }));
    }
    bsc_cli_util::print_raw(&serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?);
    Ok(())
}

fn cmd_mcp(args: &[String]) -> Result<(), String> {
    let body = read_stdin()?;
    let library: Vec<mcp::McpServer> = serde_json::from_value(body["library"].clone())
        .map_err(|e| format!("bad `library`: {e}"))?;
    let persona_ids: Vec<String> = body["personaMcpIds"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let sandboxed = args.iter().any(|a| a == "--sandboxed");

    let builtins = mcp::builtin_mcp_servers();
    let resolved = mcp::resolve_persona_mcp(&library, &persona_ids, &builtins);
    let reachable = mcp::mcp_reachable_from(&resolved, sandboxed, &builtins);
    let payloads: Vec<_> = reachable.iter().filter_map(mcp::to_mcp_payload).collect();
    let stdio = mcp::to_bsc_agent_mcp(&payloads);

    bsc_cli_util::print_raw(
        &serde_json::to_string_pretty(&serde_json::json!({
            "sandboxed": sandboxed,
            "builtins": builtins.iter().map(|b| b.id.clone()).collect::<Vec<_>>(),
            "servers": payloads,
            "bscAgentStdio": stdio.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
        }))
        .map_err(|e| e.to_string())?,
    );
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
            let e = run(args(&[doc.name]), "bsc resolve");
            if let Err(e) = e {
                assert!(!e.contains("unknown command"), "{} fell through to unknown: {e}", doc.name);
            }
        }
    }

    #[test]
    fn an_unknown_verb_is_named_rather_than_silently_ignored() {
        let e = run(args(&["scrub"]), "bsc resolve").unwrap_err();
        assert!(e.contains("scrub"), "{e}");
    }

    #[test]
    fn the_default_store_is_the_apps_skills_db() {
        // A different default here would make `bsc resolve skills` answer about a store the app never
        // reads, which is worse than failing: it looks like an answer.
        assert!(default_skills_db().ends_with("skills.db"), "{:?}", default_skills_db());
    }
}
