//! `bsc say` — the verbs.
//!
//! Speech was reachable only from the app: `speech.ts` calls `window.speechSynthesis`, which an
//! agent, a hook, an automation or a fleet director cannot touch. `bsc` sits in the three-command
//! mandatory permission tier, so putting speech here makes it auto-runnable by every role with no
//! grant — the difference between "the app can speak" and "anything in the system can speak".

use crate::voice::{
    self, Availability, Platform, ProviderKind, Resolution, SayRequest, SpeechCommand,
};
use bsc_cli_util::{args, CmdDoc};
use serde_json::json;
use std::io::Write;
use std::path::PathBuf;

pub const TAGLINE: &str = "speak text aloud — the neural voice when it is installed, the OS voice when it is not";

/// Where piper voices live when `$BSC_SAY_VOICE_DIR` does not say otherwise.
pub const VOICE_DIR_ENV: &str = "BSC_SAY_VOICE_DIR";
/// Overrides the output device for one process — how a hook or automation names an output.
pub const DEVICE_ENV: &str = "BSC_SAY_DEVICE";

/// The remembered output device, if one was chosen.
///
/// Precedence: `--device`, then `$BSC_SAY_DEVICE`, then this file, then the system default. A
/// speech feature that needs a flag every single time is a speech feature nothing automated will
/// ever use, so the choice has to survive the process that made it.
fn device_file() -> Option<PathBuf> {
    bsc_util::bsc_base_dir().map(|b| b.join("say-device"))
}

fn voice_file() -> Option<PathBuf> {
    bsc_util::bsc_base_dir().map(|b| b.join("say-voice"))
}

