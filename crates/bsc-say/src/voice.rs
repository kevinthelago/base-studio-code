//! The PURE half of `bsc say` — everything that decides WHAT to run, and nothing that runs it.
//!
//! The split is here because the failures worth catching are not audio failures. They are: choosing a
//! provider that is not installed, mapping one rate vocabulary onto four engines that each mean
//! something different by it, and — the one that would actually hurt — letting spoken text reach a
//! shell. None of those need a sound card to observe, so none of them are tested with one.

use serde::Serialize;

/// The OS whose speech tooling a command is being built for. Carried as an argument rather than read
/// from `cfg!` inside the builders, so the Windows and macOS shapes are unit-tested ON LINUX. A
/// `cfg!`-gated builder is only ever exercised on the machine that compiles it, which for this repo
/// means the Windows path would ship having never once been asserted.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Linux,
    MacOs,
    Windows,
}

impl Platform {
    /// The platform this binary is running on, or `None` where we have no speech story (BSD, etc.) —
    /// reported as absent rather than guessed at, since a wrong guess here is a failed exec.
    pub fn host() -> Option<Platform> {
        match std::env::consts::OS {
            "linux" => Some(Platform::Linux),
            "macos" => Some(Platform::MacOs),
            "windows" => Some(Platform::Windows),
            _ => None,
        }
    }

    /// The binary the system provider drives here.
    pub const fn system_program(self) -> &'static str {
        match self {
            Platform::Linux => "spd-say",
            Platform::MacOs => "say",
            Platform::Windows => "powershell",
        }
    }
}

/// Which engine speaks. Two, deliberately: a floor that is already installed everywhere, and a good
/// voice that has to be brought in.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// The OS speech service — `spd-say` (speech-dispatcher), macOS `say`, Windows `System.Speech`.
    /// Robotic on Linux, decent on Windows, good on macOS. Its virtue is that it is THERE.
    System,
    /// Piper: neural (VITS over ONNX Runtime), MIT, offline, voices of 20-60MB that synthesize
    /// several times faster than realtime on CPU.
    Piper,
}

impl ProviderKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            ProviderKind::System => "system",
            ProviderKind::Piper => "piper",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "system" => Ok(ProviderKind::System),
            "piper" => Ok(ProviderKind::Piper),
            other => Err(format!("unknown provider '{other}' — expected 'system' or 'piper'")),
        }
    }
}

// ── Rate ──────────────────────────────────────────────────────────────────────────────────────────
//
// ONE vocabulary at the surface: a multiplier where 1.0 is normal, matching Web Speech's `rate` —
// which is what the app's existing `ttsRate` setting already holds. So the frontend hands its stored
// value straight over and nothing translates at the boundary. Each engine's own scale is an
// implementation detail mapped here, and they disagree wildly: one is a signed percentage, one is
// words per minute, one is a small signed integer, and piper's is INVERTED.

/// Web Speech's floor and ceiling, adopted so a value the UI accepts is a value this accepts.
pub const MIN_RATE: f32 = 0.1;
pub const MAX_RATE: f32 = 10.0;
/// macOS `say`'s default words-per-minute, the anchor its multiplier scales.
pub const MACOS_DEFAULT_WPM: f32 = 175.0;

/// Clamp a caller's multiplier into the supported band. A non-finite value (a parsed `NaN`, an
/// overflowed literal) becomes normal speed rather than propagating into an engine flag, because
/// every downstream cast of `NaN` is 0 — which reads as a legitimate "normal" on two of the four
/// scales and as "as slow as possible" on a third.
pub fn clamp_rate(m: f32) -> f32 {
    if !m.is_finite() {
        return 1.0;
    }
    m.clamp(MIN_RATE, MAX_RATE)
}

/// `spd-say -r`: a signed percentage, -100..100, 0 being normal.
pub fn spd_say_rate(m: f32) -> i32 {
    (((clamp_rate(m) - 1.0) * 100.0).round() as i32).clamp(-100, 100)
}

