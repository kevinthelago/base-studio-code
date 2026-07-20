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

/// Default gap between burst frames (`--frames`). Each frame ALSO round-trips the channel, so the real
/// gap is `max(this, the round-trip)` — a few frames across an animation, not a high-fps video.
const DEFAULT_INTERVAL_MS: i64 = 120;
/// Runaway guard on `--frames` — a burst is "a few frames across an animation", not a screen recording.
const MAX_FRAMES: i64 = 120;

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "take",
        summary: "capture the app's webview; prints the PNG path",
        usage: "\
USAGE:
  bsc shot take [--rect x,y,w,h] [--out <path>] [--frames <N>] [--interval <ms>] [--timeout <ms>] [--json|--pretty]

Asks the RUNNING desktop app to snapshot its webview and writes a PNG. Prints the path (--json emits
{ path, w, h }; a burst emits { frames: [ … ] }).

  --rect x,y,w,h   crop to a region, in CSS pixels from the webview's top-left. Omit for the whole
                   webview. The frontend knows a preview iframe's getBoundingClientRect(), so
                   'just the component' is a crop, not a second capture path.
  --out <path>     where to write the PNG. Default: <shots dir>/<id>.png. With --frames, this is the
                   BASE: <base>-01.<ext>, <base>-02.<ext>, …
  --frames <N>     capture a BURST of N frames (default 1) — for ANIMATIONS, where one frame can't show
                   motion. Prints N paths, oldest first.
  --interval <ms>  gap between burst frames (default 120). See TIMING below.
  --timeout <ms>   how long to wait for the app, per frame (default 8000).

