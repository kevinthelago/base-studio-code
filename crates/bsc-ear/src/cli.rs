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
        name: "liveness",
        summary: "tell a voice in the room from one played at the microphone — per device, never assumed",
        usage: "\
bsc ear liveness <wav>...                       # judge, against this device's calibration
bsc ear liveness calibrate --live-dir <dir> --replay-dir <dir>
bsc ear liveness show

MEASURED on 28 recordings through one mic in one room. The feature is a single band ratio,
energy(100-300Hz) over energy(20-100Hz), and the separation was total: live 3.78 to 1411, replayed
0.01 to 1.67.

THE PHYSICS DOES THE WORK. A loudspeaker ADDS cabinet and room resonance below 100Hz while
ATTENUATING the 100-300Hz fundamental, so replayed speech is bass-heavy and hollow in exactly the
band a real voice occupies. The first hypothesis was the opposite — that a close voice would have
MORE sub-bass from proximity effect — and the controlled test refuted it: replay had fifteen times
more. Measuring beat reasoning about it.

NO MODEL, DELIBERATELY. Pretrained replay detectors exist (AASIST, RawNet2, from the ASVspoof
Physical Access track). They would bring a PyTorch stack to beat a feature that already separates
without error, and they are the fallback for when this stops working rather than the starting point.