/// `say -r`: words per minute around a 175 default.
pub fn macos_wpm(m: f32) -> i32 {
    (MACOS_DEFAULT_WPM * clamp_rate(m)).round().clamp(1.0, 2000.0) as i32
}

/// `System.Speech`'s `Rate`: a small signed integer, -10..10, 0 being normal.
pub fn sapi_rate(m: f32) -> i32 {
    (((clamp_rate(m) - 1.0) * 10.0).round() as i32).clamp(-10, 10)
}

/// Piper's `--length_scale` stretches each phoneme, so it runs the OTHER WAY: a bigger number is
/// SLOWER. Getting this backwards is silent — the audio is fine, just wrong — which is why it is a
/// named function with a test rather than an inline reciprocal at the call site.
pub fn piper_length_scale(m: f32) -> f32 {
    1.0 / clamp_rate(m)
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────

/// A process to spawn: never a shell line. There is no field here that a shell would parse, and that
/// is the entire point of the type — see [`SpeechCommand::carries_text_safely`].
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct SpeechCommand {
    pub program: String,
    pub args: Vec<String>,
    /// Text handed over on the child's stdin. Preferred wherever the tool reads it, because a value
    /// on stdin cannot be confused with a flag no matter what it starts with.
    pub stdin: Option<String>,
    /// Environment for the child. This is how a VOICE NAME reaches PowerShell: interpolating a name
    /// into a `-Command` script would put user-supplied text into something that IS parsed.
    pub env: Vec<(String, String)>,
}

impl SpeechCommand {
    /// Whether `text` reaches the child only as data — on stdin, or as a whole argv element — and
    /// never embedded inside a larger string that something downstream will parse.
    ///
    /// Exists as a method rather than as an assertion inlined into one test so that EVERY builder is
    /// checked by the same definition, including builders added later.
    pub fn carries_text_safely(&self, text: &str) -> bool {
        if text.is_empty() {
            return true;
        }
        if self.stdin.as_deref() == Some(text) {
            return !self.program.contains(text) && !self.args.iter().any(|a| a.contains(text));
        }
        // Otherwise it must be exactly one argv element, and appear nowhere else.
        let whole = self.args.iter().filter(|a| a.as_str() == text).count();
        let partial = self.args.iter().filter(|a| a.contains(text) && a.as_str() != text).count();
        whole == 1 && partial == 0 && !self.program.contains(text)
    }
}

/// What the caller asked for, before any provider has been chosen.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct SayRequest {
    pub text: String,
    /// Rate multiplier; 1.0 is normal. Clamped by every consumer, so an unvalidated value is safe.
    pub rate: f32,
    pub voice: Option<String>,
    /// Write a wav here instead of playing. Piper only — see [`system_command`].
    pub out: Option<String>,
}

/// The PowerShell script the Windows system provider runs. The text is read from stdin and the voice
/// from the environment, so NOTHING the user supplied is interpolated into it — only `rate`, which is
/// an `i32` this crate computed. Written as a template with exactly one hole for that reason.
fn windows_script(rate: i32) -> String {
    format!(
        "Add-Type -AssemblyName System.Speech; \
         $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         $s.Rate = {rate}; \
         if ($env:BSC_SAY_VOICE) {{ $s.SelectVoice($env:BSC_SAY_VOICE) }}; \
         $s.Speak([Console]::In.ReadToEnd())"
    )
}

/// The env var the Windows script reads a voice name from.
pub const WINDOWS_VOICE_ENV: &str = "BSC_SAY_VOICE";

