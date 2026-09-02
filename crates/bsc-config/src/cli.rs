//! The `bsc config` subcommand (#168, request from the config-seed mirror #4251): read/adopt verbs
//! over the runtime config-seed mirror (`~/.base-studio-code/config/`). Before this, a file the app
//! classified as DIVERGED from the packaged seed could be seen in the boot log but not acted on — the
//! only remedy was deleting it by hand.

use crate::{diff, packaged, reset, status, FileState, ResetError};
use bsc_cli_util::CmdDoc;

const TAGLINE: &str = "the runtime config-seed mirror: read/adopt verbs for a file diverged from the packaged seed (#168)";

/// The crate's own verb catalog. `pub` so `bsc surface verbs` can PROJECT it rather than
/// restate it — a generated catalog cannot drift, a second list does.
pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "status",
        summary: "every config file NOT in sync with the packaged seed, classified",
        usage: "\
USAGE:
  bsc config status [--all] [--json]

Classifies every packaged config file (plus every manifest-tracked file no longer packaged) against
the on-disk mirror at ~/.base-studio-code/config/ — READ-ONLY, the same classification the app makes
silently at boot (#4251). By default only the actionable states are printed (missing / stale /
diverged / retired / orphaned); pass --all to also list up_to_date files. A DIVERGED file is followed
by its diff against the packaged copy (the on-disk copy is never touched — `reset` is the only write).
An ORPHANED file has no packaged counterpart to diff against (its seed was retired), so it is listed
with no diff.

--json emits the full classification (every file, every state) as an array of {rel, state}.

STATES:
  missing     not on disk yet — the next app launch (or `reset`) creates it
  up_to_date  on disk, matches the packaged bytes exactly
  stale       an untouched mirror that fell behind — the next app launch refreshes it silently
  diverged    edited (or unknown provenance) — never auto-refreshed; see the diff, then `reset` to adopt
  retired     seed no longer ships, untouched copy — the next app launch removes it silently
  orphaned    seed no longer ships, copy was edited — kept forever; `reset` cannot help (nothing to adopt)",
    },
    CmdDoc {
        name: "diff",
        summary: "the diff between one file's on-disk copy and the packaged seed",
        usage: "\
USAGE:
  bsc config diff <rel>

Shows the line diff between the on-disk copy of <rel> (under ~/.base-studio-code/config/) and its
CURRENT packaged bytes. Errors if <rel> is not on disk, or is not currently packaged (a retired seed —
there is nothing left to diff against; `bsc config status` still shows it as orphaned/retired).",
    },
    CmdDoc {
        name: "reset",
        summary: "adopt the packaged copy of one file, overwriting the on-disk edit",
        usage: "\
USAGE:
  bsc config reset <rel>

Overwrites <rel>'s on-disk copy under ~/.base-studio-code/config/ with the CURRENT packaged bytes and
records that hash, so the next `bsc config status` reports it up_to_date. This is the one write this
command offers, and it is exactly what a packaged improvement would have done had the file never been
edited — the prior content is NOT backed up (it is exactly what `git diff`/`bsc config diff` before
running this is for). Errors with `not a currently packaged config file` on a name that is not shipped
— a typo, or a genuinely retired seed for which there is nothing left to adopt.",
    },
];