THE THRESHOLD IS PER DEVICE AND IS NEVER ASSUMED. Every number above came from one monitor and one
audio interface. A phone speaker has a different response — plausibly less sub-bass, which would push
it toward the live class and produce a confident wrong answer in exactly the case that matters most,
since a phone is the mobile-tunnel case. An uncalibrated pairing is reported as unknown.",
    },
    CmdDoc {
        name: "prosody",
        usage: "\
bsc ear prosody [<wav>...] [--dir <path>] [--json|--pretty]

Measures HOW something was said, and scores arousal against the speaker's own habit.

IT DOES NOT CLASSIFY EMOTION, deliberately. Categorical emotion models benchmark near 70% on ACTED
speech, fall apart on spontaneous speech, and emit a label nothing can argue with. Arousal — how
activated the voice is — rides on correlates that are physically measurable: pitch rises and
spreads, the voice gets louder and less even, speech speeds up, and vocal effort pushes energy
higher up the spectrum. Those are reported individually AND combined, so the score can always be
taken apart.

VALENCE IS ABSENT ON PURPOSE. Pleasant-versus-unpleasant is the dimension acoustic models are worst
at, and the transcript carries it far better than the waveform does.

THE SCORE IS RELATIVE TO THE SPEAKER. A quiet person at their most animated may never reach a loud
person's resting level, so an absolute number describes the larynx and the preamp rather than the
moment. With fewer than six segments to compare against, the score is reported as NOT GROUNDED
rather than quietly presented as if it meant something.",
        summary: "how something was said: pitch, loudness, effort, rate — and arousal against the speaker's own habit",
    },
    CmdDoc {
        name: "transcribe",
        summary: "turn captured segments into words — one pass, batched, never blocking capture",
        usage: "\
bsc ear transcribe [--dir <path>] [--limit <n>]

Transcribes everything captured but not yet stored, in ONE whisper invocation.

BATCHED BECAUSE LOADING DOMINATES. Measured: a 7.5s segment costs 630ms to load the model and 249ms
to transcribe it. whisper-cli takes many files and loads once — three files ran in 1.73s batched
against 2.16s separately, and the gap widens with each extra file. That is also why there is no
long-running server here, and none of the health-checking and restarting one would need.

IT NEVER BLOCKS CAPTURE. This is a separate pass; the ear keeps recording whatever happens to it. A
transcriber that is slow or stopped can only make words arrive LATE, because retention holds a
segment past its expiry until its words are saved — see `bsc ear segments`.

EMPTY SEGMENTS ARE NOT TRANSCRIBED. Five of twenty-three real segments held no voice, and ASR
answers silence with a confident hallucination — 'Thank you.' is whisper's. Skipping them costs
nothing and removes that whole class before it reaches the store rather than filtering it after.

Each transcript records the DETECTED language, not an assumed one, and whether the voice was live or
played through a speaker.",
    },
    CmdDoc {
        name: "transcripts",
        summary: "what was said, newest first",
        usage: "\
bsc ear transcripts [--dir <path>] [--limit <n>] [--json|--pretty]

Reads the store: time, duration, language, whether it was a live voice, and the words.

STORED AS APPEND-ONLY JSONL, NOT A DATABASE. Measured on real segments: 190 bytes of text, ~310 with
metadata, so 200 segments a day is 60 KB/day and 21.6 MB/year. The AUDIO those came from is 855x the
size of its own transcript, and the two-hour window already bounds the only large thing. SQLite and
VACUUM management to bound 20 MB a year is more machinery than the problem deserves, and a line per
record stays readable by grep.

Bounded by BOTH rows and age: a talkative week would fill a row budget while a silent month would
keep last year's words.",
    },
    CmdDoc {
        name: "segments",
        summary: "the audio currently held, newest first",
        usage: "\
bsc ear segments [--dir <path>] [--json|--pretty]

What is on disk right now: name, size and age. This is the whole of what the ear remembers — there
is no second copy, and anything past the window is already gone.",
    },
    CmdDoc {
        name: "diarize",
        summary: "who spoke when — cluster a recording's turns into distinct voices",
        usage: "\
bsc ear diarize <wav>... [--json|--pretty]

Splits each recording into speech turns and groups the turns that sound like the same person, so a
conversation reads as Speaker 0 / Speaker 1 / … with the times each one spoke. The number of
speakers is discovered, not supplied.

WHAT IT IS NOT. It does not put NAMES to the voices (that is enrolment against a known voice, a
later step), and it does not pull apart two people talking AT ONCE (that is source separation). It
answers how many distinct voices and which turn is whose.

ONE RECORDING AT A TIME. Each file is clustered on its own and never across files: a single
recording shares one microphone and room, so timbre differences between its turns are the speakers.
Two different recordings differ by their equipment too, and comparing across them would confuse the
mic for a person — so speaker numbers are local to each file, and Speaker 0 in one is not Speaker 0
in another.

Each turn prints its time span, its speaker, and a confidence margin — how much more it sounds like
its own voice than the next-nearest one. A small margin is a turn that could have gone either way,
which is worth seeing rather than trusting the label blindly.",
    },
    CmdDoc {
        name: "attribute",
        summary: "the transcript, stitched onto the voices — who said what, line by line",
        usage: "\
bsc ear attribute <wav>... [--json|--pretty]

Transcribes the recording (whisper), diarizes it (`diarize`), and stitches the two together: each
transcribed phrase is attributed to the speaker whose turn it overlaps most in time. The result is
the recording read back as a conversation — Speaker 0 / Speaker 1 / … with what each one said.

It composes the two halves and adds nothing to their limits. The words are only as good as whisper
on that audio (it hallucinates on noise, and repeats on heavy overlap), and the speakers are only as
good as `diarize` (it over-splits short turns on the coarse feature-based voiceprint). A phrase that
overlaps no speech turn — something whisper heard in a stretch the detector called silence — is
shown as unattributed rather than pinned to the nearest voice.

Needs a whisper binary: `$BSC_WHISPER_BIN` / `$BSC_WHISPER_MODEL`, or `whisper-cli` on PATH with a
model under the models dir. Naming a speaker (which one is you) is a later step; this labels them 0,
1, 2 in the order they first speak.",
    },
];

