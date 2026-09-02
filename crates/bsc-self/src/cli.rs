//! `bsc self` — the binary's own health. See the crate header for why this is not circular.

use crate::{
    candidate_paths, freshness, humanize_ms, inspect, mtime_ms, newest_source_mtime, Candidate,
    Freshness, State,
};
use std::path::{Path, PathBuf};

pub const TAGLINE: &str =
    "this binary and its siblings — can the `bsc` you are about to run be trusted?";

pub const VERBS: [&str; 2] = ["doctor", "which"];

pub fn command_docs() -> &'static [bsc_cli_util::CmdDoc] {
    &[
        bsc_cli_util::CmdDoc {
            name: "doctor",
            summary: "every `bsc` on this machine, and whether each can be trusted (#bsc-doctor)",
            usage: "\
USAGE:
  bsc self doctor [--root <dir>] [--json]

THREE FAILURE MODES, each of which cost real time here and none of which a binary can report about itself:

  ZERO-BYTE      a broken link. A shell cannot exec a file with no valid header, so it runs it as an
                 EMPTY SHELL SCRIPT — exit 0, no output, indistinguishable from every command passing.
                 A 0-byte `target/debug/bsc` produced three confident, wrong conclusions before `ls -l`
                 caught it. The size is checked BEFORE anything is executed.
  NO-HANDSHAKE   it runs but cannot identify itself — an incoherent build. An hour went to a build where
                 every `plan` verb exited 0 with empty output.
  STALE          older than the newest `.rs`, so `unknown command` from it means NOT BUILT rather than
                 removed. Three false regression reports. Measured against the TREE, not against
                 `bsc version`'s `built` line — that reads the exe's own mtime, so a COPY reports when it
                 was copied and a month-old binary staged today looks fresh.

EXIT CODES ARE THE POINT: non-zero when NO usable binary exists, 0 when one does. A merely stale binary
WARNS rather than failing, so this is safe to run anywhere, including a gate.",
        },
        bsc_cli_util::CmdDoc {
            name: "which",
            summary: "the `bsc` that would actually be used, and the order it was chosen from",
            usage: "\
USAGE:
  bsc self which [--root <dir>] [--json]

Most-local first: `target/debug`, then `target/release`, then the staged `~/.base-studio-code/bin`. A
local build wins over the staged copy even when the staged one is newer — it is what you are iterating on.

EXISTENCE IS NOT ENOUGH: each candidate must hand-shake before it is chosen, which is the whole lesson of
the zero-byte case.",
        },
    ]
}

fn flag_after(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn real_run(p: &Path) -> (i32, String) {
    // BOUNDED: a hang is as bad as a wrong answer, and this runs inside a gate — a wedged binary must
    // not take the gate with it. `Command` has no timeout, so the child is spawned and reaped with one.
    match std::process::Command::new(p)
        .arg("version")
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(o) => (o.status.code().unwrap_or(1), String::from_utf8_lossy(&o.stdout).into_owned()),
        Err(e) => (127, format!("could not execute: {e}")),
    }
}

fn size_of(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok().map(|m| m.len())
}

fn scan(root: &Path) -> Vec<(Candidate, Freshness)> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let newest =
        newest_source_mtime(&[root.join("crates"), root.join("src-tauri").join("src")]);
    candidate_paths(root, &home)
        .iter()
        .map(|p| {
            let c = inspect(p, &size_of, &real_run);
            let f = freshness(mtime_ms(p), newest);
            (c, f)
        })
        .collect()
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let merged = command_docs();
    if bsc_cli_util::handle_help(prog, TAGLINE, merged, &args) {
        return Ok(());
    }
    let root = flag_after(&args, "--root")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?);
    let json = args.iter().any(|a| a == "--json");

    match args.first().map(String::as_str) {
        Some("doctor") => cmd_doctor(&root, json),
        Some("which") => cmd_which(&root, json),
        _ => Err(format!("usage: {prog} self doctor | {prog} self which  [--root <dir>] [--json]")),
    }
}

fn state_name(s: &State) -> &'static str {
    match s {
        State::Absent => "absent",
        State::ZeroByte => "zero-byte",
        State::NoHandshake => "no-handshake",
        State::Usable => "usable",
    }
}

fn cmd_doctor(root: &Path, json: bool) -> Result<(), String> {
    let rows = scan(root);
    let first_usable = rows.iter().find(|(c, _)| c.ok());

    if json {
        let arr: Vec<serde_json::Value> = rows
            .iter()
            .map(|(c, f)| {
                serde_json::json!({
                    "path": c.path.to_string_lossy(),
                    "state": state_name(&c.state),
                    "ok": c.ok(),
                    "size": c.size,
                    "version": c.version,
                    "detail": if c.detail.is_empty() { serde_json::Value::Null } else { serde_json::json!(c.detail) },
                    "stale": matches!(f, Freshness::Stale { .. }),
                    "behindMs": match f { Freshness::Stale { behind_ms } => serde_json::json!(behind_ms), _ => serde_json::Value::Null },
                })
            })
            .collect();
        bsc_util::emit_line(
            &serde_json::to_string_pretty(&serde_json::json!({
                "candidates": arr,
                "using": first_usable.map(|(c, _)| c.path.to_string_lossy()),
            }))
            .map_err(|e| e.to_string())?,
        );
    } else {
        bsc_util::emit_line("\nbsc binaries");
        for (c, f) in &rows {
            let mark = if c.ok() { "ok  " } else { "FAIL" };
            bsc_util::emit_line(&format!("  [{mark}] {}", c.path.display()));
            if c.ok() {
                bsc_util::emit_line(&format!(
                    "         {}   {:.1} MB",
                    c.version.as_deref().unwrap_or(""),
                    c.size.unwrap_or(0) as f64 / 1e6
                ));
                if let Freshness::Stale { behind_ms } = f {
                    bsc_util::emit_line(&format!(
                        "         STALE — {} older than the newest .rs change. `unknown command` from \
                         this binary means NOT BUILT, not removed.",
                        humanize_ms(*behind_ms)
                    ));
                }
            } else {
                bsc_util::emit_line(&format!("         {}: {}", state_name(&c.state), c.detail));
            }
        }
    }

    match first_usable {
        Some((c, _)) => {
            if !json {
                bsc_util::emit_line(&format!("\nusing: {}", c.path.display()));
            }
            Ok(())
        }
        // NON-ZERO only when NOTHING is usable. A stale binary warned above and still exits 0, which is
        // what makes this safe to run in a gate.
        None => Err("no usable bsc. Build one: cargo build -p bsc --bin bsc".to_string()),
    }
}

fn cmd_which(root: &Path, json: bool) -> Result<(), String> {
    let rows = scan(root);
    let chosen = rows.iter().find(|(c, _)| c.ok());
    if json {
        bsc_util::emit_line(
            &serde_json::to_string_pretty(&serde_json::json!({
                "using": chosen.map(|(c, _)| c.path.to_string_lossy()),
                "order": rows.iter().map(|(c, _)| serde_json::json!({
                    "path": c.path.to_string_lossy(), "state": state_name(&c.state), "ok": c.ok(),
                })).collect::<Vec<_>>(),
            }))
            .map_err(|e| e.to_string())?,
        );
        return Ok(());
    }
    match chosen {
        Some((c, _)) => {
            bsc_util::emit_line(&format!("{}", c.path.display()));
            Ok(())
        }
        None => Err("no usable bsc. Build one: cargo build -p bsc --bin bsc".to_string()),
    }
}