fn remembered_voice() -> Option<String> {
    let raw = std::fs::read_to_string(voice_file()?).ok()?;
    let t = raw.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// `--voice`, then the remembered choice, then whatever sorts first.
fn resolve_voice(a: &Args) -> Option<String> {
    a.voice.clone().or_else(remembered_voice)
}

fn remembered_device() -> Option<String> {
    let raw = std::fs::read_to_string(device_file()?).ok()?;
    let t = raw.trim();
    (!t.is_empty()).then(|| t.to_string())
}

fn resolve_device(a: &Args) -> Option<String> {
    a.device
        .clone()
        .or_else(|| std::env::var(DEVICE_ENV).ok().filter(|v| !v.trim().is_empty()))
        .or_else(remembered_device)
}

/// Playback devices, from `aplay -L`.
///
/// Parsed from the player's OWN listing rather than enumerated separately, so every name printed is
/// a name `aplay -D` will accept. A list whose entries the player then rejects is worse than none.
fn list_outputs() -> Result<Vec<String>, String> {
    let out = std::process::Command::new("aplay")
        .arg("-L")
        .output()
        .map_err(|e| format!("could not run aplay: {e}"))?;
    if !out.status.success() {
        return Err("aplay could not list output devices".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        // A PCM name starts at column 0; its description is indented beneath it.
        .filter(|l| !l.starts_with(char::is_whitespace) && !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .collect())
}

pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "speak",
        summary: "say something out loud (the verb is optional — `bsc say \"hello\"` is the same thing)",
        usage: "\
bsc say \"some text\"                    # the ordinary form
bsc say speak \"some text\"              # the same, spelled out
bsc say \"text\" --rate 1.4 --voice en_US-ryan-high
bsc say \"text\" --out /tmp/line.wav     # synthesize without playing (piper only)
bsc say \"text\" --provider system       # force the OS voice

RATE IS A MULTIPLIER, 1.0 BEING NORMAL — the same vocabulary the Web Speech API uses, and the same
value the app's `ttsRate` setting already stores, so the frontend hands its setting straight over.
Each engine's own scale is mapped internally, and they disagree: a signed percentage, words per
minute, a small signed integer, and piper's INVERTED length scale.

TEXT NEVER REACHES A SHELL. It is passed as a single argv element or on the child's stdin, and a
voice name reaches PowerShell through the environment rather than the script. This is not incidental
— an agent speaks whatever it was told to speak, so the text is the least trustworthy input here.

A SUCCESSFUL EXIT MEANS AUDIO WAS WRITTEN, NOT THAT ANYONE HEARD IT. There is no way to probe
whether a human was in earshot, so `bsc say` cannot tell you. It played to ALSA `default` and
returned 0 while the sound went to an unworn headset — `bsc say devices` is how you choose where it
comes out, and the choice is remembered.

WHICH ENGINE ANSWERS IS PROBED, NOT CONFIGURED. Piper when its binary and a voice both resolve,
otherwise the OS speech service, and if you named one with --provider it is honoured or refused —
never quietly swapped for the other. `bsc say voices` reports what was found and what was not.",
    },
    CmdDoc {
        name: "all",
        summary: "say it on every eligible output at once — one voice, the whole room",
        usage: "\
bsc say all \"some text\"                # every eligible output, simultaneously
bsc say all \"text\" --json             # which outputs opened, and which refused

SYNTHESIZED ONCE, PLAYED N TIMES. The wav is rendered a single time and handed to one player per
output, so every speaker gets the SAME audio rather than N separate synthesis runs that would drift
against each other and cost N times the work.

SIMULTANEOUS, NOT SEQUENTIAL, and that is the whole implementation. An ordinary `bsc say` waits for
its player to exit; looping that over eight outputs would play them one after another, which is not
what `all` means. Every child is started before any is waited on.

ELIGIBLE MEANS IT OPENED, NEVER THAT ANYONE HEARD IT. There is no output-side probe — `bsc ear
levels` has no counterpart here, because you cannot measure whether a human was in earshot. What
this reports is which outputs the player accepted and which refused, and a refusal names the reason.

The set is the same one `bsc say devices` shows without --all: the real choices, not the routing
variants. ALSA presents one card many times over (`surround51:`, `iec958:`, `dsnoop:`), and speaking
to all of those would be speaking to the same speaker repeatedly.",
    },
    CmdDoc {
        name: "devices",
        summary: "playback devices, and which one speech will actually come out of",
        usage: "\
bsc say devices [--all] [--json|--pretty]
bsc say devices --set <name>     # remember it, so a hook does not need the flag
bsc say devices --set default    # go back to the system default

Lists the outputs `aplay -D` will accept, parsed from aplay's own listing so a name printed here is
never a name the player then rejects.

IT EXISTS BECAUSE A SUCCESSFUL EXIT IS NOT A PROMISE ANYONE HEARD YOU. `bsc say` played to ALSA
`default` and returned 0 while the audio went to a headset nobody was wearing — the speakers were on
HDMI. That is the same failure `bsc ear levels` prevents on the input side, and unlike the input side
there is no way to measure it: you cannot probe whether a human heard something. So the fallback is
to let a person choose once, and remember it.

Precedence: --device, then $BSC_SAY_DEVICE, then the remembered choice, then the system default.",
    },
    CmdDoc {
        name: "voice",
        summary: "the voice speech uses by default — print it, or remember one",
        usage: "\
bsc say voice              # what is remembered
bsc say voice am_puck      # remember it

Precedence: --voice, then this, then whichever voice sorts first.",
    },
    CmdDoc {
        name: "voices",
        summary: "what this machine can actually speak with, and which provider would answer",
        usage: "\
bsc say voices [--json|--pretty]

Reports, in order: the platform, each provider with whether it resolved and precisely what was
missing when it did not, which one would answer an ordinary `bsc say`, and the voices available from
it.

IT EXISTS BECAUSE A FALLBACK MUST NOT BE INVISIBLE. Speech that comes out in the wrong voice is
indistinguishable from speech that came out in the right one unless you already know what the right
one sounds like — so the machine has to be able to say which engine it used and why.

INSTALLING A NEUTRAL VOICE: put a piper `.onnx` model (and its `.onnx.json` companion) in the voice
directory this prints, and put the `piper` binary on PATH. Both are then found with no configuration.",
    },
];

#[derive(Default, Debug, Clone)]
struct Args {
    all: bool,
    verify: bool,
    mic: Option<String>,
    blend: Option<String>,
    ipa: bool,
    lang: Option<String>,
    device: Option<String>,
    /// WHERE the voice comes out, as a destination rather than a sound card.
    ///
    /// The mirror of the ear's channel, which labels the RECORDING path: `desk` plays through the
    /// resolved local output, `phone` streams to the paired mobile. A device name is a narrower
    /// thing and stays on `--device`; a channel can name somewhere that is not a local device at
    /// all, which is the whole reason it exists.
    channel: Option<String>,
    json: bool,
    pretty: bool,
    provider: Option<String>,
    rate: Option<f32>,
    voice: Option<String>,
    out: Option<String>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let (mut a, positional) = args::walk(raw, Args::default(), |flag, a: &mut Args, rest| {
        match flag {
            "--all" => a.all = true,
            "--verify" => a.verify = true,
            "--mic" => a.mic = Some(rest.value("--mic needs a capture device, e.g. plughw:CARD=USB,DEV=0")?),
            "--blend" => a.blend = Some(rest.value("--blend needs voices, e.g. am_puck:2,bm_george:1")?),
            "--ipa" => a.ipa = true,
            "--lang" => a.lang = Some(rest.value("--lang needs an espeak language code, e.g. es or ja")?),
            "--device" => a.device = Some(rest.value("--device needs an output device name")?),
            "--channel" => a.channel = Some(rest.value("--channel needs a destination: desk or phone")?),
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--provider" => a.provider = Some(rest.value("--provider needs 'system' or 'piper'")?),
            "--voice" => a.voice = Some(rest.value("--voice needs a voice name")?),
            "--out" => a.out = Some(rest.value("--out needs a path to write a wav to")?),
            "--rate" => {
                a.rate = Some(
                    rest.value("--rate needs a multiplier, 1.0 being normal")?
                        .parse()
                        .map_err(|_| "--rate needs a number, 1.0 being normal".to_string())?,
                );
            }
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

// ── Probing ───────────────────────────────────────────────────────────────────────────────────────

/// Find `program` in `dirs`. Pure so the Windows `.exe` behaviour is asserted on Linux; the caller
/// supplies the directories.
pub fn find_in(dirs: &[PathBuf], program: &str, platform: Platform) -> Option<PathBuf> {
    let names: Vec<String> = match platform {
        Platform::Windows => vec![format!("{program}.exe"), program.to_string()],
        Platform::Linux | Platform::MacOs => vec![program.to_string()],
    };
    dirs.iter().find_map(|d| {
        names.iter().map(|n| d.join(n)).find(|p| p.is_file())
    })
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default()
}

fn on_path(program: &str, platform: Platform) -> Option<PathBuf> {
    find_in(&path_dirs(), program, platform)
}

/// Where piper voice models are looked for: `$BSC_SAY_VOICE_DIR`, else `~/.base-studio-code/voices`.
pub fn voice_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os(VOICE_DIR_ENV) {
        return Some(PathBuf::from(d));
    }
    bsc_util::bsc_base_dir().map(|b| b.join("voices"))
}

fn installed_voice_files() -> Vec<String> {
    let Some(dir) = voice_dir() else { return vec![] };
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![] };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".onnx"))
        .collect()
}

/// Where espeak-ng lives — PATH first, then the copy piper bundles.
///
/// Kokoro needs a grapheme-to-phoneme step and piper already ships one, so on a machine with piper
/// installed this costs nothing extra. Looked up rather than assumed, because the bundled copy is
/// an implementation detail of a different provider and may not be there.
fn find_espeak(platform: Platform) -> Option<(PathBuf, PathBuf)> {
    if let Some(p) = on_path("espeak-ng", platform) {
        let data = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
        return Some((p, data));
    }
    let bundled = bsc_util::home_dir()?.join(".local/share/piper");
    let exe = bundled.join(if platform == Platform::Windows { "espeak-ng.exe" } else { "espeak-ng" });
    exe.is_file().then_some((exe, bundled))
}

/// What actually resolved on this machine.
struct Probed {
    considered: Vec<Availability>,
    /// (piper binary, model path) when both halves are present.
    piper: Option<(PathBuf, PathBuf)>,
    /// (kokoro paths, the chosen voice file, espeak, espeak data) when the whole chain resolves.
    kokoro: Option<(crate::kokoro::Paths, PathBuf, PathBuf, PathBuf)>,
    system: Option<PathBuf>,
}

fn probe(platform: Platform, requested_voice: Option<&str>) -> Probed {
    let sys_prog = platform.system_program();
    let system = on_path(sys_prog, platform);
    let system_avail = Availability {
        kind: ProviderKind::System,
        available: system.is_some(),
        detail: match &system {
            Some(p) => format!("{} at {}", sys_prog, p.display()),
            None => format!("{sys_prog} is not on PATH"),
        },
    };

    let binary = on_path("piper", platform);
    let installed = installed_voice_files();
    let model = voice::pick_voice(installed.clone(), requested_voice);
    let dir_note = voice_dir().map(|d| d.display().to_string()).unwrap_or_else(|| "<no home>".into());
    let (piper, piper_avail) = match (&binary, &model, voice_dir()) {
        (Some(b), Some(m), Some(dir)) => {
            let path = dir.join(m);
            (
                Some((b.clone(), path.clone())),
                Availability {
                    kind: ProviderKind::Piper,
                    available: true,
                    detail: format!("piper at {} with {}", b.display(), path.display()),
                },
            )
        }
        (None, _, _) => (
            None,
            Availability {
                kind: ProviderKind::Piper,
                available: false,
                detail: "the piper binary is not on PATH".into(),
            },
        ),
        (Some(_), None, _) => (
            None,
            Availability {
                kind: ProviderKind::Piper,
                available: false,
                detail: match requested_voice {
                    // Naming what IS there turns "not found" into something actionable.
                    Some(v) if installed.is_empty() => {
                        format!("no voice '{v}' — and no .onnx model at all in {dir_note}")
                    }
                    Some(v) => format!("no voice '{v}' in {dir_note} (installed: {})", installed.join(", ")),
                    None => format!("piper is installed but no .onnx voice model is in {dir_note}"),
                },
            },
        ),
        (Some(_), Some(_), None) => (
            None,
            Availability {
                kind: ProviderKind::Piper,
                available: false,
                detail: "no home directory, so no voice directory could be resolved".into(),
            },
        ),
    };
    // Kokoro needs four things and reports precisely which one is missing — "kokoro unavailable"
    // with no reason is the class of message that sends someone looking in the wrong place.
    let (kokoro, kokoro_avail) = probe_kokoro(platform, requested_voice);
    Probed { considered: vec![kokoro_avail, piper_avail, system_avail], piper, kokoro, system }
}

type KokoroSetup = (crate::kokoro::Paths, PathBuf, PathBuf, PathBuf);

fn probe_kokoro(platform: Platform, requested_voice: Option<&str>) -> (Option<KokoroSetup>, Availability) {
    let unavailable = |detail: String| Availability { kind: ProviderKind::Kokoro, available: false, detail };
    let Some(paths) = crate::kokoro::Paths::resolve() else {
        return (None, unavailable("no home directory, so the model dir could not be resolved".into()));
    };
    if !paths.complete() {
        let missing = [
            (!paths.model.is_file()).then(|| format!("model.onnx at {}", paths.model.display())),
            (!paths.tokenizer.is_file()).then(|| "tokenizer.json".to_string()),
            (!paths.voices.is_dir()).then(|| "a voices/ directory".to_string()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        return (None, unavailable(format!("kokoro is missing {}", missing.join(", "))));
    }
    let Some((espeak, data)) = find_espeak(platform) else {
        return (
            None,
            unavailable("kokoro needs espeak-ng for phonemisation and none is on PATH or bundled with piper".into()),
        );
    };
    let installed: Vec<String> = std::fs::read_dir(&paths.voices)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.ends_with(".bin"))
                .collect()
        })
        .unwrap_or_default();
    let pick = match requested_voice {
        Some(want) => installed.iter().find(|f| f.strip_suffix(".bin") == Some(want)).cloned(),
        None => {
            let mut v = installed.clone();
            v.sort();
            v.into_iter().next()
        }
    };
    match pick {
        Some(name) => {
            let file = paths.voices.join(&name);
            let detail = format!("kokoro with {}", file.display());
            (
                Some((paths, file, espeak, data)),
                Availability { kind: ProviderKind::Kokoro, available: true, detail },
            )
        }
        None => (
            None,
            unavailable(match requested_voice {
                Some(v) if installed.is_empty() => format!("no voice '{v}', and no .bin voice at all"),
                Some(v) => format!("no voice '{v}' (installed: {})", installed.join(", ")),
                None => "the model is present but no .bin voice is installed".to_string(),
            }),
        ),
    }
}

