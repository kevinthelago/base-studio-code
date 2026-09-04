//! `bsc perms` — what a session role actually resolves to.
//!
//! ## Why this verb exists
//!
//! The permission derivation was complete, correct and fixture-bound, and **no running session could
//! ask it anything**. A worker wanting to know which commands it may run, or a director diagnosing a
//! session that could not push, had one route: read the TypeScript, or rebuild the app. The one
//! surface most in need of being inspectable by an agent was the least inspectable thing in the tree.
//!
//! ## READ-ONLY, and that is a security property rather than a scoping decision
//!
//! Every verb here answers questions. None of them changes what a role may do. A session inspecting
//! the gate it is subject to is diagnosis; a session ADJUSTING it is privilege escalation, and there
//! is no flag here that could be mistaken for the second.
//!
//! ## WHICH WAY IT FAILS: CLOSED, loudly
//!
//! An unknown role is an ERROR naming the roles that exist, never an empty capability. The difference
//! matters: an empty capability renders as "denies nothing", which reads exactly like a permissive
//! role and would be the most dangerous possible answer to a typo.

use crate::{denies, role_gate, write_scope};
use std::path::{Path, PathBuf};

pub const TAGLINE: &str = "what a session role actually resolves to — capability, denies, tool rules, write scope (read-only)";

pub fn command_docs() -> &'static [bsc_cli_util::CmdDoc] {
    &[
        bsc_cli_util::CmdDoc {
            name: "roles",
            summary: "every role in the frozen capability baseline",
            usage: "\
USAGE:
  bsc perms roles [--root <repo>] [--json]

The 17 roles of the capability table, with each one's four tiers at a glance.

THE SOURCE IS A FROZEN BASELINE, not a live derivation. `roleCapabilityBaseline.fixtures.json` was
captured when the table's source inverted from `data/permissions/role-capabilities.json` onto the
persona floors, and its own header says changing a row is A DELIBERATE ACT — the file exists so a
capability change, above all a WIDENING, shows up as an explicit diff on a reviewable file rather
than as a silent consequence of editing a persona.",
        },
        bsc_cli_util::CmdDoc {
            name: "show",
            summary: "one role's capability and everything derived from it",
            usage: "\
USAGE:
  bsc perms show <role> [--root <repo>] [--json]

The whole chain for one role, in one read: the capability itself, then the artifacts the gate renders
from it — the denied commands, the tool rules, and the write scope.

This is the question a worker actually has (`why can I not run this?`) and it used to be answerable
only by reading the TypeScript or rebuilding the app.

AN UNKNOWN ROLE IS AN ERROR, never an empty capability — an empty one renders as `denies nothing`,
which reads exactly like a permissive role and would be the worst possible answer to a typo.",
        },
    ]
}

/// The frozen capability baseline, as a role → [`role_gate::RoleCapability`] map.
///
/// Deserialized through the SAME struct the gate derives from, deliberately: a field the struct does
/// not model is a field the derivation silently ignores, and this file's whole purpose is to make
/// that visible. Two such bugs are already recorded on `RoleCapability` — `writeGlobs` casing and the
/// dropped `roots` — both found exactly this way.
pub fn baseline(repo_root: &Path) -> Result<Vec<role_gate::RoleCapability>, String> {
    let path = repo_root.join("src/shared/lib/session/roleCapabilityBaseline.fixtures.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read the capability baseline at {}: {e}", path.display()))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("the capability baseline is not valid JSON: {e}"))?;
    let roles = v.get("roles").and_then(|r| r.as_object()).ok_or("the capability baseline has no `roles` object")?;
    let mut out = Vec::new();
    for (name, row) in roles {
        let cap: role_gate::RoleCapability = serde_json::from_value(row.clone())
            .map_err(|e| format!("role `{name}` in the capability baseline does not parse: {e}"))?;
        out.push(cap);
    }
    // Sorted, so two runs and two machines agree. The JSON object's own key order is not a contract.
    out.sort_by(|a, b| a.role.cmp(&b.role));
    Ok(out)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn repo_root(args: &[String]) -> Result<PathBuf, String> {
    if let Some(r) = flag(args, "--root") {
        return Ok(PathBuf::from(r));
    }
    let mut dir = std::env::current_dir().map_err(|e| format!("cannot resolve the cwd: {e}"))?;
    loop {
        if dir.join("src/shared/lib/session/roleCapabilityBaseline.fixtures.json").is_file() {
            return Ok(dir);
        }
        if !dir.pop() {
            return Err("not inside the base-studio-code checkout; pass --root <repo>".to_string());
        }
    }
}

