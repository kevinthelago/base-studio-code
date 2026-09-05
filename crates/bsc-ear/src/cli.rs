//! `bsc ear` — the verbs.

use crate::capture::{self, CaptureConfig};
use crate::retention::{self, Budget};
use crate::segment::VadConfig;
use bsc_cli_util::{args, CmdDoc};
use serde_json::json;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const TAGLINE: &str = "always-on local capture: speech-only segments, inside a bound it enforces";

/// A heartbeat older than this means the daemon is gone, whatever the pid file says.
const STALE_AFTER: Duration = Duration::from_secs(20);

pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "devices",
        summary: "what can capture on this machine, and which one is the default",
        usage: "\
bsc ear devices [--all] [--json|--pretty]

Lists the capture devices worth choosing between with its channel count and native rate, marking the system default.

A DEVICE THAT CANNOT REPORT A CONFIG IS STILL LISTED, with zeroes, rather than dropped — an input
missing from the list is indistinguishable from an input that is not plugged in.",
    },
    CmdDoc {
        name: "start",
        summary: "begin listening in the background",
        usage: "\
bsc ear start [--device <name>] [--window <minutes>] [--dir <path>]

Detaches and listens until `bsc ear stop`. Output goes to the log beside the audio.

IT IS ALWAYS-ON BY DESIGN, which is the whole point of the feature and also the reason the retention
bound is a function rather than a promise: --window (default 120 minutes) is enforced after every
segment, oldest first, and never against the segment being written.

WHAT IS ON DISK IS AUDIO OF YOUR ROOM. It lives under ~/.base-studio-code/ear and nothing in this
command sends it anywhere.",
    },
    CmdDoc {
        name: "stop",
        summary: "stop listening, and confirm it actually stopped",
        usage: "\
bsc ear stop [--dir <path>]

Asks the daemon to stop and WAITS to see it go, rather than assuming. If it does not stop, that is
reported as a failure — for a microphone, 'probably off' is not an acceptable answer.",
    },
    CmdDoc {
        name: "status",
        summary: "listening or not, since when, and how much audio is held",
        usage: "\
bsc ear status [--dir <path>] [--json|--pretty]

Reports the daemon's state, the segment count, the bytes held and how far back they reach.

LIVENESS IS A HEARTBEAT, NOT A PID. A pid file outlives a crash, and a pid can be reused by an
unrelated process; either way the answer would be a confident 'listening' about a microphone that is
off. The daemon touches a heartbeat every few seconds and anything older than 20s reads as stopped.",
    },
    CmdDoc {
        name: "listen",
        summary: "listen in the foreground, printing every boundary as it happens",
        usage: "\
bsc ear listen [--device <name>] [--window <minutes>] [--dir <path>]

The same capture as `start`, in your terminal, printing the noise floor once it has learned the room
and a line per segment. This is how you check a threshold against a real microphone.

IT IS DEAF FOR THE FIRST SECOND, deliberately. A detector that can trigger before it knows how loud
the room is will trigger on the room.",
    },
    CmdDoc {
        name: "levels",
        summary: "which devices actually HEAR anything — the one that tells a dead input from a quiet room",
        usage: "\
bsc ear levels [--all] [--json|--pretty]

Listens to each capture device for a moment and reports its RMS.

IT EXISTS BECAUSE ENUMERATION LIES BY OMISSION. Measured on this machine: the SYSTEM DEFAULT
delivers silence, as do the USB interface and the headset, while only the onboard input is live.
Nothing in `bsc ear devices` distinguishes those — so an ear started on the default would report
LISTENING and hear nothing, forever, looking exactly like a quiet room.

'silent' means no signal at all. A real microphone in a silent room still has self-noise; the live
input here reads 0.00235 against 0.00002 for the dead ones, which is the gap the verdict uses.",
    },
    CmdDoc {
        name: "segments",
        summary: "the audio currently held, newest first",
        usage: "\
bsc ear segments [--dir <path>] [--json|--pretty]

What is on disk right now: name, size and age. This is the whole of what the ear remembers — there
is no second copy, and anything past the window is already gone.",
    },
];