// ── Execution ─────────────────────────────────────────────────────────────────────────────────────

/// Spawn a [`SpeechCommand`] and wait for it. Nothing here builds a string a shell would read; the
/// program and every argument are separate values all the way down to `execvp`.
///
/// The child's stderr is CAPTURED and surfaced only if it fails. Speaking is a side effect, not a
/// report: piper logs a voice-load line and a real-time factor on every successful run, and a
/// `bsc say` that prints four lines of engine chatter is unusable from a hook or an automation. The
/// same capture is what makes a failure legible, since the engine's own message is the only thing
/// that says WHY — an exit code alone would be a regression from printing everything.
fn spawn(cmd: &SpeechCommand) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut c = Command::new(&cmd.program);
    c.args(&cmd.args);
    for (k, v) in &cmd.env {
        c.env(k, v);
    }
    c.stdin(if cmd.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    // BOTH streams are captured. `bsc say` produces audio, not text, so nothing a speech engine
    // writes belongs on our stdout — piper announces the wav path there on every successful run,
    // which would corrupt the output of anything piping `bsc say` alongside another command.
    c.stderr(Stdio::piped());
    c.stdout(Stdio::piped());
    let mut child = c
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", cmd.program))?;
    if let Some(text) = &cmd.stdin {
        let mut pipe = child.stdin.take().ok_or("the child took no stdin")?;
        pipe.write_all(text.as_bytes()).map_err(|e| format!("writing to {}: {e}", cmd.program))?;
        // Dropped so the child sees EOF — `say` and `piper` both read to end and would hang without it.
        drop(pipe);
    }
    // `wait_with_output` rather than `wait`: a piped stderr nobody drains can fill its buffer and
    // deadlock a chatty child against a parent that is waiting for it to exit.
    let out = child.wait_with_output().map_err(|e| format!("waiting for {}: {e}", cmd.program))?;
    if !out.status.success() {
        // stderr first: an engine that logs to both puts the diagnosis there and the filename on stdout.
        let said = [out.stderr.as_slice(), b"\n", out.stdout.as_slice()].concat();
        return Err(format!("{} exited with {}{}", cmd.program, out.status, engine_detail(&said)));
    }
    Ok(())
}

/// The engine's own last words, appended to a failure. Trimmed to the final few lines because a
/// crashing synthesizer can emit a great deal and the tail is the part that says what went wrong.
/// Takes the combined streams, since which one carries the diagnosis differs per engine.
fn engine_detail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let tail: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(3).collect();
    if tail.is_empty() {
        return String::new();
    }
    format!(" — {}", tail.into_iter().rev().collect::<Vec<_>>().join(" / "))
}

/// Run a command purely to read its stdout; an unavailable tool is an empty answer, not an error,
/// because `voices` must still render the rest of what it knows.
fn capture(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn system_voice_names(platform: Platform) -> Vec<String> {
    let raw = match platform {
        Platform::Linux => capture("spd-say", &["-L"]),
        Platform::MacOs => capture("say", &["-v", "?"]),
        Platform::Windows => capture(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Speech; \
                 (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | \
                 ForEach-Object { $_.VoiceInfo.Name }",
            ],
        ),
    };
    raw.map(|s| {
        s.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| l.split_whitespace().next().unwrap_or(l).to_string())
            // `spd-say -L` leads with a NAME/LANGUAGE/VARIANT column header, which is not a voice and
            // would otherwise be offered as the first thing you could speak with.
            .filter(|n| n != "NAME")
            .collect()
    })
    .unwrap_or_default()
}

// ── Verbs ─────────────────────────────────────────────────────────────────────────────────────────

fn host_platform() -> Result<Platform, String> {
    Platform::host().ok_or_else(|| {
        format!(
            "no speech support on {} — `bsc say` knows Linux, macOS and Windows",
            std::env::consts::OS
        )
    })
}

