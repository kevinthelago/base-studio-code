//! `bsc capability` — what a network can DO right now.

use crate::freshness::Observation;
use crate::model::BUDGET_MS;
use crate::read::{capabilities_of, DeviceRow, Sources};
use bsc_cli_util::CmdDoc;

pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "get",
        summary: "what a network can DO right now — its projects, its devices, and when each was last observed",
        usage: "get <network> [--json|--context]",
    },
    CmdDoc {
        name: "networks",
        summary: "every network that has capabilities to report",
        usage: "networks [--json]",
    },
];

pub fn command_docs() -> &'static [CmdDoc] { COMMANDS }

const TAGLINE: &str = "the USE layer — what a network can do right now, and how fresh that answer is";

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let Some(verb) = args.first().map(String::as_str) else {
        println!("{}", bsc_cli_util::surface::help_overview(prog, TAGLINE, COMMANDS));
        return Ok(());
    };
    let rest: Vec<String> = args[1..].to_vec();
    match verb {
        "help" | "--help" | "-h" => {
            println!("{}", bsc_cli_util::surface::help_overview(prog, TAGLINE, COMMANDS));
            Ok(())
        }
        "networks" => networks(),
        "get" => get(&rest),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// Run one of `bsc`'s own subcommands, by re-invoking THIS binary.
///
/// `current_exe` rather than a PATH lookup or `$BSC_BIN`: `bsc capability` only ever runs inside the
/// `bsc` binary, so the process already IS the thing it needs. A PATH lookup could find a DIFFERENT,
/// older `bsc` — the staged copy in `~/.base-studio-code/bin` is routinely behind the one a developer
/// just built — and this surface's entire value is reporting current state.
///
/// Reading through the sibling verb rather than linking its crate is deliberate: `bsc project network`
/// owns the project→network assignment and `bsc deploy` owns the roster. A second reader of either
/// column is exactly the drift this layer exists to remove.
fn self_bsc(args: &[&str]) -> Result<std::process::Output, std::io::Error> {
    let exe = std::env::current_exe()?;
    std::process::Command::new(exe).args(args).output()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `bsc project network list` prints `key<TAB>network` per line, and `(unfiled)` for a project with
/// none. Parsed rather than re-implemented: that verb owns the assignment, and a second reader of the
/// same column is the drift this whole layer exists to avoid.
fn project_networks() -> Vec<(String, String)> {
    let Ok(out) = self_bsc(&["project", "network", "list"]) else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(k, n)| (k.trim().to_string(), n.trim().to_string()))
        .filter(|(_, n)| !n.is_empty() && n != "(unfiled)")
        .collect()
}

/// The deploy roster, with each device's live state.
///
/// A device that cannot be reached yields a reading of "unreachable" AT THE TIME WE LOOKED — which is
/// a fresh fact, not a stale one. That distinction matters: "I asked just now and it did not answer"
/// is actionable, while "I have not asked since Tuesday" is not, and collapsing them would hide which.
fn devices() -> Vec<DeviceRow> {
    let Ok(out) = self_bsc(&["deploy", "devices", "--json"]) else { return Vec::new() };
    let parsed: Vec<serde_json::Value> =
        serde_json::from_slice(&out.stdout).unwrap_or_default();
    let at = now_ms();
    parsed
        .iter()
        .filter_map(|d| {
            let name = d.get("name")?.as_str()?.to_string();
            let arch = d.get("arch").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            Some(DeviceRow { name, arch, observed: Observation::seen("in the roster", at) })
        })
        .collect()
}

fn sources() -> Sources {
    Sources { project_networks: project_networks(), devices: devices() }
}

fn networks() -> Result<(), String> {
    let s = sources();
    let mut names: Vec<&String> = s.project_networks.iter().map(|(_, n)| n).collect();
    names.sort();
    names.dedup();
    if names.is_empty() {
        println!("no network has any project yet — `bsc project network set <project> <network>`");
        return Ok(());
    }
    for n in names {
        let c = capabilities_of(n, &s);
        println!("  {:<22} {} project(s) · {} capability(ies)", n, c.projects.len(), c.total());
    }
    Ok(())
}

fn get(args: &[String]) -> Result<(), String> {
    let net = args
        .first()
        .filter(|a| !a.starts_with("--"))
        .ok_or("usage: bsc capability get <network> [--json|--context]")?;
    let caps = capabilities_of(net, &sources());
    let now = now_ms();
    if args.iter().any(|a| a == "--json") {
        println!("{}", serde_json::to_string(&caps).map_err(|e| e.to_string())?);
        return Ok(());
    }
    if args.iter().any(|a| a == "--context") {
        // What a SESSION reads. Same value as the screen renders — see `to_context`'s doc for why
        // that identity is the point rather than a convenience.
        print!("{}", caps.to_context(now, BUDGET_MS));
        return Ok(());
    }
    if caps.total() == 0 {
        println!("`{net}` exposes no capabilities yet — nothing it owns is deployed or published.");
        return Ok(());
    }
    println!("  {} · {} of {} fresh enough to act on", net, caps.believable(now, BUDGET_MS), caps.total());
    for (project, name, kind, state) in caps.rows(now, BUDGET_MS) {
        println!("  {:<20} {:<18} {:<9} {}", project, name, kind, state);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_in_the_catalog_is_dispatched() {
        for doc in COMMANDS {
            let err = run(vec![doc.name.into()], "bsc capability").err().unwrap_or_default();
            assert!(!err.contains("unknown command"), "catalog advertises '{}' but dispatch does not handle it", doc.name);
        }
    }

    #[test]
    fn get_without_a_network_is_a_usage_error_not_a_guess() {
        // Defaulting to "the first network" would answer a question nobody asked, and the answer would
        // look authoritative.
        let e = run(vec!["get".into()], "bsc capability").unwrap_err();
        assert!(e.contains("usage"), "got: {e}");
    }

    #[test]
    fn an_unknown_verb_is_refused_with_the_catalog() {
        let e = run(vec!["nope".into()], "bsc capability").unwrap_err();
        assert!(e.contains("COMMANDS:"), "the refusal carries the catalog: {e}");
    }
}