WHAT IT CAPTURES
  The webview's COMPOSITED output — pixel-identical to what you see, including the sandboxed preview
  iframe, and a render rather than a screen grab. Verified: a capture taken while the window was
  MINIMIZED is byte-identical to a visible one, so the overnight case (#3260) cannot silently produce
  black frames.

BURST CAPTURE (--frames)
  Frames land as a numbered set — <base>-01.png, <base>-02.png, … from --out if given, else
  <shots>/<id>-NN.png sharing one burst id. If the app stops mid-burst, the frames already captured
  STAY on disk and the error says how many landed (a partial burst is still useful).

TIMING
  Each frame round-trips the file channel (write request → the app's watcher → snapshot → reply), so
  the REAL gap between frames is max(--interval, that round-trip). High fps isn't reachable this way,
  but 'a few frames across an animation' is — enough to GROUND a motion change, not to record video.

REQUIRES THE APP RUNNING
  `bsc` cannot call the app (the bridge only runs app→bsc), so this drops a request in the channel dir
  and waits for the app's watcher. No app ⇒ a clear timeout error, never a hang.

PAIR IT WITH NAVIGATE
  A shot captures whatever is on screen. To target something, steer first:
    bsc navigate component <kit> <component> && bsc shot take",
    },
    CmdDoc {
        name: "preview",
        summary: "capture JUST the Design Studio's component preview (auto-cropped)",
        usage: "\
USAGE:
  bsc shot preview [--frames <N>] [--interval <ms>] [--out <path>] [--timeout <ms>] [--json|--pretty]

Captures JUST the component preview — the app resolves the Design Studio's preview element's rect
ITSELF and crops to it, so you don't pass coordinates. This is the DESIGNER's ground truth: the
component, not the whole app chrome.

  --frames <N>     a BURST of N frames (for animations) — same as `take` (see `bsc shot take help`).
  --interval <ms>  gap between burst frames (default 120).
  --out <path>     where to write the PNG (base for a burst). Default <shots>/<id>.png.
  --timeout <ms>   how long to wait for the app, per frame (default 8000).

STEER FIRST
  The preview shows the SELECTED component, so land one first:
    bsc navigate component <kit> <component> && bsc shot preview

NO COMPONENT SHOWN
  If the Design Studio isn't showing a component (no preview element registered), this errors clearly
  rather than capturing the whole screen — navigate to a component and retry.",
    },
    CmdDoc {
        name: "frame",
        summary: "capture the mounted preview of ONE named component — you choose what to look at",
        usage: "\
USAGE:
  bsc shot frame <component> [--frames <N>] [--interval <ms>] [--out <path>] [--timeout <ms>] [--json|--pretty]

Captures the preview frame rendering <component>, wherever it sits on screen. Where `preview` shoots
whatever the Studio happens to be showing, `frame` names the SUBJECT — so a session chooses what to
photograph instead of depending on what the user last clicked.

The app resolves the rect itself from the mounted previews (the same geometry `bsc debug frames`
reports), so you never pass coordinates — and you do not need `bsc debug` in your own command surface.

  --frames <N>     a BURST of N frames (for animations) — see `bsc shot take help`.
  --interval <ms>  gap between burst frames (default 120).
  --out <path>     where to write the PNG (base for a burst). Default <shots>/<id>.png.
  --timeout <ms>   how long to wait for the app, per frame (default 8000).

NOT MOUNTED
  If no preview for <component> is mounted, this errors and NAMES what is currently showing, rather
  than silently capturing the whole screen. Land it first:
    bsc navigate component <kit> <component>",
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
    frames: Option<i64>,
    interval_ms: Option<i64>,
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
            "--frames" => {
                let v = it.next().ok_or("--frames needs a count")?;
                a.frames = Some(v.parse().map_err(|_| format!("--frames: not a number: {v}"))?);
            }
            "--interval" => {
                let v = it.next().ok_or("--interval needs a value in ms")?;
                a.interval_ms = Some(v.parse().map_err(|_| format!("--interval: not a number: {v}"))?);
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
        "preview" => cmd_preview(&args),
        "frame" => cmd_frame(&args),
        "pending" => cmd_pending(&args),
        "sweep" => cmd_sweep(&args),
        "dir" => cmd_dir(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// `bsc shot take` — capture the whole webview (or an explicit `--rect`), full-screen. The full-cap
/// surface (the debug session); the designer is restricted to `preview` (#3308).
fn cmd_take(args: &Args) -> Result<(), String> {
    run_capture(args, None)
}

/// `bsc shot preview` — capture JUST the Design Studio's component preview: the app resolves the "preview"
/// target's rect itself (#3308). `--rect` is meaningless here (the target IS the region), so reject it
/// rather than silently ignore. This is the designer's only shot verb.
fn cmd_preview(args: &Args) -> Result<(), String> {
    if args.rect.is_some() {
        return Err("`bsc shot preview` crops to the component preview itself — drop --rect (use `bsc shot take --rect` for a manual region)".into());
    }
    run_capture(args, Some("preview"))
}

/// The `frame:` target prefix the app routes to a mounted preview by component id (#3469). Kept here
/// beside the verb that mints it so the CLI and the app agree on one spelling.
const FRAME_PREFIX: &str = "frame:";

/// `bsc shot frame <component>` — capture the mounted preview of ONE named component (#3469).
///
/// Where `preview` shoots whatever the Studio is showing, this names the SUBJECT: the app resolves the
/// rect from its mounted previews, so a session chooses what to photograph rather than depending on
/// what the user last clicked. Like `preview`, `--rect` is meaningless (the frame IS the region) and is
/// rejected rather than silently ignored.
fn cmd_frame(args: &Args) -> Result<(), String> {
    if args.rect.is_some() {
        return Err("`bsc shot frame` crops to the named component's preview — drop --rect (use `bsc shot take --rect` for a manual region)".into());
    }
    let component = args.positional.get(1).map(String::as_str).unwrap_or_default();
    if component.is_empty() {
        return Err("`bsc shot frame` needs a component: `bsc shot frame <component>` (see `bsc shot frame help`)".into());
    }
    run_capture(args, Some(&format!("{FRAME_PREFIX}{component}")))
}

/// The shared capture path for `take`/`preview`: one frame, or a `--frames` burst. `target` is `None` for
/// the whole webview (`take`) or `Some("preview")` for the app-resolved component-preview crop.
fn run_capture(args: &Args, target: Option<&str>) -> Result<(), String> {
    let chan = bsc_appchan::chan_dir()?;
    let now = bsc_util::now_ms();
    let _ = bsc_appchan::sweep_stale(&chan, now, STALE_MS); // best-effort: never block a capture

    let frames = args.frames.unwrap_or(1);
    if !(1..=MAX_FRAMES).contains(&frames) {
        return Err(format!("--frames must be between 1 and {MAX_FRAMES}, got {frames}"));
    }
    let timeout = args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);

    // Single frame: the original behavior + output (a bare path, or { path, w, h }).
    if frames == 1 {
        let id = bsc_appchan::new_id(now);
        let res = capture_one(&chan, &id, now, args.rect, args.out.clone(), target, timeout)?;
        bsc_cli_util::emit(args.pretty, args.json, &res, || res.path.clone());
        return Ok(());
    }

    // Burst: N single captures spaced by --interval. One base id ties the set together; each frame gets a
    // zero-padded -NN. Each frame round-trips the channel, so the REAL gap is max(--interval, round-trip).
    let interval = args.interval_ms.unwrap_or(DEFAULT_INTERVAL_MS).max(0) as u64;
    let base_id = bsc_appchan::new_id(now);
    let pad = frames.to_string().len().max(2);
    let shots = shots_dir()?;
    let mut results: Vec<ShotResult> = Vec::with_capacity(frames as usize);
    for i in 1..=frames {
        let n = i as usize;
        let id = format!("{base_id}-{n:0pad$}");
        let out = match args.out.as_deref() {
            Some(base) => insert_suffix(base, n, pad),
            None => shots.join(format!("{id}.png")).to_string_lossy().into_owned(),
        };
        match capture_one(&chan, &id, bsc_util::now_ms(), args.rect, Some(out), target, timeout) {
            Ok(res) => results.push(res),
            // Keep the frames already captured — a partial burst is still useful; report how many landed.
            Err(e) => {
                let done = results.iter().map(|r| r.path.as_str()).collect::<Vec<_>>().join("\n  ");
                return Err(format!(
                    "frame {i}/{frames} failed: {e}\ncaptured {} frame(s) first:\n  {done}",
                    results.len()
                ));
            }
        }
        if i < frames {
            std::thread::sleep(std::time::Duration::from_millis(interval));
        }
    }

    let plain = results.iter().map(|r| r.path.clone()).collect::<Vec<_>>().join("\n");
    let payload = serde_json::json!({ "frames": results });
    bsc_cli_util::emit(args.pretty, args.json, &payload, || plain.clone());
    Ok(())
}

/// One webview snapshot: request → wait → prove the PNG is real. Shared by the single capture and each
/// burst frame. A capture that silently produced nothing (or a non-PNG) must NOT read as success — that
/// is the failure this whole surface exists to avoid.
#[allow(clippy::too_many_arguments)]
fn capture_one(
    chan: &std::path::Path,
    id: &str,
    now: i64,
    rect: Option<Rect>,
    out: Option<String>,
    target: Option<&str>,
    timeout: i64,
) -> Result<ShotResult, String> {
    let req = ShotRequest { rect, out, target: target.map(String::from) };
    bsc_appchan::write_request(chan, id, KIND, now, &req)?;
    let reply = bsc_appchan::poll_reply(chan, id, timeout, POLL_INTERVAL_MS, || {
        format!(
            "timed out after {timeout}ms waiting for the app to answer.\n\
             The request is at {}.\n\
             Is the desktop app running? `bsc` cannot capture on its own — the app's watcher does the \
             snapshot. `bsc shot pending` shows whether the request landed.",
            bsc_appchan::request_path(chan, id).display()
        )
    })?;
    let res: ShotResult = bsc_appchan::take_payload(reply).map_err(|e| format!("capture failed: {e}"))?;
    let bytes = std::fs::read(&res.path)
        .map_err(|e| format!("the app reported {} but it cannot be read: {e}", res.path))?;
    if !is_png(&bytes) {
        return Err(format!("the app wrote {} but it is not a PNG ({} bytes)", res.path, bytes.len()));
    }
    Ok(res)
}

/// Insert a zero-padded `-NN` frame marker before `path`'s file extension, or append it when there is
/// none — so `--out anim.png` becomes `anim-01.png`, `anim-02.png`, … A dot that belongs to a parent
/// directory (`C:/a.b/out`) is NOT treated as an extension.
fn insert_suffix(path: &str, n: usize, pad: usize) -> String {
    let suffix = format!("-{n:0pad$}");
    match path.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < path.len() && !path[dot..].contains(['/', '\\']) => {
            format!("{}{}{}", &path[..dot], suffix, &path[dot..])
        }
        _ => format!("{path}{suffix}"),
    }
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

    #[test]
    fn parses_frames_and_interval() {
        let a = parse_args(vec![
            "take".into(), "--frames".into(), "6".into(), "--interval".into(), "80".into(),
        ])
        .unwrap();
        assert_eq!(a.frames, Some(6));
        assert_eq!(a.interval_ms, Some(80));
        // Absent ⇒ None; cmd_take defaults frames→1 and interval→DEFAULT_INTERVAL_MS.
        let bare = parse_args(vec!["take".into()]).unwrap();
        assert_eq!(bare.frames, None);
        assert_eq!(bare.interval_ms, None);
    }

    #[test]
    fn frames_and_interval_reject_non_numbers() {
        assert!(parse_args(vec!["take".into(), "--frames".into(), "lots".into()]).is_err());
        assert!(parse_args(vec!["take".into(), "--interval".into(), "fast".into()]).is_err());
    }

    #[test]
    fn insert_suffix_marks_the_frame() {
        // Inserted before a real extension (so the files stay sortable, and stay PNGs).
        assert_eq!(insert_suffix("anim.png", 1, 2), "anim-01.png");
        assert_eq!(insert_suffix("C:/shots/anim.png", 12, 2), "C:/shots/anim-12.png");
        // No extension ⇒ appended.
        assert_eq!(insert_suffix("anim", 3, 2), "anim-03");
        // A dot that belongs to a PARENT directory is not an extension — append, don't split the dir.
        assert_eq!(insert_suffix("C:/a.b/out", 4, 2), "C:/a.b/out-04");
        // Padding follows the requested width (the frame-count's digit count).
        assert_eq!(insert_suffix("f.png", 7, 3), "f-007.png");
    }

    #[test]
    fn preview_rejects_an_explicit_rect() {
        // `preview` crops to the component preview itself; --rect would be ambiguous, so it's a stated
        // error (returned BEFORE any channel I/O), not a silent no-op.
        let a = parse_args(vec!["preview".into(), "--rect".into(), "1,2,3,4".into()]).unwrap();
        assert!(cmd_preview(&a).is_err());
    }
}