#[derive(Default, Debug)]
struct Args {
    all: bool,
    limit: Option<usize>,
    live_dir: Option<String>,
    replay_dir: Option<String>,
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
            "--live-dir" => a.live_dir = Some(rest.value("--live-dir needs a directory of live recordings")?),
            "--replay-dir" => a.replay_dir = Some(rest.value("--replay-dir needs a directory of replayed recordings")?),
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--device" => a.device = Some(rest.value("--device needs a device name")?),
            "--dir" => a.dir = Some(rest.value("--dir needs a path")?),
            "--limit" => {
                a.limit = Some(
                    rest.value("--limit needs a whole number")?
                        .parse()
                        .map_err(|_| "--limit needs a whole number".to_string())?,
                );
            }
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
                transcribe_grace_ms: Budget::default().transcribe_grace_ms,
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
        transcripts: Some(transcript_path(p)),
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

/// Read a wav as mono f32 at its own rate.
fn read_wav(path: &std::path::Path) -> Result<(Vec<f32>, u32), String> {
    let mut r = hound::WavReader::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let spec = r.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().filter_map(|s| s.ok()).map(|s| s as f32 / max).collect()
        }
        hound::SampleFormat::Float => r.samples::<f32>().filter_map(|s| s.ok()).collect(),
    };
    let mono = crate::audio::to_mono(&samples, spec.channels);
    Ok((mono, spec.sample_rate))
}

fn liveness_store(p: &Paths, device: &str) -> PathBuf {
    let safe: String = device
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    p.root.join("liveness").join(format!("{safe}.json"))
}

/// Measure the ratio for each file with enough signal to measure.
///
/// GATED ON ENERGY, NOT ON VOICING, and the difference is the whole subtlety. Silence must be
/// excluded — the feature is fundamental-over-rumble and silence has no fundamental, so an empty
/// segment scores exactly like a replayed one. But `prosody::has_speech` is the WRONG gate for it:
/// replayed speech has a fundamental so attenuated that the pitch detector finds no voiced frames,
/// so the very property that makes replay detectable also makes it look empty. Measured — a replay
/// of the maintainer's own voice came back "no speech" instead of "replayed".
///
/// Energy separates the three cases cleanly where voicing collapses two of them: silence is quiet,
/// replayed speech is loud with a weak fundamental, live speech is loud with a strong one.
fn ratios_of(files: &[std::path::PathBuf]) -> Result<Vec<f32>, String> {
    let mut out = Vec::new();
    for f in files {
        let (s, sr) = read_wav(f)?;
        if crate::audio::rms(&s) < crate::liveness::MIN_MEASURABLE_RMS {
            continue;
        }
        if let Some(r) = crate::liveness::liveness_ratio(&s, sr) {
            out.push(r);
        }
    }
    Ok(out)
}