/// The `config` subcommand entrypoint: `args` is everything after `bsc config`; `prog` is the display name.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let json = args.iter().any(|a| a == "--json");
    let all = args.iter().any(|a| a == "--all");
    let positional: Vec<String> = args.iter().filter(|a| !a.starts_with("--")).cloned().collect();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &positional) {
        return Ok(());
    }

    let cmd = positional.first().map(String::as_str).unwrap_or_default();
    match cmd {
        "status" => cmd_status(all, json),
        "diff" => cmd_diff(&positional),
        "reset" => cmd_reset(&positional),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn cmd_status(all: bool, json: bool) -> Result<(), String> {
    let report = status();

    if json {
        let rows: Vec<serde_json::Value> =
            report.iter().map(|s| serde_json::json!({"rel": s.rel, "state": s.state.as_str()})).collect();
        let out = serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?;
        bsc_cli_util::print_raw(&out);
        return Ok(());
    }

    let shown: Vec<_> = report.iter().filter(|s| all || s.state != FileState::UpToDate).collect();
    if shown.is_empty() {
        bsc_cli_util::print_raw("every packaged config file is up to date");
        return Ok(());
    }

    let w = shown.iter().map(|s| s.state.as_str().len()).max().unwrap_or(0);
    let mut out = String::new();
    for s in &shown {
        out.push_str(&format!("{:<w$}  {}\n", s.state.as_str(), s.rel, w = w));
        if s.state == FileState::Diverged {
            if let Some(rendered) = diff_against_packaged(&s.rel) {
                out.push_str(&indent(&rendered));
            }
        }
    }
    bsc_cli_util::print_raw(out.trim_end());
    Ok(())
}

fn cmd_diff(positional: &[String]) -> Result<(), String> {
    let rel = positional.get(1).ok_or("usage: bsc config diff <rel>")?;
    match diff_against_packaged(rel) {
        Some(rendered) => {
            bsc_cli_util::print_raw(rendered.trim_end());
            Ok(())
        }
        None => Err(format!(
            "'{rel}' is not on disk under ~/.base-studio-code/config/, or is not currently packaged \
             (see `bsc config status`)"
        )),
    }
}

fn cmd_reset(positional: &[String]) -> Result<(), String> {
    let rel = positional.get(1).ok_or("usage: bsc config reset <rel>")?;
    match reset(rel) {
        Ok(hash) => {
            println!("reset {rel} to the packaged copy ({})", &hash[..12.min(hash.len())]);
            Ok(())
        }
        Err(ResetError::NotPackaged) => Err(ResetError::NotPackaged.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// Read `rel`'s on-disk bytes and diff them against the current packaged bytes, or `None` if either
/// side is unavailable (not on disk, or not currently packaged — an orphaned/retired file).
fn diff_against_packaged(rel: &str) -> Option<String> {
    let on_disk = std::fs::read_to_string(crate::config_root().join(rel)).ok()?;
    let packaged_bytes = packaged(rel)?;
    let packaged_text = std::str::from_utf8(packaged_bytes).ok()?;
    Some(diff::render(&diff::line_diff(&on_disk, packaged_text)))
}

fn indent(s: &str) -> String {
    s.lines().map(|l| format!("    {l}\n")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_help_names_every_command() {
        let h = bsc_cli_util::help_overview("bsc config", TAGLINE, COMMANDS);
        assert!(h.contains("status") && h.contains("diff") && h.contains("reset"));
    }

    #[test]
    fn an_unknown_command_is_refused_with_the_overview() {
        let e = run(vec!["bogus".into()], "bsc config").unwrap_err();
        assert!(e.contains("unknown command 'bogus'"));
        assert!(e.contains("COMMANDS:"));
    }

    #[test]
    fn diff_without_a_rel_argument_is_a_usage_error() {
        let e = run(vec!["diff".into()], "bsc config").unwrap_err();
        assert!(e.contains("usage: bsc config diff"));
    }

    #[test]
    fn reset_without_a_rel_argument_is_a_usage_error() {
        let e = run(vec!["reset".into()], "bsc config").unwrap_err();
        assert!(e.contains("usage: bsc config reset"));
    }

    #[test]
    fn reset_on_an_unpackaged_name_reports_not_packaged() {
        let e = run(vec!["reset".into(), "definitely/not/packaged.json".into()], "bsc config").unwrap_err();
        assert!(e.contains("not a currently packaged config file"), "{e}");
    }

    #[test]
    fn diff_on_a_name_absent_from_both_sides_is_an_error() {
        let e = run(vec!["diff".into(), "definitely/not/anywhere.json".into()], "bsc config").unwrap_err();
        assert!(e.contains("not on disk") || e.contains("not currently packaged"), "{e}");
    }

    /// The embed must actually carry the config-only subset — a build.rs path bug would make every
    /// verb above silently see nothing, which none of the argument-parsing tests would catch.
    #[test]
    fn the_embedded_seed_backing_this_cli_is_non_empty() {
        assert!(!crate::embedded_files().is_empty());
    }
}
