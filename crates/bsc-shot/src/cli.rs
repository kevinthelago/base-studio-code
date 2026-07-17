//! The `bsc shot` subcommand (#3261, epic #3260) — ask the RUNNING app for a webview snapshot and print
//! the PNG path, so an external session can SEE the app rather than infer what it looks like.
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc shot help          # compact menu
//!   bsc shot take help     # detailed help for ONE command
//!
//! The channel is a directory both sides watch (`~/.base-studio-code/shots/`, or `BSC_SHOT_DIR`) — see
//! the crate docs for why it is a file channel and not an IPC call.

use crate::{
    is_png, new_id, pending_requests, read_response, shots_dir, sweep_stale, write_request, Rect, ShotRequest,
};
use bsc_cli_util::CmdDoc;
use std::path::PathBuf;

const TAGLINE: &str = "capture the RUNNING app's real pixels — a webview snapshot (#3261)";

/// How long a `take` waits for the app before giving up. The app answers in well under a second when
/// it is running; this bound exists so a request made with NO app running fails fast and clearly
/// instead of hanging a loop iteration forever.
const DEFAULT_TIMEOUT_MS: i64 = 8_000;

/// How often the poll loop re-reads the response file.
const POLL_INTERVAL_MS: u64 = 40;

/// Requests older than this are swept on each `take` — an abandoned CLI (Ctrl-C'd mid-poll) or one made
/// while no app was running must not accumulate, nor be re-served later to nobody.
const STALE_MS: i64 = 60_000;

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "take",
        summary: "capture the app's webview; prints the PNG path",
        usage: "\
USAGE:
  bsc shot take [--rect x,y,w,h] [--out <path>] [--timeout <ms>] [--json|--pretty]

Asks the RUNNING desktop app to snapshot its webview and writes a PNG. Prints the path (--json emits
{ path, w, h, at }).

  --rect x,y,w,h   crop to a region, in CSS pixels from the webview's top-left. Omit for the whole
                   webview. The frontend knows a preview iframe's getBoundingClientRect(), so
                   'just the component' is a crop, not a second capture path.
  --out <path>     where to write the PNG. Default: <shots dir>/<id>.png
  --timeout <ms>   how long to wait for the app (default 8000). The app answers in well under a
                   second; this bound is so a request with NO app running fails fast instead of
                   hanging.