fn tier(t: &role_gate::Tier) -> &'static str {
    match t {
        role_gate::Tier::None => "none",
        role_gate::Tier::Read => "read",
        role_gate::Tier::Write => "write",
    }
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let docs = command_docs();
    if bsc_cli_util::handle_help(prog, TAGLINE, docs, &args) {
        return Ok(());
    }
    match args.first().map(String::as_str) {
        Some("roles") => cmd_roles(&args),
        Some("show") => cmd_show(&args),
        Some(other) => Err(bsc_cli_util::unknown_command(prog, TAGLINE, docs, other)),
        None => Err(bsc_cli_util::help_overview(prog, TAGLINE, docs)),
    }
}

fn cmd_roles(args: &[String]) -> Result<(), String> {
    let caps = baseline(&repo_root(args)?)?;
    if args.iter().any(|a| a == "--json") {
        let rows: Vec<serde_json::Value> = caps
            .iter()
            .map(|c| {
                serde_json::json!({
                    "role": c.role, "github": tier(&c.github), "git": tier(&c.git),
                    "code": tier(&c.code), "net": tier(&c.net), "ui": tier(&c.ui),
                    "restricted": role_gate::is_restricted_role(c),
                })
            })
            .collect();
        bsc_cli_util::print_raw(&serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?);
        return Ok(());
    }
    let w = caps.iter().map(|c| c.role.len()).max().unwrap_or(0);
    let mut lines = vec![format!("{:<w$}  {:<7} {:<7} {:<7} {:<7} {:<7}  {}", "ROLE", "GITHUB", "GIT", "CODE", "NET", "UI", "")];
    for c in &caps {
        lines.push(format!(
            "{:<w$}  {:<7} {:<7} {:<7} {:<7} {:<7}  {}",
            c.role,
            tier(&c.github),
            tier(&c.git),
            tier(&c.code),
            tier(&c.net),
            tier(&c.ui),
            if role_gate::is_restricted_role(c) { "restricted (allow-list)" } else { "" }
        ));
    }
    bsc_cli_util::print_raw_lines(lines);
    Ok(())
}

fn cmd_show(args: &[String]) -> Result<(), String> {
    let want = args
        .get(1)
        .filter(|a| !a.starts_with("--"))
        .ok_or("usage: bsc perms show <role> [--root <repo>] [--json]")?;
    let caps = baseline(&repo_root(args)?)?;
    // FAIL CLOSED: an unknown role errors and names what exists. Returning an empty capability would
    // render as "denies nothing", which is indistinguishable from a permissive role.
    let cap = caps.iter().find(|c| &c.role == want).ok_or_else(|| {
        format!(
            "unknown role `{want}`. The capability baseline holds: {}",
            caps.iter().map(|c| c.role.as_str()).collect::<Vec<_>>().join(", ")
        )
    })?;

    let surfaces = role_gate::capability_surfaces(cap).unwrap_or_default();
    let denied = role_gate::role_denied_commands(cap, &surfaces);
    let denied_tools = role_gate::role_denied_tools(cap);
    let scope = write_scope::scope_write_globs(cap);
    let push = denies::flow_granted_push_commands(None);

    if args.iter().any(|a| a == "--json") {
        bsc_cli_util::print_raw(
            &serde_json::to_string_pretty(&serde_json::json!({
                "capability": cap,
                "deniedCommands": denied,
                "deniedTools": denied_tools,
                "writeScopeGlobs": scope,
                "restricted": role_gate::is_restricted_role(cap),
                "surfaces": surfaces,
                "mayFileToolingRequest": role_gate::may_file_tooling_request(cap),
            }))
            .map_err(|e| e.to_string())?,
        );
        return Ok(());
    }

    let mut out = vec![
        format!("role      {}", cap.role),
        format!(
            "tiers     github={} git={} code={} net={} ui={}",
            tier(&cap.github), tier(&cap.git), tier(&cap.code), tier(&cap.net), tier(&cap.ui)
        ),
        format!("restricted {}", if role_gate::is_restricted_role(cap) { "yes — auto-runs only its allow-list" } else { "no" }),
        String::new(),
        format!("denied commands ({})", denied.len()),
    ];
    out.extend(denied.iter().map(|d| format!("  {d}")));
    out.push(String::new());
    out.push(format!("denied tools ({})", denied_tools.len()));
    out.extend(denied_tools.iter().map(|d| format!("  {d}")));
    out.push(String::new());
    out.push(format!("write scope ({})", scope.len()));
    out.extend(scope.iter().map(|g| format!("  {g}")));
    if !push.is_empty() {
        out.push(String::new());
        out.push("flow-granted push commands (with no flow): none".to_string());
    }
    bsc_cli_util::print_raw_lines(out);
    Ok(())
}