fn cmd_speak(a: &Args, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("nothing to say — `bsc say \"some text\"`".into());
    }
    check_channel(a)?;
    let platform = host_platform()?;
    let mut requested = a.provider.as_deref().map(ProviderKind::parse).transpose()?;
    // Blending is a property of style vectors, which only kokoro has. Asking for one is asking for
    // kokoro, and saying so beats silently ignoring the flag on a provider that cannot honour it.
    if a.blend.is_some() {
        match requested {
            Some(ProviderKind::Kokoro) | None => requested = Some(ProviderKind::Kokoro),
            Some(other) => {
                return Err(format!(
                    "--blend mixes kokoro style vectors; the {} provider has none",
                    other.as_str()
                ))
            }
        }
    }
    let chosen_voice = resolve_voice(a);
    let probed = probe(platform, chosen_voice.as_deref());
    let device = resolve_device(a);
    // --verify needs a microphone; the system default is measured-silent on some machines, so it is
    // named explicitly rather than assumed.
    let verify_mic: Option<String> = a.verify.then(|| {
        a.mic.clone().or_else(|| std::env::var("BSC_SAY_MIC").ok()).unwrap_or_else(|| "default".into())
    });
    let res = voice::resolve(requested, probed.considered.clone());
    let req = SayRequest {
        text,
        rate: a.rate.unwrap_or(1.0),
        voice: chosen_voice,
        out: a.out.clone(),
    };
    match res.chosen {
        Some(ProviderKind::Piper) => {
            let (binary, model) = probed.piper.ok_or("piper resolved but its paths went missing")?;
            speak_with_piper(platform, &binary, &model, &req, device.as_deref(), verify_mic.as_deref())
        }
        Some(ProviderKind::Kokoro) => {
            let (paths, voice, espeak, data) =
                probed.kokoro.ok_or("kokoro resolved but its paths went missing")?;
            speak_with_kokoro(platform, &paths, &voice, &espeak, &data, &req, device.as_deref(), a.ipa, a.lang.as_deref().unwrap_or("en-us"), a.blend.as_deref(), verify_mic.as_deref())
        }
        Some(ProviderKind::System) => {
            let cmd = voice::system_command(platform, &req)?;
            spawn(&cmd)
        }
        // The reason already says which provider was asked for, what was missing, and where to look.
        None => Err(res.reason),
    }
}

fn speak_with_piper(
    platform: Platform,
    binary: &std::path::Path,
    model: &std::path::Path,
    req: &SayRequest,
    device: Option<&str>,
    verify_mic: Option<&str>,
) -> Result<(), String> {
    let keep = req.out.is_some();
    let target = match &req.out {
        Some(p) => PathBuf::from(p),
        None => std::env::temp_dir().join(format!("bsc-say-{}.wav", std::process::id())),
    };
    let mut cmd = voice::piper_command(&model.display().to_string(), &target.display().to_string(), req);
    // The probe found the binary; use that path rather than trusting PATH to resolve it identically.
    cmd.program = binary.display().to_string();
    spawn(&cmd)?;
    if keep {
        return Ok(());
    }
    let player = ["aplay", "pw-play", "afplay"]
        .iter()
        .find_map(|p| on_path(p, platform).map(|_| *p))
        .ok_or_else(|| {
            format!(
                "piper wrote {} but nothing on this machine can play it — install aplay, pw-play or \
                 afplay, or use --out to keep the file",
                target.display()
            )
        })?;
    announce_speaking(&target);
    let result = match verify_mic {
        Some(mic) => play_and_verify(platform, player, &target.display().to_string(), device, mic),
        None => spawn(&voice::play_command(platform, player, &target.display().to_string(), device)),
    };
    // A temp wav is ours to clean up whether or not playback worked.
    let _ = std::fs::remove_file(&target);
    result
}

#[allow(clippy::too_many_arguments)]
fn speak_with_kokoro(
    platform: Platform,
    paths: &crate::kokoro::Paths,
    voice_file: &std::path::Path,
    espeak: &std::path::Path,
    espeak_data: &std::path::Path,
    req: &SayRequest,
    device: Option<&str>,
    literal_ipa: bool,
    lang: &str,
    blend: Option<&str>,
    verify_mic: Option<&str>,
) -> Result<(), String> {
    use crate::kokoro;
    let ipa = if literal_ipa {
        req.text.clone()
    } else {
        kokoro::phonemize(espeak, espeak_data, &req.text, lang)?
    };
    let mut voice = kokoro::Voice::load(paths)?;
    let bytes = match blend {
        Some(spec) => blend_bytes(&paths.voices, spec)?,
        None => std::fs::read(voice_file).map_err(|e| format!("{}: {e}", voice_file.display()))?,
    };
    // `speak`, not `speak_ipa`: it chunks to the model's ceiling. Measured before it existed — an
    // ordinary paragraph is 805 phonemes against a 510 limit, and the surplus was dropped silently.
    let (samples, missing) = voice.speak(&ipa, &bytes, voice::clamp_rate(req.rate))?;
    if !missing.chars.is_empty() {
        // Never silent: an unrepresentable phoneme is a mispronunciation, and a mispronunciation
        // gets blamed on the model rather than on the mapping.
        eprintln!(
            "bsc say: {} phoneme(s) had no token and were dropped: {:?}",
            missing.chars.len(),
            missing.chars
        );
    }

    let keep = req.out.is_some();
    let target = match &req.out {
        Some(p) => PathBuf::from(p),
        None => std::env::temp_dir().join(format!("bsc-say-k-{}.wav", std::process::id())),
    };
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: kokoro::SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&target, spec)
        .map_err(|e| format!("could not write {}: {e}", target.display()))?;
    for s in &samples {
        w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).map_err(|e| e.to_string())?;
    }
    w.finalize().map_err(|e| e.to_string())?;
    if keep {
        return Ok(());
    }
    let player = ["aplay", "pw-play", "afplay"]
        .iter()
        .find_map(|p| on_path(p, platform).map(|_| *p))
        .ok_or("nothing on this machine can play audio — use --out to keep the file")?;
    announce_speaking(&target);
    let result = match verify_mic {
        Some(mic) => play_and_verify(platform, player, &target.display().to_string(), device, mic),
        None => spawn(&voice::play_command(platform, player, &target.display().to_string(), device)),
    };
    let _ = std::fs::remove_file(&target);
    result
}