fn cmd_liveness(a: &Args, p: &Paths) -> Result<(), String> {
    use crate::liveness;
    let device = a.device.clone().unwrap_or_else(|| "default".into());
    let store = liveness_store(p, &device);
    let sub = a.positional.get(1).map(String::as_str);

    if sub == Some("show") {
        let raw = std::fs::read_to_string(&store)
            .map_err(|_| format!("no calibration for '{device}' — run `bsc ear liveness calibrate`"))?;
        let c: liveness::Calibration = serde_json::from_str(&raw).map_err(|e| format!("{e}"))?;
        println!("device      {}", c.device);
        println!("live        {} samples, min {:.2}, median {:.2}", c.n_live, c.live_min, c.live_median);
        println!("replayed    {} samples, max {:.2}, median {:.2}", c.n_replay, c.replay_max, c.replay_median);
        println!("threshold   {:.2}", c.threshold);
        println!("separable   {}", if c.separable { "yes" } else { "NO — this pairing cannot be judged on this feature" });
        return Ok(());
    }

    if sub == Some("calibrate") {
        let (Some(ld), Some(rd)) = (&a.live_dir, &a.replay_dir) else {
            return Err(
                "calibration needs both classes: --live-dir <dir> --replay-dir <dir>. Directories \
                 rather than file lists, because a calibration wants every clip you have of each \
                 kind and listing them by hand invites picking the flattering ones."
                    .into(),
            );
        };
        let wavs = |d: &str| -> Result<Vec<PathBuf>, String> {
            let mut v: Vec<PathBuf> = std::fs::read_dir(d)
                .map_err(|e| format!("{d}: {e}"))?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|f| f.extension().is_some_and(|x| x == "wav"))
                .collect();
            v.sort();
            Ok(v)
        };
        let cal = liveness::calibrate(&device, &ratios_of(&wavs(ld)?)?, &ratios_of(&wavs(rd)?)?)?;
        if let Some(dir) = store.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{e}"))?;
        }
        std::fs::write(&store, serde_json::to_string_pretty(&cal).map_err(|e| format!("{e}"))?)
            .map_err(|e| format!("could not write {}: {e}", store.display()))?;
        println!(
            "calibrated '{}': live >= {:.2} (n={}), replayed <= {:.2} (n={}), threshold {:.2}",
            device, cal.live_min, cal.n_live, cal.replay_max, cal.n_replay, cal.threshold
        );
        if !cal.separable {
            println!("WARNING: the classes OVERLAP on this pairing — nothing will be judged from it.");
        }
        return Ok(());
    }

    // Judge.
    let cal: Option<liveness::Calibration> = std::fs::read_to_string(&store)
        .ok()
        .and_then(|r| serde_json::from_str(&r).ok());
    let files: Vec<PathBuf> = a.positional[1..].iter().map(PathBuf::from).collect();
    if files.is_empty() {
        return Err("nothing to judge — pass one or more wav files".into());
    }
    if cal.is_none() {
        println!("no calibration for '{device}' — every verdict below will be `unknown`, which is the");
        println!("honest answer rather than a guess. Calibrate with `bsc ear liveness calibrate`.\n");
    }
    for f in &files {
        let (s, sr) = read_wav(f)?;
        // Silence has no fundamental, so it scores like replay — gate on ENERGY, not voicing,
        // because replayed speech is barely voiced by design.
        let loud = crate::audio::rms(&s) >= liveness::MIN_MEASURABLE_RMS;
        let ratio = loud.then(|| liveness::liveness_ratio(&s, sr)).flatten();
        let v = liveness::judge(ratio, cal.as_ref());
        println!(
            "  {:<34} {:<9} ratio {}",
            f.file_name().and_then(|x| x.to_str()).unwrap_or("?"),
            format!("{v:?}").to_lowercase(),
            ratio.map(|r| format!("{r:8.2}")).unwrap_or_else(|| " too quiet".into())
        );
    }
    Ok(())
}

/// Cut one recording into speech turns, `(start_ms, end_ms)`, with the same VAD the live ear uses.
///
/// Runs the tested [`segment::Segmenter`] over the file frame by frame, so a recording is split
/// exactly the way it would have been split had it arrived live — one path, not a second one that
/// can drift from capture.
fn turns_of(samples: &[f32]) -> Result<Vec<(u64, u64)>, String> {
    use crate::segment::{Segmenter, VadConfig, VadEvent};
    let cfg = VadConfig::default();
    let flen = crate::audio::frame_len(cfg.frame_ms);
    let mut seg = Segmenter::new(cfg)?;
    let mut turns = Vec::new();
    let mut record = |e: Option<VadEvent>| {
        if let Some(VadEvent::Close { start_ms, end_ms }) = e {
            turns.push((start_ms, end_ms));
        }
    };
    let mut at = 0usize;
    while at + flen <= samples.len() {
        record(seg.push(crate::audio::rms(&samples[at..at + flen])));
        at += flen;
    }
    record(seg.finish());
    Ok(turns)
}

