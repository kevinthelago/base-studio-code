//! `bsc deploy` — the verbs.

use crate::plan::{outcome, Outcome, Plan};
use crate::remote;
use crate::roster::{self, Device};
use bsc_cli_util::CmdDoc;

/// The catalog. One source, so help and dispatch cannot disagree.
pub const COMMANDS: &[CmdDoc] = &[
        CmdDoc { name: "devices", summary: "the roster — every machine this app deploys to", usage: "devices [--json]" },
        CmdDoc { name: "status", summary: "what each device is RUNNING, and whether it is behind (answers, never acts)", usage: "status [<device>] --artifact <path> [--json]" },
        CmdDoc { name: "push", summary: "ship the artifact to a device: stage, verify THERE, swap, restart, probe, roll back on failure", usage: "push <device> --artifact <path> [--name <n>] [--dry-run]" },
        CmdDoc { name: "rollback", summary: "put a device back on its previous binary", usage: "rollback <device> [--name <n>]" },
];

/// Kept as a function too, so callers reading a catalog uniformly do not care which form a crate chose.
pub fn command_docs() -> &'static [CmdDoc] { COMMANDS }

const PROG: &str = "bsc deploy";

/// The deployed artifact's name on the device. Defaults to `bsc`; `bsc net` will ship as `bsc-net`.
const DEFAULT_NAME: &str = "bsc";

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let docs = command_docs();
    let Some(verb) = args.first().map(String::as_str) else {
        println!("{}", bsc_cli_util::help_overview(prog, "ship a binary to a device, and be able to take it back", docs));
        return Ok(());
    };
    let rest: Vec<String> = args[1..].to_vec();
    match verb {
        "help" | "--help" | "-h" => {
            println!("{}", bsc_cli_util::help_overview(prog, "ship a binary to a device, and be able to take it back", docs));
            Ok(())
        }
        "devices" => devices(&rest),
        "status" => status(&rest),
        "push" => push(&rest),
        "rollback" => rollback(&rest),
        other => Err(format!("unknown command '{other}' — try `{PROG} help`")),
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}
fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}
fn artifact_name(args: &[String]) -> String {
    flag(args, "--name").unwrap_or_else(|| DEFAULT_NAME.to_string())
}

fn devices(args: &[String]) -> Result<(), String> {
    let d = roster::load()?;
    if has(args, "--json") {
        println!("{}", serde_json::to_string(&d).map_err(|e| e.to_string())?);
        return Ok(());
    }
    if d.is_empty() {
        let p = roster::roster_path().map(|p| p.display().to_string()).unwrap_or_default();
        println!("no devices — add a roster at {p}");
        return Ok(());
    }
    for x in &d {
        println!("  {:<14} {:<40} {:<9} {}", x.name, x.ssh, x.arch, x.service.as_deref().unwrap_or("—"));
    }
    Ok(())
}

/// The artifact's architecture, read from the ELF header via `file`. Derived rather than assumed:
/// asking the operator to declare it is how the wrong binary gets declared right.
fn artifact_arch(path: &std::path::Path) -> Result<String, String> {
    let out = std::process::Command::new("file")
        .arg("-b")
        .arg(path)
        .output()
        .map_err(|e| format!("cannot run file: {e}"))?;
    let s = String::from_utf8_lossy(&out.stdout);
    // `file` says "ELF 64-bit LSB pie executable, x86-64, …" or "…, ARM aarch64, …". Map to what
    // `uname -m` reports, since that is what the roster and the device both speak.
    if s.contains("aarch64") || s.contains("ARM aarch64") {
        Ok("aarch64".into())
    } else if s.contains("x86-64") {
        Ok("x86_64".into())
    } else {
        Err(format!("cannot tell the architecture of {} — file said: {}", path.display(), s.trim()))
    }
}

fn resolve_artifact(args: &[String]) -> Result<(std::path::PathBuf, String, String), String> {
    let p = flag(args, "--artifact").ok_or("--artifact <path> is required")?;
    let path = std::path::PathBuf::from(&p);
    if !path.exists() {
        return Err(format!("no artifact at {}", path.display()));
    }
    let sha = remote::local_sha(&path)?;
    let arch = artifact_arch(&path)?;
    Ok((path, sha, arch))
}