/// Record `ms` from `device` and return its RMS.
///
/// Shells to `arecord` rather than taking a capture dependency: `bsc say` already shells to `aplay`
/// to make sound, and reaching for ALSA in-process to measure it would put the whole audio stack in
/// the build of a crate whose job is to talk.
fn room_level(device: &str, ms: u32) -> Result<f32, String> {
    let tmp = std::env::temp_dir().join(format!("bsc-say-room-{}.wav", std::process::id()));
    let secs = ((ms as f32 / 1000.0).ceil() as u32).max(1);
    let out = std::process::Command::new("arecord")
        .args(["-D", device, "-f", "S16_LE", "-r", "16000", "-c", "1", "-d", &secs.to_string()])
        .arg(&tmp)
        .output()
        .map_err(|e| format!("could not run arecord: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("arecord failed on '{device}': {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let mut r = hound::WavReader::open(&tmp).map_err(|e| format!("{e}"))?;
    let samples: Vec<f32> =
        r.samples::<i16>().filter_map(|s| s.ok()).map(|s| s as f32 / i16::MAX as f32).collect();
    let _ = std::fs::remove_file(&tmp);
    if samples.is_empty() {
        return Err(format!("'{device}' produced no samples"));
    }
    Ok((samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt())
}

/// Play, listen to ourselves, and stop if the room says nobody could have heard it.
///
/// The maintainer's idea, and a better one than muting the ear: what the app can understand of its
/// own voice is EVIDENCE, and the thing it is evidence for is whether speaking is worth doing at
/// all. MEASURED with media in the room — full scale on three speakers, and only sentence tails
/// survived transcription. Loudness had run out; the only remaining move is to notice and stop.
fn play_and_verify(
    platform: Platform,
    player: &str,
    wav: &str,
    device: Option<&str>,
    mic: &str,
) -> Result<(), String> {
    // The room BEFORE we open our mouth. Everything downstream is a comparison against this.
    let ambient = room_level(mic, 400)?;
    let cmd = voice::play_command(platform, player, wav, device);
    let mut child = std::process::Command::new(&cmd.program)
        .args(&cmd.args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", cmd.program))?;
    let during = room_level(mic, 900);
    let verdict = match during {
        Ok(d) => voice::audibility(ambient, d),
        Err(e) => {
            let _ = child.kill();
            return Err(format!("could not measure the room while speaking: {e}"));
        }
    };
    if !verdict.audible {
        // Stop rather than finish a sentence into a void. Playback is a child we own.
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "stopped speaking: the room did not change ({:+.1} dB, ambient {:.4} -> {:.4}). \
             Something louder is playing, and finishing the sentence would only have been \
             technically true.",
            verdict.lift_db, verdict.ambient, verdict.during
        ));
    }
    let status = child.wait().map_err(|e| format!("waiting for {}: {e}", cmd.program))?;
    if !status.success() {
        return Err(format!("{} exited with {status}", cmd.program));
    }
    Ok(())
}

fn cmd_devices(a: &Args) -> Result<(), String> {
    // `--device <name>` doubles as the setter here: `bsc say devices --device X` remembers X.
    if let Some(want) = &a.device {
        let path = device_file().ok_or("no home directory, so nothing could be remembered")?;
        if want == "default" {
            let _ = std::fs::remove_file(&path);
            println!("output reset to the system default");
            return Ok(());
        }
        let known = list_outputs().unwrap_or_default();
        if !known.iter().any(|d| d == want) {
            return Err(format!(
                "'{want}' is not an output aplay knows — `bsc say devices` lists them. Not \
                 remembering a name that will fail at playback time."
            ));
        }
        std::fs::write(&path, want).map_err(|e| format!("could not write {}: {e}", path.display()))?;
        println!("speech will play through {want}");
        return Ok(());
    }

    let all = list_outputs()?;
    let chosen = resolve_device(a);
    let shown: Vec<&String> =
        all.iter().filter(|n| a.all || crate::voice::is_primary_output(n)).collect();
    if a.json || a.pretty {
        let v = json!({ "outputs": shown, "chosen": chosen, "total": all.len() });
        let s = if a.pretty { serde_json::to_string_pretty(&v) } else { serde_json::to_string(&v) };
        println!("{}", s.map_err(|e| format!("could not render: {e}"))?);
        return Ok(());
    }
    for d in &shown {
        let mark = if Some((*d).clone()) == chosen { "*" } else { " " };
        println!("{mark} {d}");
    }
    match &chosen {
        Some(c) => println!("\nspeech plays through: {c}"),
        None => println!("\nspeech plays through the system default — which may not be audible to you"),
    }
    if all.len() > shown.len() {
        println!("{} routing variant(s) hidden — `--all` shows them", all.len() - shown.len());
    }
    Ok(())
}

/// Why `--channel phone` cannot be honoured from a command-line process yet.
///
/// Stated in full rather than as "unsupported", because the reason is structural and a reader
/// deserves to know it is not a missing flag: the tunnel lives in the desktop app's process, and
/// whether a phone is paired is a `client_count` behind a mutex in its `TunnelState`. Nothing is
/// published to disk (the only thing beside this crate's own `say-device` is nothing at all), so a
/// separate process cannot tell a live session from none. `bsc ear` hit the identical wall on the
/// inbound side.
const PHONE_CHANNEL: &str = "--channel phone is not reachable from here yet. The tunnel runs inside \
the desktop app and its session state never leaves that process, so this command cannot tell whether \
a phone is even paired — and playing locally instead would be the wrong room. Use --channel desk (or \
no channel at all) for local playback.";

/// Which DESTINATION a name actually reaches, so aliases of one thing collapse to one entry.
///
/// **MEASURED, after `bsc say all` deadlocked against itself.** `aplay -L` describes `default` as
/// "Default ALSA Output (currently PipeWire Media Server)", `pipewire` as "PipeWire Sound Server"
/// and `sysdefault` as "Default Audio Device" — three names, ONE server. Speaking to all three asks
/// that server to play the same wav three times concurrently, and it blocks forever waiting on
/// itself. Twelve of fourteen children had already exited; the two that hung were both this server.
///
/// The same shape bit the input side first — `bsc ear` documents that ALSA "presents four physical
/// inputs as 27 devices … routing variants of the same card, not choices". This is that lesson
/// applied one layer up, at the sound SERVER rather than the card.
fn destination_key(name: &str) -> String {
    if matches!(name, "default" | "sysdefault" | "pipewire" | "pulse") {
        return "server".into();
    }
    // `plughw:`, `hw:`, `hdmi:`, `front:` are ACCESS PATHS to the same CARD,DEV — the prefix picks
    // how samples get there, not where they end up.
    match name.split_once(':') {
        Some((_, rest)) => rest.to_string(),
        None => name.to_string(),
    }
}

/// Which spelling of one destination to keep: the one most likely to accept our wav.
///
/// `default` over the other server aliases because it is the name a person would type, and
/// `plughw:` over `hw:`/`hdmi:` because plughw converts format and rate, so a 24 kHz mono wav
/// reaches a device that would refuse it raw.
fn output_rank(name: &str) -> u8 {
    if name == "default" {
        0
    } else if name.starts_with("plughw:") {
        1
    } else if name.starts_with("hdmi:") {
        2
    } else {
        3
    }
}

/// The outputs worth speaking to: the real choices, deduplicated by destination.
///
/// Pure so the filter is testable without an audio device, which matters on a machine whose outputs
/// are mostly HDMI sinks nothing is plugged into.
fn eligible_outputs(all: &[String]) -> Vec<String> {
    let mut best: Vec<(String, String)> = Vec::new();
    for n in all.iter().filter(|n| crate::voice::is_primary_output(n)) {
        let key = destination_key(n);
        match best.iter_mut().find(|(k, _)| *k == key) {
            Some((_, chosen)) => {
                if output_rank(n) < output_rank(chosen) {
                    *chosen = n.clone();
                }
            }
            None => best.push((key, n.clone())),
        }
    }
    best.into_iter().map(|(_, n)| n).collect()
}

/// Wait for a child, but never forever.
///
/// DEFENCE IN DEPTH, separate from the alias fix. Collapsing aliases removes the deadlock I actually
/// hit; this removes the whole CLASS — a sink that is busy, unplugged or wedged can block `aplay`
/// indefinitely, and one such device must not hold the whole room hostage. Polled rather than
/// blocking because std has no waiting primitive with a deadline.
fn wait_bounded(child: &mut std::process::Child, deadline: std::time::Instant) -> Result<bool, String> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("timed out — the device never finished (busy, or nothing attached)".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("could not wait: {e}")),
        }
    }
}

/// How long a single output may take beyond the audio's own length before it is given up on.
const PLAYBACK_GRACE_SECS: u64 = 10;

/// Refuse a channel this build cannot honour, rather than quietly playing somewhere else.
fn check_channel(a: &Args) -> Result<(), String> {
    match a.channel.as_deref() {
        None | Some("desk") => Ok(()),
        Some("phone") => Err(PHONE_CHANNEL.into()),
        Some(other) => Err(format!("unknown channel '{other}' — the destinations are desk and phone")),
    }
}