#[derive(Default, Debug)]
struct Args {
    all: bool,
    json: bool,
    pretty: bool,
    device: Option<String>,
    dir: Option<String>,
    window_min: Option<u64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let (mut a, positional) = args::walk(raw, Args::default(), |flag, a: &mut Args, rest| {
        match flag {
            "--all" => a.all = true,
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--device" => a.device = Some(rest.value("--device needs a device name")?),
            "--dir" => a.dir = Some(rest.value("--dir needs a path")?),
            "--window" => {
                a.window_min = Some(
                    rest.value("--window needs a whole number of minutes")?
                        .parse()
                        .map_err(|_| "--window needs a whole number of minutes".to_string())?,
                );
            }
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

// ── Paths ─────────────────────────────────────────────────────────────────────────────────────────

struct Paths {
    root: PathBuf,
}

impl Paths {
    fn resolve(dir: Option<&str>) -> Result<Paths, String> {
        let root = match dir {
            Some(d) => PathBuf::from(d),
            None => bsc_util::bsc_base_dir()
                .ok_or("no home directory, so ~/.base-studio-code could not be resolved")?
                .join("ear"),
        };
        Ok(Paths { root })
    }
    fn audio(&self) -> PathBuf {
        self.root.join("audio")
    }
    fn pid(&self) -> PathBuf {
        self.root.join("ear.pid")
    }
    fn beat(&self) -> PathBuf {
        self.root.join("ear.alive")
    }
    fn stop(&self) -> PathBuf {
        self.root.join("ear.stop")
    }
    fn state(&self) -> PathBuf {
        self.root.join("ear.state")
    }
    fn log(&self) -> PathBuf {
        self.root.join("ear.log")
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Is a daemon actually listening?
///
/// Answered from the HEARTBEAT, never from the pid. A pid file outlives a crash, and a pid can be
/// reused by an unrelated process — either mistake produces a confident "listening" about a
/// microphone that is off, which is the one wrong answer this command must never give.
fn heartbeat_age_ms(p: &Paths) -> Option<i64> {
    let raw = std::fs::read_to_string(p.beat()).ok()?;
    let beat: i64 = raw.trim().parse().ok()?;
    Some(now_ms().saturating_sub(beat))
}

fn is_listening(p: &Paths) -> bool {
    heartbeat_age_ms(p).map(|age| age < STALE_AFTER.as_millis() as i64).unwrap_or(false)
}

fn budget(window_min: Option<u64>) -> Budget {
    match window_min {
        Some(m) => {
            let secs = m.saturating_mul(60);
            Budget {
                max_age_ms: (secs as i64).saturating_mul(1000),
                // Headroom over the duration so TIME is what binds an ordinary window.
                max_bytes: retention::bytes_for_seconds(secs).saturating_add(retention::bytes_for_seconds(secs) / 8),
            }
        }
        None => Budget::default(),
    }
}

fn capture_config(a: &Args, p: &Paths, heartbeat: bool) -> CaptureConfig {
    CaptureConfig {
        device: a.device.clone(),
        vad: VadConfig::default(),
        budget: budget(a.window_min),
        dir: p.audio(),
        heartbeat: heartbeat.then(|| p.beat()),
        state: heartbeat.then(|| p.state()),
    }
}

// ── Verbs ─────────────────────────────────────────────────────────────────────────────────────────

fn print_json<T: serde::Serialize>(v: &T, pretty: bool) -> Result<(), String> {
    let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
    println!("{}", s.map_err(|e| format!("could not render: {e}"))?);
    Ok(())
}

fn cmd_devices(a: &Args) -> Result<(), String> {
    let all = capture::list_devices()?;
    let total = all.len();
    // Filtered by default: ALSA presents the same four inputs 27 ways, and a list where one row in
    // seven is the answer is a list nobody reads. `--all` is the escape hatch, not the default.
    let devices: Vec<_> = if a.all {
        all
    } else {
        all.into_iter().filter(|d| crate::audio::is_primary_device(&d.name)).collect()
    };
    // A filter that matched nothing would read as "no microphone", so fall back rather than lie.
    let (devices, filtered) = if devices.is_empty() && !a.all {
        (capture::list_devices()?, false)
    } else {
        (devices, !a.all)
    };
    if a.json || a.pretty {
        return print_json(&devices, a.pretty);
    }
    if devices.is_empty() {
        println!("no capture devices — nothing on this machine can listen");
        return Ok(());
    }
    for d in &devices {
        let mark = if d.default { "*" } else { " " };
        println!("{mark} {:<44} {}ch @ {}Hz", d.name, d.channels, d.sample_rate);
    }
    println!("\n* = system default (used when --device is not given)");
    if filtered && total > devices.len() {
        println!("{} routing variant(s) of the same hardware hidden — `--all` shows them", total - devices.len());
    }
    Ok(())
}

fn cmd_listen(a: &Args, p: &Paths, heartbeat: bool) -> Result<(), String> {
    std::fs::create_dir_all(&p.root).map_err(|e| format!("could not create {}: {e}", p.root.display()))?;
    let _ = std::fs::remove_file(p.stop());
    let stop_path = p.stop();
    let stop = move || stop_path.exists();
    let mut emit = |line: String| println!("{line}");
    let progress = capture::run(&capture_config(a, p, heartbeat), &stop, &mut emit);
    let _ = std::fs::remove_file(p.beat());
    let _ = std::fs::remove_file(p.pid());
    let _ = std::fs::remove_file(p.stop());
    let progress = progress?;
    println!(
        "stopped — {} segment(s) kept, {} discarded, {} evicted",
        progress.kept, progress.discarded, progress.evicted
    );
    Ok(())
}

fn cmd_start(a: &Args, p: &Paths) -> Result<(), String> {
    if is_listening(p) {
        return Err("already listening — `bsc ear status` says since when, `bsc ear stop` ends it".into());
    }
    std::fs::create_dir_all(&p.root).map_err(|e| format!("could not create {}: {e}", p.root.display()))?;
    let _ = std::fs::remove_file(p.stop());
    let exe = std::env::current_exe().map_err(|e| format!("could not find my own binary: {e}"))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p.log())
        .map_err(|e| format!("could not open {}: {e}", p.log().display()))?;
    let errlog = log.try_clone().map_err(|e| format!("could not open the log twice: {e}"))?;

    let mut cmd = std::process::Command::new(exe);
    cmd.arg("ear").arg("listen").arg("--dir").arg(&p.root);
    if let Some(d) = &a.device {
        cmd.arg("--device").arg(d);
    }
    if let Some(w) = a.window_min {
        cmd.arg("--window").arg(w.to_string());
    }
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(errlog))
        .spawn()
        .map_err(|e| format!("could not start the listener: {e}"))?;
    std::fs::write(p.pid(), child.id().to_string())
        .map_err(|e| format!("could not write {}: {e}", p.pid().display()))?;

    // WAIT FOR THE FIRST HEARTBEAT rather than reporting success on a spawn. A device that is busy
    // or absent fails inside the child, and a `start` that printed "listening" and returned would
    // be claiming a microphone is on when it never opened.
    for _ in 0..60 {
        if is_listening(p) {
            println!("listening (pid {}) — log: {}", child.id(), p.log().display());
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = std::fs::write(p.stop(), "1");
    Err(format!(
        "the listener started but never reported in — see {} for what it said",
        p.log().display()
    ))
}

fn cmd_stop(p: &Paths) -> Result<(), String> {
    if !is_listening(p) {
        println!("not listening");
        let _ = std::fs::remove_file(p.pid());
        return Ok(());
    }
    std::fs::write(p.stop(), "1").map_err(|e| format!("could not signal a stop: {e}"))?;
    // WAIT AND CONFIRM. For a microphone, "probably off" is not an acceptable answer.
    for _ in 0..40 {
        if !is_listening(p) {
            println!("stopped");
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "asked it to stop and it is STILL reporting a heartbeat — the microphone may still be open. \
         Its pid is in {}",
        p.pid().display()
    ))
}

fn cmd_status(a: &Args, p: &Paths) -> Result<(), String> {
    let held = capture::held_segments(&p.audio());
    let bytes: u64 = held.iter().map(|s| s.bytes).sum();
    let oldest = held.iter().map(|s| s.started_unix_ms).min();
    let listening = is_listening(p);
    let age = heartbeat_age_ms(p);

    if a.json || a.pretty {
        return print_json(
            &json!({
                "listening": listening,
                "heartbeatAgeMs": age,
                "segments": held.len(),
                "bytes": bytes,
                "oldestUnixMs": oldest,
                "dir": p.audio().display().to_string(),
            }),
            a.pretty,
        );
    }
    let live: Option<capture::LiveState> = std::fs::read_to_string(p.state())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    println!("state       {}", if listening { "LISTENING" } else { "not listening" });
    if listening {
        if let Some(l) = &live {
            println!("device      {}", l.device);
            println!("input       floor {:.5}{}", l.noise_floor, if l.warming { " (still learning the room)" } else { "" });
        }
    }
    if let Some(age) = age {
        println!("heartbeat   {}s ago", age / 1000);
    }
    println!("segments    {} ({:.1} MB)", held.len(), bytes as f64 / (1024.0 * 1024.0));
    match oldest {
        Some(o) => println!("reaches     {} minutes back", (now_ms() - o) / 60_000),
        None => println!("reaches     nothing held"),
    }
    println!("dir         {}", p.audio().display());
    // The failure this exists to prevent: an ear pointed at a device that delivers silence reports
    // LISTENING forever and records nothing, which is exactly what a quiet room looks like.
    if listening && live.as_ref().map(|l| l.input_dead).unwrap_or(false) {
        println!(
            "\nWARNING: this input is delivering digital silence — muted, unplugged, or routed to\n\
             nothing. It is not a quiet room. `bsc ear levels` shows which device actually hears,\n\
             then restart with --device <name>."
        );
    }
    Ok(())
}

fn cmd_levels(a: &Args) -> Result<(), String> {
    // Names first, from one cheap enumeration; then probe each on its own. Hardware before routed,
    // because probing a routed node takes the hardware with it — see `audio::probe_order`.
    let mut names: Vec<String> = capture::list_devices()?
        .into_iter()
        .filter(|d| a.all || crate::audio::is_primary_device(&d.name))
        .map(|d| d.name)
        .collect();
    names.sort_by(|x, y| crate::audio::probe_order(x, y));
    let rows: Vec<(String, Option<f32>, String)> = names
        .into_iter()
        .map(|n| match capture::probe_level(Some(&n), 600) {
            Ok((_, rms)) => (n, Some(rms), String::new()),
            Err(e) => (n, None, e),
        })
        .collect();
    if a.json || a.pretty {
        let v: Vec<_> = rows
            .iter()
            .map(|(n, l, e)| json!({ "device": n, "rms": l, "alive": l.map(|r| r > 2e-4), "error": e }))
            .collect();
        return print_json(&v, a.pretty);
    }
    for (n, l, e) in &rows {
        match l {
            // The threshold is measured, not guessed: this machine's live onboard input sits at
            // 0.00235 in a silent room while three dead devices sit at 0.00002-0.00008.
            Some(r) if *r > 2e-4 => println!("  {n:<30} rms {r:.5}   ALIVE"),
            Some(r) => println!("  {n:<30} rms {r:.5}   silent"),
            None => println!("  {n:<30} {}", e),
        }
    }
    println!(
        "\n'silent' means the device delivered no signal at all — a real microphone in a quiet room\nstill has self-noise. Point the ear at an ALIVE one with `bsc ear start --device <name>`."
    );
    Ok(())
}

fn cmd_segments(a: &Args, p: &Paths) -> Result<(), String> {
    let mut held = capture::held_segments(&p.audio());
    held.sort_by_key(|s| std::cmp::Reverse(s.started_unix_ms));
    if a.json || a.pretty {
        return print_json(&held, a.pretty);
    }
    if held.is_empty() {
        println!("nothing held");
        return Ok(());
    }
    for s in &held {
        println!(
            "{:<28} {:>8.1} KB   {:>4} min ago",
            s.name,
            s.bytes as f64 / 1024.0,
            (now_ms() - s.started_unix_ms) / 60_000
        );
    }
    Ok(())
}

pub fn run(argv: Vec<String>, prog: &str) -> Result<(), String> {
    let a = parse_args(argv)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &a.positional) {
        return Ok(());
    }
    let p = Paths::resolve(a.dir.as_deref())?;
    match a.positional.first().map(String::as_str) {
        Some("devices") => cmd_devices(&a),
        Some("start") => cmd_start(&a, &p),
        Some("stop") => cmd_stop(&p),
        Some("status") => cmd_status(&a, &p),
        Some("listen") => cmd_listen(&a, &p, true),
        Some("levels") => cmd_levels(&a),
        Some("segments") => cmd_segments(&a, &p),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other.unwrap_or(""))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_is_documented_so_a_verb_cannot_be_added_silently() {
        for c in COMMANDS {
            assert!(!c.summary.is_empty(), "{} has no summary", c.name);
            assert!(c.usage.contains(c.name), "{}'s usage does not name it", c.name);
        }
        let names: Vec<_> = COMMANDS.iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["devices", "start", "stop", "status", "listen", "levels", "segments"]);
    }

    #[test]
    fn help_renders_and_an_unknown_verb_is_refused() {
        assert!(run(vec!["help".into()], "bsc ear").is_ok());
        let e = run(vec!["nope".into()], "bsc ear").unwrap_err();
        assert!(e.contains("nope"), "the error should name what was typed: {e}");
    }

    #[test]
    fn a_window_in_minutes_becomes_a_budget_that_time_binds() {
        let b = budget(Some(30));
        assert_eq!(b.max_age_ms, 30 * 60 * 1000);
        let needed = retention::bytes_for_seconds(30 * 60);
        assert!(b.max_bytes > needed, "the byte ceiling must not cut a 30-minute window short");
        assert!(b.max_bytes < needed * 2, "but must still bound a runaway");
        assert_eq!(budget(None), Budget::default());
    }

    #[test]
    fn a_bad_window_is_refused_with_the_unit_named() {
        let e = parse_args(vec!["start".into(), "--window".into(), "ages".into()]).unwrap_err();
        assert!(e.contains("minutes"), "{e}");
    }

    /// A pid file outlives a crash and a pid can be reused, so liveness is the heartbeat. Anything
    /// else risks a confident "listening" about a microphone that is off.
    #[test]
    fn liveness_comes_from_a_fresh_heartbeat_and_a_stale_one_reads_as_stopped() {
        let root = std::env::temp_dir().join(format!("bsc-ear-t-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let p = Paths { root: root.clone() };

        assert!(!is_listening(&p), "no heartbeat at all is not listening");

        std::fs::write(p.beat(), now_ms().to_string()).unwrap();
        assert!(is_listening(&p), "a fresh heartbeat is");

        let stale = now_ms() - STALE_AFTER.as_millis() as i64 - 1_000;
        std::fs::write(p.beat(), stale.to_string()).unwrap();
        assert!(!is_listening(&p), "a stale one is NOT, whatever the pid file says");

        std::fs::write(p.pid(), "424242").unwrap();
        assert!(!is_listening(&p), "and a pid file alone must never say listening");

        std::fs::write(p.beat(), "not a number").unwrap();
        assert!(!is_listening(&p), "an unreadable heartbeat reads as stopped, never as running");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_store_lives_under_the_base_dir_and_is_overridable_for_a_test() {
        let p = Paths::resolve(Some("/tmp/somewhere")).unwrap();
        assert_eq!(p.audio(), PathBuf::from("/tmp/somewhere/audio"));
        let d = Paths::resolve(None).unwrap();
        assert!(d.root.ends_with("ear"), "{:?}", d.root);
        assert!(d.root.to_string_lossy().contains(".base-studio-code"), "{:?}", d.root);
    }

    #[test]
    fn stopping_something_that_is_not_running_is_not_an_error() {
        let root = std::env::temp_dir().join(format!("bsc-ear-s-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let p = Paths { root: root.clone() };
        assert!(cmd_stop(&p).is_ok(), "stop must be idempotent");
        std::fs::remove_dir_all(&root).ok();
    }
}