/// Build the OS-speech-service command for `platform`.
///
/// Refuses `--out`: of the three system tools only macOS `say` can write a file, and a flag that
/// works on one platform in three is worse than one that does not exist — the person who tries it on
/// Linux learns nothing from silence. File output is piper's job, and the refusal says so.
pub fn system_command(platform: Platform, req: &SayRequest) -> Result<SpeechCommand, String> {
    if req.out.is_some() {
        return Err(
            "--out needs the piper provider — the OS speech services cannot all write a file, so \
             `bsc say` does not pretend they can. Install a piper voice (`bsc say voices` says where) \
             or drop --out to speak aloud."
                .into(),
        );
    }
    Ok(match platform {
        Platform::Linux => {
            let mut args = vec!["--wait".into(), "--rate".into(), spd_say_rate(req.rate).to_string()];
            if let Some(v) = &req.voice {
                args.push("--synthesis-voice".into());
                args.push(v.clone());
            }
            // `--` so text beginning with a dash is text, not a flag getopt will reject.
            args.push("--".into());
            args.push(req.text.clone());
            SpeechCommand { program: "spd-say".into(), args, stdin: None, env: vec![] }
        }
        Platform::MacOs => {
            let mut args = vec!["-r".into(), macos_wpm(req.rate).to_string()];
            if let Some(v) = &req.voice {
                args.push("-v".into());
                args.push(v.clone());
            }
            // No file argument and no string argument: `say` reads the text from stdin.
            SpeechCommand {
                program: "say".into(),
                args,
                stdin: Some(req.text.clone()),
                env: vec![],
            }
        }
        Platform::Windows => SpeechCommand {
            program: "powershell".into(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                windows_script(sapi_rate(req.rate)),
            ],
            stdin: Some(req.text.clone()),
            env: match &req.voice {
                Some(v) => vec![(WINDOWS_VOICE_ENV.to_string(), v.clone())],
                None => vec![],
            },
        },
    })
}

/// Build the piper command. Text on stdin; audio to `out`, which the caller either asked for or
/// picked as a temp path to play and discard.
pub fn piper_command(model: &str, out: &str, req: &SayRequest) -> SpeechCommand {
    SpeechCommand {
        program: "piper".into(),
        args: vec![
            "--model".into(),
            model.to_string(),
            "--output_file".into(),
            out.to_string(),
            "--length_scale".into(),
            format!("{:.4}", piper_length_scale(req.rate)),
        ],
        stdin: Some(req.text.clone()),
        env: vec![],
    }
}

/// Play a finished wav. Separate from synthesis because piper writes a file and something else has to
/// make noise with it — and on Linux which player exists varies, so the caller probes.
pub fn play_command(platform: Platform, player: &str, wav: &str) -> SpeechCommand {
    let args = match platform {
        // `-q` on aplay; pw-play and afplay take the path alone. Kept uniform: the path is the last
        // element in every case, which is what the tests assert.
        Platform::Linux if player == "aplay" => vec!["-q".into(), wav.to_string()],
        Platform::Linux | Platform::MacOs | Platform::Windows => vec![wav.to_string()],
    };
    SpeechCommand { program: player.into(), args, stdin: None, env: vec![] }
}

// ── Resolution ────────────────────────────────────────────────────────────────────────────────────

/// One provider's verdict, with the reason attached. The reason is not decoration: a provider that
/// silently did not answer is the failure this whole struct exists to prevent.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Availability {
    pub kind: ProviderKind,
    pub available: bool,
    /// Where it was found, or precisely what was missing.
    pub detail: String,
}

/// Which provider will speak, and why the others will not.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Resolution {
    pub chosen: Option<ProviderKind>,
    pub reason: String,
    pub considered: Vec<Availability>,
}