fn cmd_diarize(a: &Args) -> Result<(), String> {
    use crate::diarize;
    let files: Vec<PathBuf> = a.positional[1..].iter().map(PathBuf::from).collect();
    if files.is_empty() {
        return Err("pass one or more wav files to diarize".into());
    }

    let mut out = Vec::new();
    for f in &files {
        let (samples, sr) = read_wav(f)?;
        let spans = turns_of(&samples)?;
        let prints = voiceprints_of(&samples, sr, &spans);
        let labels = diarize::cluster(&prints, diarize::SAME_SPEAKER);
        let speakers = labels.iter().flatten().collect::<std::collections::BTreeSet<_>>().len();
        out.push((f.clone(), spans, prints, labels, speakers));
    }

    if a.json || a.pretty {
        let v: Vec<_> = out
            .iter()
            .map(|(f, spans, prints, labels, speakers)| {
                let turns: Vec<_> = spans
                    .iter()
                    .zip(prints)
                    .zip(labels)
                    .enumerate()
                    .map(|(i, (((s, e), vp), lab))| {
                        json!({
                            "start_ms": s, "end_ms": e,
                            "speaker": lab,
                            "f0": vp.as_ref().and_then(|v| v.f0),
                            "voiced_fraction": vp.as_ref().map(|v| v.voiced_fraction),
                            "margin": diarize::placement_margin(i, prints, labels),
                        })
                    })
                    .collect();
                json!({ "file": f.file_name().and_then(|s| s.to_str()), "speakers": speakers, "turns": turns })
            })
            .collect();
        return print_json(&v, a.pretty);
    }

    for (f, spans, prints, labels, speakers) in &out {
        println!("\n{}", f.file_name().and_then(|s| s.to_str()).unwrap_or("?"));
        let placed = labels.iter().filter(|l| l.is_some()).count();
        println!(
            "  {speakers} distinct voice(s) across {} turn(s) ({} placed, {} too short or unvoiced)",
            spans.len(),
            placed,
            spans.len() - placed
        );
        for (i, ((s, e), lab)) in spans.iter().zip(labels).enumerate() {
            let span = format!("{}–{}", fmt_ms(*s), fmt_ms(*e));
            match lab {
                Some(id) => {
                    let m = diarize::placement_margin(i, prints, labels);
                    let f0 = prints[i].as_ref().and_then(|v| v.f0);
                    let pitch = f0.map(|p| format!("{p:.0}Hz")).unwrap_or_else(|| "—".into());
                    let mark = match m {
                        Some(m) if m < 0.0 => "  ⚠ closer to another voice",
                        Some(m) if m < 0.2 => "  (borderline)",
                        _ => "",
                    };
                    println!("  [{span}]  Speaker {id}   pitch {pitch}{mark}");
                }
                None => println!("  [{span}]  —  (too short or unvoiced to place)"),
            }
        }
    }
    println!(
        "\nNote: speaker numbers are local to each file — the mic and room differ between recordings,\n\
         so Speaker 0 here is not Speaker 0 there. Naming a voice, and splitting people who talk over\n\
         each other, are separate steps this does not do."
    );
    Ok(())
}

/// Fingerprint each turn; a turn too short, too unvoiced, or silent is left `None` and placed by
/// nothing. The ONE place the placeable rule lives, so `diarize` and `attribute` never disagree
/// about which turns count.
fn voiceprints_of(
    samples: &[f32],
    sr: u32,
    spans: &[(u64, u64)],
) -> Vec<Option<crate::diarize::Voiceprint>> {
    use crate::diarize;
    spans
        .iter()
        .map(|&(s, e)| {
            let lo = (s * sr as u64 / 1000) as usize;
            let hi = ((e * sr as u64 / 1000) as usize).min(samples.len());
            if hi <= lo {
                return None;
            }
            let vp = diarize::voiceprint(&samples[lo..hi], sr);
            // Long enough AND with a real fingerprint. A very short turn, or pure silence between
            // real turns, is left unplaced rather than assigned to whoever it landed nearest.
            let placeable = vp.seconds >= diarize::MIN_TURN_SECONDS
                && (vp.f0.is_some() || vp.voiced_fraction < diarize::MIN_VOICED_FRACTION)
                && vp.envelope.iter().any(|b| *b != 0.0);
            placeable.then_some(vp)
        })
        .collect()
}