/// Speak on every eligible output at once.
fn cmd_say_all(a: &Args, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("nothing to say — `bsc say all \"some text\"`".into());
    }
    check_channel(a)?;
    let platform = host_platform()?;

    // SYNTHESIZE ONCE, through the ordinary speak path so provider selection, voice resolution and
    // blending behave identically to a single-device `bsc say`. Both providers return as soon as the
    // wav is written when `out` is set, so this renders without playing anything.
    let tmp = std::env::temp_dir().join(format!("bsc-say-all-{}.wav", std::process::id()));
    let mut synth = a.clone();
    synth.out = Some(tmp.display().to_string());
    synth.verify = false; // verification listens to ONE device; it means nothing across a fan-out
    cmd_speak(&synth, text)?;

    let targets = eligible_outputs(&list_outputs()?);
    if targets.is_empty() {
        let _ = std::fs::remove_file(&tmp);
        return Err("no eligible output — `bsc say devices --all` shows what aplay reported".into());
    }
    let player = ["aplay", "pw-play", "afplay"]
        .iter()
        .find_map(|p| on_path(p, platform).map(|_| *p))
        .ok_or("nothing on this machine can play audio — use --out to keep the file")?;

    // ONE utterance, ONE latch. The flag carries a DEADLINE derived from the wav's duration, and
    // that duration is the same on every output, so writing it per device would be N writes of the
    // same instant rather than anything more accurate.
    announce_speaking(&tmp);

    // START EVERY CHILD BEFORE WAITING ON ANY. `spawn` waits to completion by design, so reusing it
    // here would serialize the room instead of filling it.
    let wav = tmp.display().to_string();
    // The deadline is the audio's own length plus a grace, so a long passage is not cut off while a
    // wedged device still cannot hold the command open.
    let secs = hound::WavReader::open(&tmp)
        .ok()
        .map(|r| r.duration() as f64 / r.spec().sample_rate.max(1) as f64)
        .unwrap_or(0.0);
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs_f64(secs)
        + std::time::Duration::from_secs(PLAYBACK_GRACE_SECS);

    // Stdio is NULL here, unlike the single-device path. `aplay -q` says nothing useful, and piping
    // N children means N buffers that must each be drained before the process they belong to can
    // exit — which is precisely the deadlock shape this command already walked into once.
    let mut running = Vec::new();
    for dev in &targets {
        let cmd = crate::voice::play_command(platform, player, &wav, Some(dev));
        let child = std::process::Command::new(&cmd.program)
            .args(&cmd.args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        running.push((dev.clone(), child));
    }

    let (mut opened, mut refused) = (Vec::new(), Vec::new());
    for (dev, child) in running {
        match child {
            Ok(mut c) => match wait_bounded(&mut c, deadline) {
                Ok(true) => opened.push(dev),
                Ok(false) => refused.push((dev, format!("{player} exited non-zero"))),
                Err(e) => refused.push((dev, e)),
            },
            Err(e) => refused.push((dev, format!("could not run {player}: {e}"))),
        }
    }
    let _ = std::fs::remove_file(&tmp);

    if a.json || a.pretty {
        let v = json!({
            "opened": opened,
            "refused": refused.iter().map(|(d, e)| json!({ "device": d, "error": e })).collect::<Vec<_>>(),
            "eligible": targets.len(),
        });
        let s = if a.pretty { serde_json::to_string_pretty(&v) } else { serde_json::to_string(&v) };
        println!("{}", s.map_err(|e| format!("could not render: {e}"))?);
    } else {
        for d in &opened {
            println!("  spoke on {d}");
        }
        for (d, e) in &refused {
            println!("  {d} refused — {e}");
        }
        println!(
            "\n{} of {} eligible output(s) played it. That they OPENED is all this can tell you — \
             whether anyone heard it is not measurable from here.",
            opened.len(),
            targets.len()
        );
    }
    // Partial success is still speech in the room, so one busy sink does not fail the command.
    // Nothing playing anywhere is a different matter.
    if opened.is_empty() {
        return Err("no output accepted the audio — every eligible one refused".into());
    }
    Ok(())
}

fn cmd_voice(a: &Args) -> Result<(), String> {
    let path = voice_file().ok_or("no home directory, so nothing could be remembered")?;
    match a.positional.get(1) {
        Some(name) => {
            std::fs::write(&path, name).map_err(|e| format!("could not write {}: {e}", path.display()))?;
            println!("speech will use {name}");
        }
        None => match remembered_voice() {
            Some(v) => println!("{v}"),
            None => println!("no remembered voice — whichever sorts first is used"),
        },
    }
    Ok(())
}

/// Publish a speaking deadline so `bsc ear` declines to record what we are about to say.
///
/// DEMONSTRATED before this existed: one announcement produced five captured segments, two of which
/// transcribed as the app's own words. Always-on capture plus a speaking app is a loop.
///
/// The deadline covers the audio PLUS a tail, because playback ends when the file ends and the room
/// keeps ringing — the tail is exactly what gets captured as a stray fragment. Best-effort
/// throughout: a failure to write it must never stop the app speaking.
fn announce_speaking(wav: &std::path::Path) {
    let Some(path) = bsc_util::speaking_flag_path() else { return };
    let secs = hound::WavReader::open(wav)
        .ok()
        .map(|r| r.duration() as f64 / r.spec().sample_rate.max(1) as f64)
        .unwrap_or(0.0);
    let until = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
        + (secs * 1000.0) as i64
        + REVERB_TAIL_MS;
    let _ = std::fs::write(path, until.to_string());
}

/// How long the room keeps ringing after playback stops.
///
/// A GUESS WITH A MEASUREMENT BEHIND IT, and it should become a measured value: the Scarlett heard
/// monitor output across the desk at peak 0.19, so the path is loud enough for a tail to matter.
/// Too short and a fragment of our own voice still lands; too long and the user's first words after
/// an announcement are swallowed.
const REVERB_TAIL_MS: i64 = 400;

/// Load and mix the voices a blend names.
fn blend_bytes(dir: &std::path::Path, spec: &str) -> Result<Vec<u8>, String> {
    let parts = crate::kokoro::parse_blend(spec)?;
    let mut sources = Vec::new();
    for c in &parts {
        let path = dir.join(format!("{}.bin", c.voice));
        let bytes = std::fs::read(&path).map_err(|_| {
            format!("no voice '{}' to blend — `bsc say voices` lists what is installed", c.voice)
        })?;
        sources.push((bytes, c.weight));
    }
    crate::kokoro::blend_voices(&sources)
}