#[cfg(test)]
mod tests {
    //! THE FIRST RUST READER `roleCapabilityBaseline.fixtures.json` HAS EVER HAD.
    //!
    //! It was a contract with one signatory: a frozen, security-critical table pinned only on the
    //! TypeScript side, while Rust derived every deny, tool rule and write scope FROM a capability
    //! without anything checking the capabilities themselves. A widening in that file — which its own
    //! header calls out as the thing it exists to make visible — would not have failed a Rust test.
    use super::*;

    fn repo() -> PathBuf {
        // `crates/bsc-perms` → repo root. The asserts below fail loudly if this is ever wrong,
        // because `baseline` errors rather than returning an empty list.
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn every_role_in_the_frozen_baseline_parses_as_a_capability() {
        // A field the struct does not model is a field the derivation silently IGNORES. Two such
        // bugs are already recorded on `RoleCapability` — `writeGlobs` casing and the dropped
        // `roots` — and both were found exactly this way.
        let caps = baseline(&repo()).expect("the capability baseline must parse");
        // 19 since `a-network-gets-a-root-session-that-can-use-what-it-owns` added the STEWARD — a
        // network's root session, `none` on every axis with a read-only allow-list. Bumping this
        // number is the deliberate act the message asks for, and the reasoning lives beside the
        // capability itself in `roleCapabilityBaseline.fixtures.json`'s `_amendments`.
        assert_eq!(caps.len(), 19, "the baseline holds 19 roles; a change here is a DELIBERATE act");
        for c in &caps {
            assert!(!c.role.is_empty(), "a capability with no role name");
        }
    }

    #[test]
    fn the_baseline_is_sorted_so_two_runs_agree() {
        let caps = baseline(&repo()).expect("baseline");
        let mut sorted = caps.clone();
        sorted.sort_by(|a, b| a.role.cmp(&b.role));
        assert_eq!(caps, sorted, "a JSON object's key order is not a contract");
    }

    #[test]
    fn the_derivation_runs_for_every_role_without_panicking() {
        // The chain a session actually depends on, over every role rather than the one someone
        // thought to test.
        for cap in baseline(&repo()).expect("baseline") {
            let surfaces = role_gate::capability_surfaces(&cap).unwrap_or_default();
            let _ = role_gate::role_denied_commands(&cap, &surfaces);
            let _ = role_gate::role_denied_tools(&cap);
            let _ = write_scope::scope_write_globs(&cap);
            let _ = role_gate::role_write_rules(&cap, &[], &[]);
        }
    }

    #[test]
    fn a_code_none_role_can_never_be_handed_an_unscoped_write() {
        // THE INVARIANT THE WHOLE CLUSTER EXISTS FOR, checked over the real table rather than a
        // hand-made capability: a role with `code: none` and no write carve-out must not come back
        // with a write scope that would let it edit the repo.
        for cap in baseline(&repo()).expect("baseline") {
            if !matches!(cap.code, role_gate::Tier::None) || role_gate::has_scoped_write_carve_out(&cap) {
                continue;
            }
            let globs = write_scope::scope_write_globs(&cap);
            assert!(
                !globs.iter().any(|g| g == "**" || g == "**/*"),
                "role `{}` is code:none with no carve-out yet resolves to an unscoped write ({globs:?})",
                cap.role
            );
        }
    }

    #[test]
    fn an_unknown_role_fails_closed_and_names_what_exists() {
        // An empty capability renders as "denies nothing", which reads exactly like a permissive
        // role — the worst possible answer to a typo.
        let err = run(
            vec!["show".into(), "wroker".into(), "--root".into(), repo().to_string_lossy().into_owned()],
            "bsc perms",
        )
        .unwrap_err();
        assert!(err.contains("unknown role `wroker`"), "{err}");
        assert!(err.contains("worker"), "the error must name the roles that exist: {err}");
    }
}