/// Diarize a file into speaker-labelled turns: `(start_ms, end_ms, speaker)`. The shared half of
/// `diarize` and `attribute` — segment, fingerprint, cluster — so the two verbs agree by construction.
fn speaker_turns(samples: &[f32], sr: u32) -> Result<Vec<(u64, u64, Option<usize>)>, String> {
    let spans = turns_of(samples)?;
    let prints = voiceprints_of(samples, sr, &spans);
    let labels = crate::diarize::cluster(&prints, crate::diarize::SAME_SPEAKER);
    Ok(spans.iter().zip(labels).map(|(&(s, e), l)| (s, e, l)).collect())
}

fn cmd_attribute(a: &Args) -> Result<(), String> {
    use crate::{diarize, transcribe};
    let files: Vec<PathBuf> = a.positional[1..].iter().map(PathBuf::from).collect();
    if files.is_empty() {
        return Err("pass one or more wav files to attribute".into());
    }
    let whisper = transcribe::Whisper::resolve()?;

    let mut out = Vec::new();
    for f in &files {
        let (samples, sr) = read_wav(f)?;
        let turns = speaker_turns(&samples, sr)?;
        let (lang, phrases) = transcribe::timed_transcript(&whisper, f)?;
        let lines = diarize::attribute(&phrases, &turns);
        let speakers = turns.iter().filter_map(|t| t.2).collect::<std::collections::BTreeSet<_>>().len();
        out.push((f.clone(), lang, speakers, lines));
    }

    if a.json || a.pretty {
        let v: Vec<_> = out
            .iter()
            .map(|(f, lang, speakers, lines)| {
                json!({ "file": f.file_name().and_then(|s| s.to_str()), "language": lang, "speakers": speakers, "lines": lines })
            })
            .collect();
        return print_json(&v, a.pretty);
    }

    for (f, lang, speakers, lines) in &out {
        println!("\n{}  ({lang}, {speakers} voice(s))", f.file_name().and_then(|s| s.to_str()).unwrap_or("?"));
        // Group consecutive phrases by the same speaker into one block, the way a transcript reads.
        let mut i = 0;
        while i < lines.len() {
            let spk = lines[i].speaker;
            let start = lines[i].start_ms;
            let mut text = String::new();
            while i < lines.len() && lines[i].speaker == spk {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(&lines[i].text);
                i += 1;
            }
            let who = spk.map(|s| format!("Speaker {s}")).unwrap_or_else(|| "(unattributed)".into());
            println!("  [{}] {who}: {text}", fmt_ms(start));
        }
    }
    Ok(())
}

/// `m:ss.d` from milliseconds — a turn's place in the recording, read at a glance.
fn fmt_ms(ms: u64) -> String {
    let total = ms as f64 / 1000.0;
    let m = (total / 60.0).floor() as u64;
    let s = total - (m as f64) * 60.0;
    format!("{m}:{s:04.1}")
}

