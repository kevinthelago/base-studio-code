//! The `bsc shot` subcommand (#3261, epic #3260) — ask the RUNNING app for a webview snapshot and print
//! the PNG path, so an external session can SEE the app rather than infer what it looks like.
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc shot help          # compact menu
//!   bsc shot take help     # detailed help for ONE command
//!
//! Two directories, deliberately: the CHANNEL ([`bsc_appchan::chan_dir`], shared with `bsc navigate`)
//! carries the request/reply files; `~/.base-studio-code/shots/` (or `BSC_SHOT_DIR`) holds the PNGs the
//! caller owns. Sweeping the transport must never be able to delete someone's screenshots.

use crate::{is_png, shots_dir, Rect, ShotRequest, ShotResult, KIND};
use bsc_cli_util::CmdDoc;

const TAGLINE: &str = "capture the RUNNING app's real pixels — a webview snapshot (#3261)";

/// How long a `take` waits for the app. The app answers in well under a second when it is running; this
/// bound exists so a request made with NO app running fails fast and clearly instead of hanging a loop
/// iteration forever.
const DEFAULT_TIMEOUT_MS: i64 = 8_000;
const POLL_INTERVAL_MS: u64 = 40;

/// Requests older than this are swept on each `take` — an abandoned CLI (Ctrl-C'd mid-poll) or one made
/// while no app was running must not accumulate, nor be served later to nobody.
const STALE_MS: i64 = 60_000;

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "take",
        summary: "capture the app's webview; prints the PNG path",
        usage: "\
USAGE:
  bsc shot take [--rect x,y,w,h] [--out <path>] [--timeout <ms>] [--json|--pretty]

Asks the RUNNING desktop app to snapshot its webview and writes a PNG. Prints the path (--json emits
{ path, w, h }).

  --rect x,y,w,h   crop to a region, in CSS pixels from the webview's top-left. Omit for the whole
                   webview. The frontend knows a preview iframe's getBoundingClientRect(), so
                   'just the component' is a crop, not a second capture path.
  --out <path>     where to write the PNG. Default: <shots dir>/<id>.png
  --timeout <ms>   how long to wait for the app (default 8000).

WHAT IT CAPTURES
  The webview's COMPOSITED output — pixel-identical to what you see, including the sandboxed preview
  iframe, and a render rather than a screen grab. Verified: a capture taken while the window was
  MINIMIZED is byte-identical to a visible one, so the overnight case (#3260) cannot silently produce
  black frames.

REQUIRES THE APP RUNNING
  `bsc` cannot call the app (the bridge only runs app→bsc), so this drops a request in the channel dir
  and waits for the app's watcher. No app ⇒ a clear timeout error, never a hang.

PAIR IT WITH NAVIGATE
  A shot captures whatever is on screen. To target something, steer first:
    bsc navigate component <kit> <component> && bsc shot take",
    },
    CmdDoc {
        name: "pending",
        summary: "unanswered channel requests (JSON) — what the app's watcher would serve",
        usage: "\
USAGE:
  bsc shot pending [--json|--pretty]

Every request with no reply beside it, oldest first, across ALL verbs (shot + navigate share one
channel). Diagnostic: if `take` times out, this shows whether the request landed (⇒ the app/watcher is
not running) or was never written.",
    },
    CmdDoc {
        name: "sweep",
        summary: "drop aged request/reply files (never the PNGs)",
        usage: "\
USAGE:
  bsc shot sweep [--max-age <ms>] [--json]

Removes channel request/reply files older than --max-age (default 60000). PNGs are never swept — they
live in a different directory precisely so this cannot eat them. `take` sweeps automatically.",
    },
    CmdDoc {
        name: "dir",
        summary: "the shots (PNG) directory and the channel directory",
        usage: "\
USAGE:
  bsc shot dir [--json]

Prints both: the PNG output dir (BSC_SHOT_DIR, else ~/.base-studio-code/shots) and the request channel
(BSC_APPCHAN_DIR, else ~/.base-studio-code/appreq).",
    },
];

#[derive(Default)]
struct Args {
    positional: Vec<String>,
    rect: Option<Rect>,
    out: Option<String>,
    timeout_ms: Option<i64>,
    max_age_ms: Option<i64>,
    json: bool,
    pretty: bool,
}

fn parse_args(args: Vec<String>) -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = args.into_iter();
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--rect" => a.rect = Some(parse_rect(&it.next().ok_or("--rect needs x,y,w,h")?)?),
            "--out" => a.out = Some(it.next().ok_or("--out needs a path")?),
            "--timeout" => {
                let v = it.next().ok_or("--timeout needs a value in ms")?;
                a.timeout_ms = Some(v.parse().map_err(|_| format!("--timeout: not a number: {v}"))?);
            }
            "--max-age" => {
                let v = it.next().ok_or("--max-age needs a value in ms")?;
                a.max_age_ms = Some(v.parse().map_err(|_| format!("--max-age: not a number: {v}"))?);
            }
            other if other.starts_with("--") => return Err(format!("unknown flag: {other}")),
            other => a.positional.push(other.to_string()),
        }
    }
    Ok(a)
}