fn cmd_voices(a: &Args) -> Result<(), String> {
    let platform = host_platform()?;
    let probed = probe(platform, a.voice.as_deref());
    let res: Resolution = voice::resolve(None, probed.considered.clone());
    let piper_voices = installed_voice_files();
    let system_voices = if probed.system.is_some() { system_voice_names(platform) } else { vec![] };
    let dir = voice_dir().map(|d| d.display().to_string()).unwrap_or_else(|| "<no home>".into());

    if a.json || a.pretty {
        let v = json!({
            "platform": platform,
            "voiceDir": dir,
            "considered": res.considered,
            "chosen": res.chosen,
            "reason": res.reason,
            "piperVoices": piper_voices,
            "systemVoices": system_voices,
        });
        // Printed here rather than through a shared helper: the helpers live in bsc-sqlite-util,
        // and taking rusqlite as a dependency to format two lines of JSON would put a C library in
        // the iteration loop of a crate that has no store.
        let rendered = if a.pretty {
            serde_json::to_string_pretty(&v)
        } else {
            serde_json::to_string(&v)
        }
        .map_err(|e| format!("could not render the report: {e}"))?;
        println!("{rendered}");
        return Ok(());
    }

    println!("platform     {platform:?}");
    println!("voice dir    {dir}");
    println!();
    for c in &res.considered {
        println!("  {:<7} {:<14} {}", c.kind.as_str(), if c.available { "available" } else { "unavailable" }, c.detail);
    }
    println!();
    match res.chosen {
        // The reason already opens with the provider name, so it is not repeated here.
        Some(_) => println!("would speak with: {}", res.reason),
        None => println!("would NOT speak: {}", res.reason),
    }
    if !piper_voices.is_empty() {
        println!("\npiper voices ({}):", piper_voices.len());
        for v in &piper_voices {
            println!("  {v}");
        }
    }
    if !system_voices.is_empty() {
        let shown = system_voices.len().min(12);
        println!("\nsystem voices ({}, first {shown}):", system_voices.len());
        for v in system_voices.iter().take(shown) {
            println!("  {v}");
        }
    }
    Ok(())
}

/// `speak` is a real verb AND the bare form is the ordinary one, so the word "speak" alone is
/// genuinely ambiguous. Refuse it by name rather than guessing — a guess is silently wrong exactly
/// once and then the user never trusts either form.
const SPEAK_ALONE: &str =
    "`bsc say speak` on its own is ambiguous — the verb with nothing to say, or the word \"speak\"? \
     Write `bsc say speak speak` for the word, or `bsc say speak \"...\"` for the verb.";

/// Split at the first bare `--`: everything after it is TEXT, whatever it looks like.
///
/// The shared `args::walk` refuses `--` as an unknown flag, and rightly — it cannot change that
/// without changing every other CLI in the binary. But `say` is the one command whose main argument
/// is arbitrary prose, so text beginning with `--` ("--force is dangerous") is a real thing to want
/// to speak, and the POSIX terminator is what a person types to get it. Handled here, for this
/// command only.
fn split_at_terminator(argv: Vec<String>) -> (Vec<String>, Option<String>) {
    match argv.iter().position(|a| a == "--") {
        Some(i) => (argv[..i].to_vec(), Some(argv[i + 1..].join(" "))),
        None => (argv, None),
    }
}