fn cmd_prosody(a: &Args, p: &Paths) -> Result<(), String> {
    use crate::prosody;
    let files: Vec<std::path::PathBuf> = if a.positional.len() > 1 {
        a.positional[1..].iter().map(std::path::PathBuf::from).collect()
    } else {
        let mut v: Vec<_> = std::fs::read_dir(p.audio())
            .map_err(|e| format!("could not read {}: {e}", p.audio().display()))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|f| f.extension().is_some_and(|x| x == "wav"))
            .collect();
        v.sort();
        v
    };
    if files.is_empty() {
        return Err("no wavs to measure — pass paths, or --dir a capture directory".into());
    }

    // TWO PASSES, and it has to be two: the baseline IS the other segments, so nothing can be
    // scored until every one of them has been measured.
    let mut measured = Vec::new();
    for f in &files {
        let (samples, sr) = read_wav(f)?;
        let pr = prosody::measure(&prosody::frames(&samples, sr), sr);
        measured.push((f.clone(), pr));
    }
    let mut base = prosody::Baseline::default();
    for (_, pr) in &measured {
        base.observe(pr);
    }
    let (speech, silent): (Vec<_>, Vec<_>) = measured.iter().partition(|(_, pr)| pr.has_speech());
    let mut scored: Vec<_> =
        speech.iter().map(|(f, pr)| (f.clone(), *pr, prosody::arousal(pr, &base))).collect();
    scored.sort_by(|x, y| y.2.score.partial_cmp(&x.2.score).unwrap_or(std::cmp::Ordering::Equal));

    if a.json || a.pretty {
        let v: Vec<_> = scored
            .iter()
            .map(|(f, pr, ar)| json!({ "file": f.file_name().and_then(|s| s.to_str()), "prosody": pr, "arousal": ar }))
            .collect();
        return print_json(&v, a.pretty);
    }
    if !base.ready() {
        println!(
            "NOT GROUNDED: {} segment(s) is too thin a baseline to z-score against (need {}).\n\
             The numbers below are printed, but the arousal column does not yet mean anything.\n",
            base.n,
            prosody::MIN_BASELINE
        );
    }
    println!("{:<30} {:>7} {:>7} {:>7} {:>7} {:>6}  {:>7}", "segment", "arousal", "f0", "range", "loud", "rate", "secs");
    for (f, pr, ar) in &scored {
        println!(
            "{:<30} {:>+7.2} {:>7.0} {:>7.0} {:>7.4} {:>6.1}  {:>7.1}",
            f.file_name().and_then(|s| s.to_str()).unwrap_or("?"),
            ar.score,
            pr.f0_median,
            pr.f0_range,
            pr.rms_mean,
            pr.onset_rate,
            pr.duration_s
        );
    }
    if !silent.is_empty() {
        println!("\n{} segment(s) carried NO VOICED SPEECH and are not scored:", silent.len());
        for (f, pr) in &silent {
            println!(
                "  {:<28} voiced {:.0}%  rms {:.4}",
                f.file_name().and_then(|s| s.to_str()).unwrap_or("?"),
                pr.voiced_fraction * 100.0,
                pr.rms_mean
            );
        }
        println!("  (not low arousal — no speech. Cross-check these against what ASR claimed they said.)");
    }
    println!("\narousal is a z-score against these same segments — 0 is this speaker's ordinary.");
    Ok(())
}

fn transcript_path(p: &Paths) -> PathBuf {
    p.root.join("transcripts.jsonl")
}

fn load_transcripts(p: &Paths) -> (Vec<crate::transcript::Transcript>, usize) {
    match std::fs::read_to_string(transcript_path(p)) {
        Ok(raw) => crate::transcript::parse(&raw),
        Err(_) => (vec![], 0),
    }
}