/// Choose a provider from what is actually installed.
///
/// Capability-probed rather than configured, because a configured default is a promise the machine
/// may not be able to keep — and the failure mode of the alternative is a setting that silently means
/// nothing. An EXPLICIT `--provider` is never quietly substituted: asking for piper and getting the
/// robot voice without being told is worse than being refused.
pub fn resolve(requested: Option<ProviderKind>, considered: Vec<Availability>) -> Resolution {
    let find = |k: ProviderKind| considered.iter().find(|a| a.kind == k);
    if let Some(want) = requested {
        return match find(want) {
            Some(a) if a.available => Resolution {
                chosen: Some(want),
                reason: format!("--provider {} — {}", want.as_str(), a.detail),
                considered,
            },
            Some(a) => {
                let reason = format!(
                    "--provider {} was asked for and is not available: {}. Not substituting another \
                     voice for the one you named.",
                    want.as_str(),
                    a.detail
                );
                Resolution { chosen: None, reason, considered }
            }
            None => Resolution {
                chosen: None,
                reason: format!("provider {} was not probed", want.as_str()),
                considered,
            },
        };
    }
    // Preference order: the good voice when it is there, the floor when it is not.
    for kind in [ProviderKind::Piper, ProviderKind::System] {
        if let Some(a) = find(kind) {
            if a.available {
                let skipped: Vec<String> = considered
                    .iter()
                    .filter(|o| o.kind != kind && !o.available)
                    .map(|o| format!("{} unavailable: {}", o.kind.as_str(), o.detail))
                    .collect();
                let reason = if skipped.is_empty() {
                    format!("{} — {}", kind.as_str(), a.detail)
                } else {
                    format!("{} — {} ({})", kind.as_str(), a.detail, skipped.join("; "))
                };
                return Resolution { chosen: Some(kind), reason, considered };
            }
        }
    }
    let why: Vec<String> = considered
        .iter()
        .map(|a| format!("{}: {}", a.kind.as_str(), a.detail))
        .collect();
    Resolution {
        chosen: None,
        reason: format!("nothing on this machine can speak — {}", why.join("; ")),
        considered,
    }
}