pub fn run(argv: Vec<String>, prog: &str) -> Result<(), String> {
    let (argv, literal) = split_at_terminator(argv);
    let a = parse_args(argv)?;
    // Checked BEFORE help, so `bsc say -- help` speaks the word rather than printing the menu — the
    // whole point of the terminator is that what follows it is not interpreted.
    if let Some(text) = literal {
        return cmd_speak(&a, text);
    }
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &a.positional) {
        return Ok(());
    }
    match a.positional.first().map(String::as_str) {
        Some("devices") => cmd_devices(&a),
        Some("voice") => cmd_voice(&a),
        Some("voices") => cmd_voices(&a),
        Some("all") if a.positional.len() == 1 => {
            Err("nothing to say — `bsc say all \"some text\"`".into())
        }
        Some("all") => cmd_say_all(&a, a.positional[1..].join(" ")),
        Some("speak") if a.positional.len() == 1 => Err(SPEAK_ALONE.into()),
        Some("speak") => cmd_speak(&a, a.positional[1..].join(" ")),
        // Everything else IS the text. `say` is the one CLI here whose main argument is free prose,
        // so an unknown-verb refusal would make the common form the broken one.
        Some(_) => cmd_speak(&a, a.positional.join(" ")),
        None => Err("nothing to say — `bsc say \"some text\"`".into()),
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
        assert_eq!(names, vec!["speak", "all", "devices", "voice", "voices"]);
    }

    /// `all` speaks to the real choices, not to one card listed eight ways.
    ///
    /// ALSA presents four physical outputs as a long list of routing variants, so fanning out over
    /// the raw listing would play the same speaker repeatedly while looking thorough. The fixture is
    /// this machine's actual `aplay -L` output.
    #[test]
    fn eligible_outputs_keeps_the_real_choices_and_drops_the_routing_variants() {
        let listed: Vec<String> = [
            "sysdefault",
            "pipewire",
            "default",
            "plughw:CARD=USB,DEV=0",
            "hdmi:CARD=HDMI,DEV=0",
            "plughw:CARD=Generic,DEV=0",
            "surround51:CARD=HDMI,DEV=0",
            "iec958:CARD=HDMI,DEV=0",
            "dsnoop:CARD=USB,DEV=0",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        let got = eligible_outputs(&listed);
        assert!(got.contains(&"default".to_string()));
        assert!(got.contains(&"plughw:CARD=USB,DEV=0".to_string()));
        assert!(got.contains(&"hdmi:CARD=HDMI,DEV=0".to_string()));
        for variant in ["surround51:CARD=HDMI,DEV=0", "iec958:CARD=HDMI,DEV=0", "dsnoop:CARD=USB,DEV=0"] {
            assert!(!got.contains(&variant.to_string()), "{variant} is a routing variant, not a choice");
        }
        assert!(!got.is_empty(), "a machine with outputs must yield some");
    }

    /// THE DEADLOCK THIS EXISTS TO PREVENT, pinned as a test rather than as a memory.
    ///
    /// `default`, `sysdefault` and `pipewire` are three names for ONE sound server — `aplay -L` says
    /// so itself. Speaking to all three asked that server to play the same wav concurrently and it
    /// blocked forever waiting on itself; the command had to be killed. A regression here would hang
    /// `bsc say all` again, silently, on any machine running PipeWire or PulseAudio.
    #[test]
    fn every_name_for_one_sound_server_collapses_to_a_single_destination() {
        let listed: Vec<String> =
            ["sysdefault", "pipewire", "default", "pulse", "plughw:CARD=USB,DEV=0"]
                .iter()
                .map(|s| s.to_string())
                .collect();

        let got = eligible_outputs(&listed);
        let servers: Vec<&String> =
            got.iter().filter(|n| matches!(n.as_str(), "default" | "sysdefault" | "pipewire" | "pulse")).collect();
        assert_eq!(servers.len(), 1, "one server, one entry — got {got:?}");
        assert_eq!(servers[0], "default", "`default` is the spelling a person would type");
        assert!(got.contains(&"plughw:CARD=USB,DEV=0".to_string()), "real hardware is untouched");
        assert_eq!(got.len(), 2, "one server + one card = two destinations, not five");
    }

    /// Two access paths to one card are one destination, and the converting one wins.
    #[test]
    fn access_paths_to_one_card_collapse_and_plughw_is_preferred() {
        let listed: Vec<String> =
            ["hdmi:CARD=HDMI,DEV=3", "plughw:CARD=HDMI,DEV=3", "plughw:CARD=Generic,DEV=0"]
                .iter()
                .map(|s| s.to_string())
                .collect();

        let got = eligible_outputs(&listed);
        assert_eq!(got.len(), 2, "one HDMI device + one Generic card — got {got:?}");
        assert!(
            got.contains(&"plughw:CARD=HDMI,DEV=3".to_string()),
            "plughw converts rate and format, so it accepts a wav that hdmi: would refuse: {got:?}"
        );
        assert!(!got.contains(&"hdmi:CARD=HDMI,DEV=3".to_string()));
    }

    /// A channel names a DESTINATION, and one of them is not reachable from a CLI process.
    #[test]
    fn an_unreachable_channel_refuses_with_the_reason_rather_than_playing_locally() {
        let desk = Args { channel: Some("desk".into()), ..Args::default() };
        assert!(check_channel(&desk).is_ok());
        assert!(check_channel(&Args::default()).is_ok(), "no channel is the ordinary local case");

        let phone = Args { channel: Some("phone".into()), ..Args::default() };
        let e = check_channel(&phone).expect_err("phone must refuse, not fall back to the speakers");
        assert!(e.contains("tunnel"), "the refusal must say WHY, not just that it failed: {e}");

        let nonsense = Args { channel: Some("kitchen".into()), ..Args::default() };
        let e = check_channel(&nonsense).expect_err("an unknown channel is a typo, not a default");
        assert!(e.contains("desk") && e.contains("phone"), "name the destinations that exist: {e}");
    }

    #[test]
    fn help_renders_without_touching_an_audio_device() {
        assert!(run(vec!["help".into()], "bsc say").is_ok());
        assert!(run(vec!["speak".into(), "help".into()], "bsc say").is_ok());
    }

    /// No arguments prints help, as every CmdDoc-driven CLI in this repo does — `handle_help` claims
    /// the empty line before the verb match sees it, and there is nothing to say anyway. Text that is
    /// only whitespace DID reach us and is refused, rather than spawning an engine to speak nothing.
    #[test]
    fn a_blank_line_prints_help_and_whitespace_text_is_refused() {
        assert!(run(vec![], "bsc say").is_ok(), "no args is the help case");
        let e = run(vec!["   ".into()], "bsc say").unwrap_err();
        assert!(e.contains("nothing to say"), "{e}");
    }

    #[test]
    fn the_ambiguous_bare_verb_is_refused_by_name() {
        let e = run(vec!["speak".into()], "bsc say").unwrap_err();
        assert!(e.contains("ambiguous"), "{e}");
        assert!(e.contains("speak speak"), "the refusal must be actionable: {e}");
    }

    #[test]
    fn an_unknown_provider_is_refused_before_anything_is_probed() {
        let e = run(vec!["hello".into(), "--provider".into(), "espeak".into()], "bsc say").unwrap_err();
        assert!(e.contains("espeak"), "{e}");
    }

    #[test]
    fn a_non_numeric_rate_is_refused_with_the_unit_named() {
        let e = parse_args(vec!["hi".into(), "--rate".into(), "fast".into()]).unwrap_err();
        assert!(e.contains("1.0 being normal"), "{e}");
    }

    /// Everything after `--` is text, including things that look exactly like flags and verbs. The
    /// walker refuses a bare `--`, so without this the ordinary POSIX escape hatch is simply broken
    /// on the one command that most needs it.
    #[test]
    fn everything_after_the_terminator_is_text_however_it_looks() {
        let (argv, text) = split_at_terminator(vec![
            "--rate".into(), "2".into(), "--".into(), "--force".into(), "is".into(), "dangerous".into(),
        ]);
        assert_eq!(argv, vec!["--rate".to_string(), "2".into()], "flags before it still parse");
        assert_eq!(text.as_deref(), Some("--force is dangerous"));

        let (_, text) = split_at_terminator(vec!["--".into(), "help".into()]);
        assert_eq!(text.as_deref(), Some("help"), "even a word the scaffold would claim");

        let (argv, text) = split_at_terminator(vec!["plain".into()]);
        assert_eq!(argv, vec!["plain".to_string()]);
        assert_eq!(text, None, "no terminator, no literal");
    }

    #[test]
    fn bare_words_become_one_line_of_text() {
        let a = parse_args(vec!["the".into(), "gate".into(), "went".into(), "red".into()]).unwrap();
        assert_eq!(a.positional.join(" "), "the gate went red");
    }

    /// Windows resolves an `.exe`; the other two do not invent one. Asserted here, on Linux, because
    /// a `cfg!`-gated version of this would only ever run on the platform it is not testing.
    #[test]
    fn a_windows_lookup_tries_the_exe_and_the_others_do_not() {
        let dir = std::env::temp_dir().join(format!("bsc-say-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("piper.exe");
        std::fs::write(&exe, b"stub").unwrap();
        let dirs = vec![dir.clone()];
        assert_eq!(find_in(&dirs, "piper", Platform::Windows), Some(exe));
        assert_eq!(find_in(&dirs, "piper", Platform::Linux), None, "no .exe fallback off Windows");
        assert_eq!(find_in(&dirs, "nothing", Platform::Windows), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A successful speak must be SILENT, so the engine's chatter is only ever attached to a failure
    /// — and when there is a failure, the engine's own words are the only thing that says why.
    #[test]
    fn engine_output_is_kept_for_failures_and_is_empty_when_there_is_nothing_to_say() {
        assert_eq!(engine_detail(b""), "", "nothing to report adds nothing");
        assert_eq!(engine_detail(b"   \n \n"), "", "blank lines are not a message");
        let d = engine_detail(b"loading\nmodel missing: en_US.onnx\n");
        assert!(d.starts_with(" — "), "{d}");
        assert!(d.contains("model missing"), "{d}");
        // Only the tail survives, in order, so a chatty engine cannot bury its own last words.
        let many: Vec<String> = (1..=10).map(|i| format!("line{i}")).collect();
        let d = engine_detail(many.join("\n").as_bytes());
        assert!(d.contains("line8 / line9 / line10"), "tail, in order: {d}");
        assert!(!d.contains("line1 "), "the head is dropped: {d}");
    }

    /// The order matters and nothing else asserts it: a one-off `--device` must beat the
    /// environment, and the environment must beat a choice remembered months ago. Getting this
    /// backwards means a flag that appears to do nothing.
    #[test]
    fn an_explicit_device_beats_the_environment_which_beats_what_was_remembered() {
        let a = Args { device: Some("explicit".into()), ..Args::default() };
        std::env::set_var(DEVICE_ENV, "from-env");
        assert_eq!(resolve_device(&a).as_deref(), Some("explicit"));

        let bare = Args::default();
        assert_eq!(resolve_device(&bare).as_deref(), Some("from-env"), "env is next");

        std::env::remove_var(DEVICE_ENV);
        // With neither, it falls through to the remembered file or the system default; both are
        // acceptable here, and what matters is that it does not return the env value we just
        // cleared.
        assert_ne!(resolve_device(&bare).as_deref(), Some("from-env"));
    }

    #[test]
    fn the_voice_dir_is_overridable_so_a_test_never_reads_the_real_one() {
        let want = std::env::temp_dir().join("bsc-say-voices-fixture");
        std::env::set_var(VOICE_DIR_ENV, &want);
        assert_eq!(voice_dir(), Some(want));
        std::env::remove_var(VOICE_DIR_ENV);
    }
}
