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

WHICH ENGINE ANSWERS IS PROBED, NOT CONFIGURED. Piper when its binary and a voice both resolve,
otherwise the OS speech service, and if you named one with --provider it is honoured or refused —
never quietly swapped for the other. `bsc say voices` reports what was found and what was not.",
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

#[derive(Default, Debug)]
struct Args {
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

/// What actually resolved on this machine.
struct Probed {
    considered: Vec<Availability>,
    /// (piper binary, model path) when both halves are present.
    piper: Option<(PathBuf, PathBuf)>,
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
    Probed { considered: vec![piper_avail, system_avail], piper, system }
}

// ── Execution ─────────────────────────────────────────────────────────────────────────────────────

/// Spawn a [`SpeechCommand`] and wait for it. Nothing here builds a string a shell would read; the
/// program and every argument are separate values all the way down to `execvp`.
fn spawn(cmd: &SpeechCommand) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut c = Command::new(&cmd.program);
    c.args(&cmd.args);
    for (k, v) in &cmd.env {
        c.env(k, v);
    }
    c.stdin(if cmd.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = c
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", cmd.program))?;
    if let Some(text) = &cmd.stdin {
        let mut pipe = child.stdin.take().ok_or("the child took no stdin")?;
        pipe.write_all(text.as_bytes()).map_err(|e| format!("writing to {}: {e}", cmd.program))?;
        // Dropped so the child sees EOF — `say` and `piper` both read to end and would hang without it.
        drop(pipe);
    }
    let status = child.wait().map_err(|e| format!("waiting for {}: {e}", cmd.program))?;
    if !status.success() {
        return Err(format!("{} exited with {status}", cmd.program));
    }
    Ok(())
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
    let platform = host_platform()?;
    let requested = a.provider.as_deref().map(ProviderKind::parse).transpose()?;
    let probed = probe(platform, a.voice.as_deref());
    let res = voice::resolve(requested, probed.considered.clone());
    let req = SayRequest {
        text,
        rate: a.rate.unwrap_or(1.0),
        voice: a.voice.clone(),
        out: a.out.clone(),
    };
    match res.chosen {
        Some(ProviderKind::Piper) => {
            let (binary, model) = probed.piper.ok_or("piper resolved but its paths went missing")?;
            speak_with_piper(platform, &binary, &model, &req)
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
    let result = spawn(&voice::play_command(platform, player, &target.display().to_string()));
    // A temp wav is ours to clean up whether or not playback worked.
    let _ = std::fs::remove_file(&target);
    result
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
        Some("voices") => cmd_voices(&a),
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
        assert_eq!(names, vec!["speak", "voices"]);
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

    #[test]
    fn the_voice_dir_is_overridable_so_a_test_never_reads_the_real_one() {
        let want = std::env::temp_dir().join("bsc-say-voices-fixture");
        std::env::set_var(VOICE_DIR_ENV, &want);
        assert_eq!(voice_dir(), Some(want));
        std::env::remove_var(VOICE_DIR_ENV);
    }
}