/// `x,y,w,h`. A zero-area rect is rejected here rather than sent to the app to fail — the CLI can tell
/// the caller exactly what was wrong; the app could only say "capture failed".
pub fn parse_rect(s: &str) -> Result<Rect, String> {
    let parts: Vec<&str> = s.split(',').map(|p| p.trim()).collect();
    if parts.len() != 4 {
        return Err(format!("--rect wants x,y,w,h (4 comma-separated numbers), got: {s}"));
    }
    let n = |i: usize| -> Result<u32, String> {
        parts[i].parse::<u32>().map_err(|_| format!("--rect: not a non-negative number: {}", parts[i]))
    };
    let (x, y, w, h) = (n(0)?, n(1)?, n(2)?, n(3)?);
    if w == 0 || h == 0 {
        return Err(format!("--rect: width and height must be > 0, got {w}x{h}"));
    }
    Ok(Rect { x, y, w, h })
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "take" => cmd_take(&args),
        "pending" => cmd_pending(&args),
        "sweep" => cmd_sweep(&args),
        "dir" => cmd_dir(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn cmd_take(args: &Args) -> Result<(), String> {
    let chan = bsc_appchan::chan_dir()?;
    let now = bsc_util::now_ms();
    let _ = bsc_appchan::sweep_stale(&chan, now, STALE_MS); // best-effort: never block a capture

    let id = bsc_appchan::new_id(now);
    let req = ShotRequest { rect: args.rect, out: args.out.clone() };
    bsc_appchan::write_request(&chan, &id, KIND, now, &req)?;

    let timeout = args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let reply = bsc_appchan::poll_reply(&chan, &id, timeout, POLL_INTERVAL_MS, || {
        format!(
            "timed out after {timeout}ms waiting for the app to answer.\n\
             The request is at {}.\n\
             Is the desktop app running? `bsc` cannot capture on its own — the app's watcher does the \
             snapshot. `bsc shot pending` shows whether the request landed.",
            bsc_appchan::request_path(&chan, &id).display()
        )
    })?;
    let res: ShotResult = bsc_appchan::take_payload(reply).map_err(|e| format!("capture failed: {e}"))?;

    // Prove the app wrote a real image. A capture that silently produced nothing (or something that is
    // not a PNG) must not report success — that is the failure this whole surface exists to avoid.
    let bytes = std::fs::read(&res.path)
        .map_err(|e| format!("the app reported {} but it cannot be read: {e}", res.path))?;
    if !is_png(&bytes) {
        return Err(format!("the app wrote {} but it is not a PNG ({} bytes)", res.path, bytes.len()));
    }

    bsc_cli_util::emit(args.pretty, args.json, &res, || res.path.clone());
    Ok(())
}

fn cmd_pending(args: &Args) -> Result<(), String> {
    let chan = bsc_appchan::chan_dir()?;
    let pending = bsc_appchan::pending(&chan)?;
    bsc_cli_util::emit(args.pretty, args.json, &pending, || {
        if pending.is_empty() {
            "no pending requests".to_string()
        } else {
            pending.iter().map(|e| format!("{}  {}  at={}", e.id, e.kind, e.at)).collect::<Vec<_>>().join("\n")
        }
    });
    Ok(())
}

fn cmd_sweep(args: &Args) -> Result<(), String> {
    let chan = bsc_appchan::chan_dir()?;
    let n = bsc_appchan::sweep_stale(&chan, bsc_util::now_ms(), args.max_age_ms.unwrap_or(STALE_MS))?;
    bsc_cli_util::emit(args.pretty, args.json, &serde_json::json!({ "removed": n }), || {
        format!("removed {n} stale file(s)")
    });
    Ok(())
}

fn cmd_dir(args: &Args) -> Result<(), String> {
    let shots = shots_dir()?;
    let chan = bsc_appchan::chan_dir()?;
    let v = serde_json::json!({ "shots": shots.display().to_string(), "channel": chan.display().to_string() });
    bsc_cli_util::emit(args.pretty, args.json, &v, || {
        format!("shots:   {}\nchannel: {}", shots.display(), chan.display())
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_rect() {
        assert_eq!(parse_rect("1,2,3,4").unwrap(), Rect { x: 1, y: 2, w: 3, h: 4 });
        assert_eq!(parse_rect(" 10 , 20 , 30 , 40 ").unwrap(), Rect { x: 10, y: 20, w: 30, h: 40 });
    }

    #[test]
    fn rejects_a_rect_the_app_could_only_fail_on() {
        // Caught here so the caller learns WHAT was wrong; the app could only say "capture failed".
        assert!(parse_rect("1,2,3").is_err(), "needs 4 parts");
        assert!(parse_rect("1,2,3,4,5").is_err());
        assert!(parse_rect("a,2,3,4").is_err(), "non-numeric");
        assert!(parse_rect("-1,2,3,4").is_err(), "negative");
        assert!(parse_rect("1,2,0,4").is_err(), "zero width has no pixels");
        assert!(parse_rect("1,2,3,0").is_err(), "zero height has no pixels");
    }

    #[test]
    fn unknown_flags_are_rejected_rather_than_ignored() {
        assert!(parse_args(vec!["take".into(), "--nope".into()]).is_err());
    }

    #[test]
    fn flags_parse_off_the_positional() {
        let a = parse_args(vec![
            "take".into(),
            "--rect".into(),
            "1,2,3,4".into(),
            "--out".into(),
            "x.png".into(),
            "--timeout".into(),
            "50".into(),
            "--json".into(),
        ])
        .unwrap();
        assert_eq!(a.positional, vec!["take"]);
        assert_eq!(a.rect, Some(Rect { x: 1, y: 2, w: 3, h: 4 }));
        assert_eq!(a.out.as_deref(), Some("x.png"));
        assert_eq!(a.timeout_ms, Some(50));
        assert!(a.json);
    }
}