fn cmd_transcribe(a: &Args, p: &Paths) -> Result<(), String> {
    use crate::{transcribe, transcript};
    let w = transcribe::Whisper::resolve()?;
    let (existing, bad) = load_transcripts(p);
    if bad > 0 {
        println!("note: {bad} unreadable line(s) in the store were skipped");
    }
    let done: Vec<String> = existing.iter().map(|t| t.segment.clone()).collect();
    let on_disk: Vec<String> = std::fs::read_dir(p.audio())
        .map_err(|e| format!("could not read {}: {e}", p.audio().display()))?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();

    // Skip the empty ones BEFORE spending ~900ms each on them. Five of twenty-three real segments
    // held no voice, and ASR answers silence with a confident hallucination.
    let mut work = Vec::new();
    let mut skipped = 0usize;
    for name in transcribe::pending(&on_disk, &done) {
        let path = p.audio().join(&name);
        let Ok((samples, sr)) = read_wav(&path) else { continue };
        let pr = crate::prosody::measure(&crate::prosody::frames(&samples, sr), sr);
        if pr.has_speech() {
            work.push(name);
        } else {
            skipped += 1;
        }
        if a.limit.is_some_and(|l| work.len() >= l) {
            break;
        }
    }
    if skipped > 0 {
        println!("skipped {skipped} segment(s) with no voice — ASR would only have hallucinated over them");
    }
    if work.is_empty() {
        println!("nothing to transcribe");
        return Ok(());
    }

    // Liveness, where this pairing has been calibrated. Unknown otherwise — never a guess.
    let device = a.device.clone().unwrap_or_else(|| "default".into());
    let cal: Option<crate::liveness::Calibration> =
        std::fs::read_to_string(liveness_store(p, &device)).ok().and_then(|r| serde_json::from_str(&r).ok());
    let audio_dir = p.audio();
    let live_of = |name: &str| -> Option<bool> {
        let (s, sr) = read_wav(&audio_dir.join(name)).ok()?;
        match crate::liveness::judge(crate::liveness::liveness_ratio(&s, sr), cal.as_ref()) {
            crate::liveness::Verdict::Live => Some(true),
            crate::liveness::Verdict::Replayed => Some(false),
            crate::liveness::Verdict::Unknown => None,
        }
    };

    println!("transcribing {} segment(s) in one pass...", work.len());
    let rows = transcribe::transcribe_batch(&w, &p.audio(), &work, &live_of)?;

    let mut all = existing;
    all.extend(rows.iter().cloned());
    let budget = transcript::Budget::default();
    let kept = transcript::retain(&all, now_ms(), &budget);
    let dropped = all.len() - kept.len();
    std::fs::write(transcript_path(p), transcript::render(&kept)?)
        .map_err(|e| format!("could not write the store: {e}"))?;
    for r in &rows {
        println!("  {:<28} {:>5.1}s {:<4} {}", r.segment, r.seconds, r.language, r.text.chars().take(60).collect::<String>());
    }
    println!("stored {} new, {} held{}", rows.len(), kept.len(),
        if dropped > 0 { format!(", {dropped} pruned past the bound") } else { String::new() });
    Ok(())
}

fn cmd_transcripts(a: &Args, p: &Paths) -> Result<(), String> {
    let (mut rows, bad) = load_transcripts(p);
    rows.sort_by_key(|r| std::cmp::Reverse(r.started_unix_ms));
    if let Some(l) = a.limit {
        rows.truncate(l);
    }
    if a.json || a.pretty {
        let s = if a.pretty { serde_json::to_string_pretty(&rows) } else { serde_json::to_string(&rows) };
        println!("{}", s.map_err(|e| format!("{e}"))?);
        return Ok(());
    }
    if rows.is_empty() {
        println!("nothing transcribed yet — `bsc ear transcribe` reads what has been captured");
        return Ok(());
    }
    for r in &rows {
        let live = match r.live {
            Some(true) => "live",
            Some(false) => "replay",
            None => "?",
        };
        println!("  {:>4} min ago {:>5.1}s {:<4} {:<6} {}", (now_ms() - r.started_unix_ms) / 60_000,
            r.seconds, r.language, live, r.text);
    }
    let bytes = std::fs::metadata(transcript_path(p)).map(|m| m.len()).unwrap_or(0);
    println!("\n{} transcript(s), store is {:.1} KB{}", rows.len(), bytes as f64 / 1024.0,
        if bad > 0 { format!(", {bad} unreadable line(s) skipped") } else { String::new() });
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
        Some("liveness") => cmd_liveness(&a, &p),
        Some("transcribe") => cmd_transcribe(&a, &p),
        Some("transcripts") => cmd_transcripts(&a, &p),
        Some("prosody") => cmd_prosody(&a, &p),
        Some("segments") => cmd_segments(&a, &p),
        Some("diarize") => cmd_diarize(&a),
        Some("attribute") => cmd_attribute(&a),
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
        assert_eq!(
            names,
            vec![
                "devices", "start", "stop", "status", "listen", "levels", "liveness", "prosody",
                "transcribe", "transcripts", "segments", "diarize", "attribute"
            ]
        );
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