fn status(args: &[String]) -> Result<(), String> {
    let all = roster::load()?;
    let targets: Vec<Device> = match args.first().filter(|a| !a.starts_with("--")) {
        Some(n) => vec![roster::find(&all, n)?.clone()],
        None => all.clone(),
    };
    let name = artifact_name(args);
    let artifact = resolve_artifact(args).ok();
    let mut rows = Vec::new();
    for d in &targets {
        let st = remote::read_state(d, &name);
        let verdict = match &artifact {
            Some((_, sha, arch)) => match Plan::decide(d, sha, arch, &st) {
                Plan::UpToDate => "current".to_string(),
                Plan::Deploy => "BEHIND".to_string(),
                Plan::Refuse(m) => format!("refuses: {m}"),
            },
            // No artifact given: report what it has without judging it. "Cannot tell" is an honest
            // answer and must never render as "current".
            None => "unknown (no --artifact)".to_string(),
        };
        let reachable = st.arch.is_some();
        rows.push(serde_json::json!({
            "device": d.name, "arch": d.arch, "reachable": reachable,
            "running": st.current_sha, "previous": st.previous_sha, "verdict": verdict,
        }));
        if !has(args, "--json") {
            let running = st.current_sha.as_deref().map(|s| &s[..s.len().min(12)]).unwrap_or("—");
            println!(
                "  {:<14} {:<9} {:<12} {}{}",
                d.name, d.arch, running, verdict,
                if reachable { "" } else { "  (unreachable)" }
            );
        }
    }
    if has(args, "--json") {
        println!("{}", serde_json::to_string(&rows).map_err(|e| e.to_string())?);
    }
    Ok(())
}

fn push(args: &[String]) -> Result<(), String> {
    let all = roster::load()?;
    let dev_name = args.first().filter(|a| !a.starts_with("--")).ok_or("usage: push <device> --artifact <path>")?;
    let d = roster::find(&all, dev_name)?.clone();
    let name = artifact_name(args);
    let (path, sha, arch) = resolve_artifact(args)?;
    let st = remote::read_state(&d, &name);

    match Plan::decide(&d, &sha, &arch, &st) {
        Plan::Refuse(m) => return Err(m),
        Plan::UpToDate => {
            println!("{} is already running {} — nothing to do", d.name, &sha[..12]);
            return Ok(());
        }
        Plan::Deploy => {}
    }
    if has(args, "--dry-run") {
        println!("would deploy {} ({}) to {}", &sha[..12], arch, d.name);
        return Ok(());
    }

    println!("staging {} on {} …", &sha[..12], d.name);
    remote::stage(&d, &path, &name, &sha)?;
    println!("  verified on {} — swapping", d.name);
    remote::swap(&d, &name, &sha)?;
    remote::restart(&d)?;

    let (ok, detail) = remote::probe(&d, &name);
    match outcome(ok, &detail, st.current_sha.as_deref()) {
        Outcome::Healthy => {
            println!("  {} is running {}", d.name, &sha[..12]);
            Ok(())
        }
        Outcome::RollBack(why) => {
            remote::revert(&d, &name)?;
            remote::restart(&d)?;
            Err(format!(
                "{} FAILED its health probe and was ROLLED BACK to {} — {}",
                d.name,
                st.current_sha.as_deref().map(|s| &s[..s.len().min(12)]).unwrap_or("?"),
                why
            ))
        }
        Outcome::FailedWithNoPrevious(why) => Err(format!(
            "{} FAILED its health probe and there is NO previous binary to restore — {}. \
             The staged binary is in place but unproven; fix it before relying on this device.",
            d.name, why
        )),
    }
}

fn rollback(args: &[String]) -> Result<(), String> {
    let all = roster::load()?;
    let dev_name = args.first().filter(|a| !a.starts_with("--")).ok_or("usage: rollback <device>")?;
    let d = roster::find(&all, dev_name)?.clone();
    let name = artifact_name(args);
    remote::revert(&d, &name)?;
    remote::restart(&d)?;
    let (ok, detail) = remote::probe(&d, &name);
    if !ok {
        return Err(format!("{} rolled back but the previous binary does not run either — {detail}", d.name));
    }
    println!("{} rolled back", d.name);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_in_the_catalog_is_dispatched() {
        // The drift this repo keeps getting caught by: a catalog that advertises a verb dispatch does
        // not have. An unknown verb errors, so a catalog entry that reaches the fallthrough is caught.
        for doc in command_docs() {
            let err = run(vec![doc.name.into()], PROG).err().unwrap_or_default();
            assert!(
                !err.contains("unknown command"),
                "catalog advertises '{}' but dispatch does not handle it",
                doc.name
            );
        }
    }

    #[test]
    fn an_unknown_verb_is_refused_and_names_the_help() {
        let e = run(vec!["nope".into()], PROG).unwrap_err();
        assert!(e.contains("unknown command") && e.contains("help"), "got: {e}");
    }

    #[test]
    fn the_artifact_name_defaults_but_is_overridable() {
        // `bsc net` will ship under its own name beside `bsc`; both live in one deploy tree.
        assert_eq!(artifact_name(&[]), "bsc");
        assert_eq!(artifact_name(&["--name".into(), "bsc-net".into()]), "bsc-net");
    }

    #[test]
    fn a_missing_artifact_path_is_an_error_not_a_default() {
        let e = resolve_artifact(&["--artifact".into(), "/nonexistent/xyz".into()]).unwrap_err();
        assert!(e.contains("no artifact at"), "got: {e}");
    }
}