WHAT IT CAPTURES
  The webview's COMPOSITED output — pixel-identical to what you see, including the sandboxed preview
  iframe, and a render rather than a screen grab. So it is immune to occlusion, minimize and screen
  lock: the overnight case (#3260) does not silently produce black frames.

REQUIRES THE APP RUNNING
  `bsc` cannot call the app (the bridge only runs app→bsc), so this drops a request in the shots dir
  and waits for the app's watcher to answer. No app ⇒ a clear timeout error, never a hang.",
    },
    CmdDoc {
        name: "pending",
        summary: "unanswered capture requests (JSON) — what the app's watcher would serve",
        usage: "\
USAGE:
  bsc shot pending [--json|--pretty]

Every request with no response beside it, oldest first. Diagnostic: if `take` times out, this shows
whether the request landed (⇒ the app/watcher is not running) or never got written.",
    },
    CmdDoc {
        name: "sweep",
        summary: "drop aged request/response files (never the PNGs)",
        usage: "\
USAGE:
  bsc shot sweep [--max-age <ms>] [--json]

Removes request/response files older than --max-age (default 60000). PNGs are never swept — the
caller owns those. `take` sweeps automatically; this is the manual escape hatch.",
    },
    CmdDoc {
        name: "dir",
        summary: "the shots directory path",
        usage: "\
USAGE:
  bsc shot dir

Prints the channel directory (BSC_SHOT_DIR, else ~/.base-studio-code/shots).",
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
            "--rect" => {
                let v = it.next().ok_or("--rect needs x,y,w,h")?;
                a.rect = Some(parse_rect(&v)?);
            }
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
/// the caller exactly what was wrong, the app can only say "capture failed".
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
        "dir" => {
            println!("{}", shots_dir()?.display());
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn cmd_take(args: &Args) -> Result<(), String> {
    let dir = shots_dir()?;
    let now = bsc_util::now_ms();

    // Best-effort: a sweep failure must not block a capture.
    let _ = sweep_stale(&dir, now, STALE_MS);

    let id = new_id(now);
    let req = ShotRequest {
        id: id.clone(),
        rect: args.rect,
        out: args.out.clone(),
        at: now,
    };
    write_request(&dir, &req)?;

    let timeout = args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let res = poll_response(&dir, &id, timeout)?;

    if let Some(err) = res.error {
        return Err(format!("capture failed: {err}"));
    }
    let path = res.path.ok_or("the app answered with neither a path nor an error")?;

    // Prove the app wrote a real image. A capture that silently produced nothing (or something that is
    // not a PNG) must not report success — that is the failure this whole surface exists to avoid.
    let bytes = std::fs::read(&path).map_err(|e| format!("the app reported {path} but it cannot be read: {e}"))?;
    if !is_png(&bytes) {
        return Err(format!("the app wrote {path} but it is not a PNG ({} bytes)", bytes.len()));
    }

    let out = serde_json::json!({ "path": path, "w": res.w, "h": res.h, "at": res.at });
    bsc_cli_util::emit(args.pretty, args.json, &out, || path.clone());
    Ok(())
}

/// Block until the app answers `id`, or `timeout_ms` elapses.
fn poll_response(dir: &std::path::Path, id: &str, timeout_ms: i64) -> Result<crate::ShotResponse, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.max(0) as u64);
    loop {
        if let Some(res) = read_response(dir, id)? {
            return Ok(res);
        }
        if std::time::Instant::now() >= deadline {
            let req = crate::request_path(dir, id);
            return Err(format!(
                "timed out after {timeout_ms}ms waiting for the app to answer.\n\
                 The request is at {}.\n\
                 Is the desktop app running? `bsc` cannot capture on its own — the app's watcher does the \
                 snapshot. `bsc shot pending` shows whether the request landed.",
                req.display()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
    }
}

fn cmd_pending(args: &Args) -> Result<(), String> {
    let dir = shots_dir()?;
    let pending = pending_requests(&dir)?;
    bsc_cli_util::emit(args.pretty, args.json, &pending, || {
        if pending.is_empty() {
            "no pending capture requests".to_string()
        } else {
            pending.iter().map(|r| format!("{}  at={}", r.id, r.at)).collect::<Vec<_>>().join("\n")
        }
    });
    Ok(())
}

fn cmd_sweep(args: &Args) -> Result<(), String> {
    let dir = shots_dir()?;
    let n = sweep_stale(&dir, bsc_util::now_ms(), args.max_age_ms.unwrap_or(STALE_MS))?;
    bsc_cli_util::emit(args.pretty, args.json, &serde_json::json!({ "removed": n }), || {
        format!("removed {n} stale file(s)")
    });
    Ok(())
}

/// The default PNG destination for a request that carried no `--out` — the app resolves it the same way.
pub fn resolve_out(dir: &std::path::Path, req: &ShotRequest) -> PathBuf {
    req.out.as_ref().map(PathBuf::from).unwrap_or_else(|| crate::default_png_path(dir, &req.id))
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
    fn resolve_out_prefers_the_explicit_path_else_the_default() {
        let dir = std::path::Path::new("/shots");
        let mut req = ShotRequest { id: "a".into(), rect: None, out: None, at: 0 };
        assert_eq!(resolve_out(dir, &req), crate::default_png_path(dir, "a"));
        req.out = Some("/tmp/x.png".into());
        assert_eq!(resolve_out(dir, &req), PathBuf::from("/tmp/x.png"));
    }

    #[test]
    fn take_times_out_with_an_actionable_message_when_no_app_answers() {
        // The overnight failure mode: nobody is listening. It must fail FAST and say why, not hang.
        let dir = tempfile::tempdir().unwrap();
        let err = poll_response(dir.path(), "nobody", 30).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(err.contains("Is the desktop app running?"), "must name the likely cause: {err}");
    }

    #[test]
    fn poll_returns_the_response_as_soon_as_it_appears() {
        let dir = tempfile::tempdir().unwrap();
        crate::write_response(dir.path(), &crate::ShotResponse::ok("a", "p.png", 10, 20, 1)).unwrap();
        let got = poll_response(dir.path(), "a", 1_000).unwrap();
        assert_eq!(got.w, Some(10));
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