/// Pick a piper voice model from what is installed. `requested` matches on the file stem, so
/// `--voice en_US-lessac-medium` finds `en_US-lessac-medium.onnx`; with none requested the first by
/// name wins, so the choice is at least STABLE across runs rather than directory-order dependent.
pub fn pick_voice(mut installed: Vec<String>, requested: Option<&str>) -> Option<String> {
    installed.sort();
    match requested {
        Some(want) => installed.into_iter().find(|f| {
            f.strip_suffix(".onnx").map(|stem| stem == want).unwrap_or(false) || f == want
        }),
        None => installed.into_iter().find(|f| f.ends_with(".onnx")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLATFORMS: [Platform; 3] = [Platform::Linux, Platform::MacOs, Platform::Windows];

    fn req(text: &str) -> SayRequest {
        SayRequest { text: text.into(), rate: 1.0, voice: None, out: None }
    }

    /// THE ONE THAT MATTERS. Spoken text is the most attacker-adjacent input this crate has — an
    /// agent speaks whatever it was told to speak — and the Windows provider genuinely does run a
    /// script interpreter. So the invariant is asserted for every platform against text carrying
    /// every metacharacter that would matter if any of them ever built a shell line.
    #[test]
    fn spoken_text_never_lands_anywhere_that_parses_it() {
        let hostile = [
            "; rm -rf /",
            "$(whoami)",
            "`id`",
            "'; DROP TABLE voices; --",
            "$env:PATH",
            "\"; Stop-Computer; \"",
            "--rate 999",
        ];
        for p in PLATFORMS {
            for text in hostile {
                let c = system_command(p, &req(text)).expect("no --out, so it builds");
                assert!(
                    c.carries_text_safely(text),
                    "{p:?} embeds {text:?} somewhere parseable: {c:?}"
                );
            }
        }
    }

    #[test]
    fn piper_carries_its_text_on_stdin_too() {
        let text = "$(rm -rf /)";
        let c = piper_command("/v/en.onnx", "/tmp/o.wav", &req(text));
        assert!(c.carries_text_safely(text), "{c:?}");
        assert_eq!(c.stdin.as_deref(), Some(text), "piper reads text from stdin");
    }

    /// The guard must be able to FAIL, or it is decoration. A builder that interpolated text into a
    /// flag is exactly the mistake being prevented, so construct one and watch the check reject it.
    #[test]
    fn carries_text_safely_rejects_an_interpolated_command() {
        let text = "hello";
        let bad = SpeechCommand {
            program: "sh".into(),
            args: vec!["-c".into(), format!("say {text}")],
            stdin: None,
            env: vec![],
        };
        assert!(!bad.carries_text_safely(text), "an interpolated line must not pass");
        let good = SpeechCommand {
            program: "say".into(),
            args: vec!["-r".into(), "175".into()],
            stdin: Some(text.into()),
            env: vec![],
        };
        assert!(good.carries_text_safely(text));
    }

    /// A voice NAME is user-supplied too, and PowerShell is the one place a name could be
    /// interpolated into something parsed. It goes through the environment instead.
    #[test]
    fn a_windows_voice_name_travels_by_environment_not_by_script() {
        let mut r = req("hello");
        r.voice = Some("'; Stop-Computer; '".into());
        let c = system_command(Platform::Windows, &r).unwrap();
        let script = c.args.last().expect("the -Command script");
        assert!(
            !script.contains("Stop-Computer"),
            "the voice name reached the script: {script}"
        );
        assert_eq!(
            c.env,
            vec![(WINDOWS_VOICE_ENV.to_string(), "'; Stop-Computer; '".to_string())],
            "it belongs in the environment"
        );
    }

    #[test]
    fn each_platform_drives_its_own_tool() {
        for p in PLATFORMS {
            let c = system_command(p, &req("hi")).unwrap();
            assert_eq!(c.program, p.system_program(), "{p:?}");
        }
    }

    /// Text beginning with a dash is the case `--` exists for; without it spd-say's getopt refuses.
    #[test]
    fn linux_terminates_options_before_the_text() {
        let c = system_command(Platform::Linux, &req("-100 degrees")).unwrap();
        let dashdash = c.args.iter().position(|a| a == "--").expect("-- is present");
        let text = c.args.iter().position(|a| a == "-100 degrees").expect("the text");
        assert!(dashdash < text, "-- must come first: {:?}", c.args);
    }

    #[test]
    fn out_is_refused_by_the_system_provider_and_the_refusal_names_piper() {
        let mut r = req("hi");
        r.out = Some("/tmp/x.wav".into());
        for p in PLATFORMS {
            let e = system_command(p, &r).unwrap_err();
            assert!(e.contains("piper"), "{p:?} refusal must point somewhere: {e}");
        }
    }

    #[test]
    fn normal_speed_is_neutral_on_every_scale() {
        assert_eq!(spd_say_rate(1.0), 0);
        assert_eq!(sapi_rate(1.0), 0);
        assert_eq!(macos_wpm(1.0), 175);
        assert!((piper_length_scale(1.0) - 1.0).abs() < f32::EPSILON);
    }

    /// Piper's scale is INVERTED. If this ever agrees with the others, the mapping is wrong and the
    /// only symptom in production is speech at the wrong speed — which nobody files a bug about.
    #[test]
    fn piper_length_scale_runs_the_other_way() {
        assert!(piper_length_scale(2.0) < 1.0, "faster must SHORTEN each phoneme");
        assert!(piper_length_scale(0.5) > 1.0, "slower must LENGTHEN it");
        assert!(spd_say_rate(2.0) > 0, "while every other scale goes up");
        assert!(macos_wpm(2.0) > 175);
        assert!(sapi_rate(2.0) > 0);
    }

    #[test]
    fn every_scale_is_clamped_to_what_its_engine_accepts() {
        assert_eq!(spd_say_rate(100.0), 100, "spd-say tops out at +100");
        assert_eq!(spd_say_rate(0.0), -90, "and the floor multiplier is 0.1, not 0");
        assert_eq!(sapi_rate(100.0), 10);
        assert_eq!(sapi_rate(0.0), -9);
        assert!(macos_wpm(100.0) <= 2000);
    }

    /// Every one of these scales takes an `as i32` somewhere, and `NaN as i32` is 0 — which reads as
    /// "normal" on two scales and "as slow as it goes" on another. So it is pinned to normal here.
    #[test]
    fn a_non_finite_rate_becomes_normal_rather_than_zero() {
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(clamp_rate(bad), 1.0, "{bad} must not propagate");
            assert_eq!(spd_say_rate(bad), 0);
            assert_eq!(macos_wpm(bad), 175);
        }
    }

    fn avail(kind: ProviderKind, available: bool) -> Availability {
        Availability { kind, available, detail: if available { "found".into() } else { "missing".into() } }
    }

    #[test]
    fn the_good_voice_wins_when_it_is_installed() {
        let r = resolve(None, vec![avail(ProviderKind::Piper, true), avail(ProviderKind::System, true)]);
        assert_eq!(r.chosen, Some(ProviderKind::Piper));
    }

    #[test]
    fn the_floor_answers_when_piper_is_absent_and_the_reason_says_so() {
        let r = resolve(None, vec![avail(ProviderKind::Piper, false), avail(ProviderKind::System, true)]);
        assert_eq!(r.chosen, Some(ProviderKind::System));
        assert!(r.reason.contains("piper unavailable"), "a fallback must not be silent: {}", r.reason);
    }

    /// Asking for a specific voice and getting a different one without being told is the failure this
    /// prevents. An explicit request is honoured or refused — never substituted.
    #[test]
    fn an_explicit_provider_is_never_quietly_substituted() {
        let r = resolve(
            Some(ProviderKind::Piper),
            vec![avail(ProviderKind::Piper, false), avail(ProviderKind::System, true)],
        );
        assert_eq!(r.chosen, None, "the system voice must not stand in for the one asked for");
        assert!(r.reason.contains("Not substituting"), "{}", r.reason);
    }

    #[test]
    fn nothing_available_is_reported_with_every_reason() {
        let r = resolve(None, vec![avail(ProviderKind::Piper, false), avail(ProviderKind::System, false)]);
        assert_eq!(r.chosen, None);
        assert!(r.reason.contains("piper") && r.reason.contains("system"), "{}", r.reason);
    }

    #[test]
    fn a_voice_is_picked_by_stem_and_the_default_is_stable() {
        let files =
            vec!["en_US-ryan-high.onnx".to_string(), "en_GB-alba-medium.onnx".to_string(), "notes.txt".into()];
        assert_eq!(
            pick_voice(files.clone(), Some("en_US-ryan-high")),
            Some("en_US-ryan-high.onnx".into())
        );
        assert_eq!(
            pick_voice(files.clone(), None),
            Some("en_GB-alba-medium.onnx".into()),
            "sorted, so the default does not depend on directory order"
        );
        assert_eq!(pick_voice(files, Some("nope")), None);
        assert_eq!(pick_voice(vec!["notes.txt".into()], None), None, "a non-model is not a voice");
    }

    #[test]
    fn a_provider_name_round_trips_and_an_unknown_one_is_refused() {
        for k in [ProviderKind::System, ProviderKind::Piper] {
            assert_eq!(ProviderKind::parse(k.as_str()), Ok(k));
        }
        assert!(ProviderKind::parse("espeak").unwrap_err().contains("espeak"));
    }

    #[test]
    fn the_wav_path_is_the_last_argument_whatever_the_player() {
        for (p, player) in
            [(Platform::Linux, "aplay"), (Platform::Linux, "pw-play"), (Platform::MacOs, "afplay")]
        {
            let c = play_command(p, player, "/tmp/a.wav");
            assert_eq!(c.args.last().map(String::as_str), Some("/tmp/a.wav"), "{player}");
            assert_eq!(c.program, player);
        }
    }
}
