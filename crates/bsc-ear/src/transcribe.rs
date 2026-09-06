//! Turning captured segments into words.
//!
//! **A batch pass, not a server.** MEASURED: a 7.5s segment costs 630ms to load the model and 249ms
//! to transcribe, so loading dominates. whisper-cli accepts many files in one invocation and loads
//! once — three files took 1.73s batched against 2.16s separately, and the gap widens with every
//! extra file. That removed the need for a long-running `whisper-server` and the health-checking,
//! restarting and port-owning that comes with it.
//!
//! **Structured output, not scraped stdout.** `-oj` writes one JSON beside each input carrying the
//! detected language and the text. Batched stdout interleaves transcripts with the filename of the
//! NEXT file, which is parseable right up until a transcript happens to contain the marker text.
//!
//! It runs as its own pass, so capture never waits for it and may run far ahead. A transcriber that
//! is slow, stopped or broken must not be able to make the ear miss a word — it can only make the
//! words arrive late, and [`crate::retention`] holds the audio until they do.

use crate::transcript::Transcript;
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// The shape of a whisper-cli `-oj` result. Only the fields we need; whisper writes many more.
#[derive(Deserialize)]
struct WhisperJson {
    #[serde(default)]
    result: WhisperResult,
    #[serde(default)]
    transcription: Vec<WhisperSegment>,
}
#[derive(Deserialize, Default)]
struct WhisperResult {
    #[serde(default)]
    language: String,
}
#[derive(Deserialize)]
struct WhisperSegment {
    #[serde(default)]
    text: String,
    /// Millisecond offsets from the start of the file. Present in `-oj` output; optional here so
    /// the text-only readers (`parse_result`) that never look at them keep deserializing.
    #[serde(default)]
    offsets: Option<Offsets>,
}
#[derive(Deserialize, Clone, Copy)]
struct Offsets {
    #[serde(default)]
    from: u64,
    #[serde(default)]
    to: u64,
}

/// One transcribed phrase with its place in the recording: `(from_ms, to_ms, text)`.
///
/// This is what a diarizer's speaker turns get aligned against — same clock (both are milliseconds
/// from the start of the file), so the two just overlap.
pub type TimedPhrase = (u64, u64, String);

/// Transcribe ONE file into timed phrases, for attribution against speaker turns.
///
/// Separate from [`transcribe_batch`] on purpose: that path stores one text blob per captured
/// segment and never needed the within-file timing. Attribution does — it has to know WHEN each
/// phrase was said to say WHO said it — so this returns the per-phrase offsets whisper already emits
/// and throws away nothing.
pub fn timed_transcript(w: &Whisper, file: &Path) -> Result<(String, Vec<TimedPhrase>), String> {
    let out = std::process::Command::new(&w.binary)
        .arg("-m")
        .arg(&w.model)
        .args(["-oj", "-np", "-l", "auto"])
        .arg(file)
        .output()
        .map_err(|e| format!("could not run {}: {e}", w.binary.display()))?;
    if !out.status.success() {
        return Err(format!(
            "whisper exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
        ));
    }
    let json_path = file.with_extension("wav.json");
    let raw = std::fs::read_to_string(&json_path)
        .map_err(|e| format!("whisper wrote no result for {}: {e}", file.display()))?;
    let _ = std::fs::remove_file(&json_path);
    let w: WhisperJson = serde_json::from_str(&raw).map_err(|e| format!("not a whisper result: {e}"))?;
    let lang = if w.result.language.is_empty() { "unknown".into() } else { w.result.language };
    let phrases = w
        .transcription
        .into_iter()
        .filter_map(|s| {
            let t = s.text.trim().to_string();
            let o = s.offsets?;
            (!t.is_empty()).then_some((o.from, o.to, t))
        })
        .collect();
    Ok((lang, phrases))
}

/// Which segments still need words, given what the store already holds.
///
/// Pure. `done` is the set of segment names already transcribed; everything else on disk is work.
pub fn pending(on_disk: &[String], done: &[String]) -> Vec<String> {
    let mut v: Vec<String> = on_disk
        .iter()
        .filter(|n| n.ends_with(".wav") && !done.iter().any(|d| d == *n))
        .cloned()
        .collect();
    // Oldest first: the retention sweep is closing in on those, so they are the ones at risk.
    v.sort();
    v
}

/// `<prefix>/lib` for a binary at `<prefix>/bin/<name>`, when that directory exists.
///
/// whisper.cpp builds as several shared objects — libwhisper, libggml and one per backend. A build
/// tree resolves them through an absolute RUNPATH into itself, so it works exactly where it was
/// built and nowhere else; `cmake --install` lays out the conventional bin/ + lib/ pair and STRIPS
/// that RUNPATH, which leaves the installed copy unable to find its own libraries. Both are correct
/// by their own lights and neither runs, so the spawn supplies the missing half. Prepending keeps
/// an operator's own LD_LIBRARY_PATH ahead of ours.
///
/// A binary that needs nothing (a static build, or one on the system loader path) has no such
/// directory and is spawned unchanged.
fn sibling_lib_dir(binary: &std::path::Path) -> Option<std::path::PathBuf> {
    let prefix = binary.parent().filter(|p| p.file_name() == Some("bin".as_ref()))?.parent()?;
    let libs = prefix.join("lib");
    libs.is_dir().then_some(libs)
}

/// Read one whisper JSON result into text and a language.
pub fn parse_result(json: &str) -> Result<(String, String), String> {
    let w: WhisperJson =
        serde_json::from_str(json).map_err(|e| format!("not a whisper result: {e}"))?;
    let text = w.transcription.iter().map(|s| s.text.trim()).collect::<Vec<_>>().join(" ");
    let lang = if w.result.language.is_empty() { "unknown".into() } else { w.result.language };
    Ok((text.trim().to_string(), lang))
}

/// Where the whisper binary and a model live.
pub struct Whisper {
    pub binary: PathBuf,
    pub model: PathBuf,
}

impl Whisper {
    /// Find a usable whisper. `$BSC_WHISPER_BIN` and `$BSC_WHISPER_MODEL` override; otherwise the
    /// binary comes from PATH and the model is the largest `.bin` under the models dir — largest
    /// because these are quantised variants of one family and the big one is the accurate one.
    pub fn resolve() -> Result<Whisper, String> {
        let binary = match std::env::var_os("BSC_WHISPER_BIN") {
            Some(p) => PathBuf::from(p),
            None => which("whisper-cli")
                .ok_or("no whisper-cli on PATH — set $BSC_WHISPER_BIN to point at one")?,
        };
        let model = match std::env::var_os("BSC_WHISPER_MODEL") {
            Some(p) => PathBuf::from(p),
            None => {
                let dir = bsc_util::bsc_base_dir()
                    .ok_or("no home directory")?
                    .join("models")
                    .join("whisper");
                let mut models: Vec<(u64, PathBuf)> = std::fs::read_dir(&dir)
                    .map_err(|_| format!("no models at {}", dir.display()))?
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|x| x == "bin"))
                    .filter_map(|p| p.metadata().ok().map(|m| (m.len(), p)))
                    .collect();
                models.sort_by_key(|(n, _)| *n);
                models
                    .pop()
                    .map(|(_, p)| p)
                    .ok_or_else(|| format!("no .bin model in {}", dir.display()))?
            }
        };
        if !binary.is_file() {
            return Err(format!("{} is not a file", binary.display()));
        }
        if !model.is_file() {
            return Err(format!("{} is not a file", model.display()));
        }
        Ok(Whisper { binary, model })
    }
}

fn which(prog: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(prog))
        .find(|p| p.is_file())
}

/// Transcribe a batch in one invocation, returning a row per file that produced words.
///
/// `-l auto` because the language is DETECTED, not assumed: whisper followed a mid-sentence switch
/// to Portuguese unprompted, and defaulting to English would have thrown that away silently.
pub fn transcribe_batch(
    w: &Whisper,
    dir: &Path,
    names: &[String],
    live_of: &dyn Fn(&str) -> Option<bool>,
) -> Result<Vec<Transcript>, String> {
    if names.is_empty() {
        return Ok(vec![]);
    }
    let paths: Vec<PathBuf> = names.iter().map(|n| dir.join(n)).collect();
    let mut cmd = std::process::Command::new(&w.binary);
    if let Some(libs) = sibling_lib_dir(&w.binary) {
        let mut path = std::ffi::OsString::from(&libs);
        if let Some(existing) = std::env::var_os("LD_LIBRARY_PATH") {
            path.push(":");
            path.push(existing);
        }
        cmd.env("LD_LIBRARY_PATH", path);
    }
    let out = cmd
        .arg("-m")
        .arg(&w.model)
        .args(["-oj", "-np", "-l", "auto"])
        .args(&paths)
        .output()
        .map_err(|e| format!("could not run {}: {e}", w.binary.display()))?;
    if !out.status.success() {
        return Err(format!(
            "whisper exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
        ));
    }
    let mut rows = Vec::new();
    for (name, path) in names.iter().zip(&paths) {
        let json_path = path.with_extension("wav.json");
        let Ok(raw) = std::fs::read_to_string(&json_path) else { continue };
        let _ = std::fs::remove_file(&json_path);
        let (text, language) = parse_result(&raw)?;
        if text.is_empty() {
            continue;
        }
        let seconds = hound::WavReader::open(path)
            .ok()
            .map(|r| r.duration() as f32 / r.spec().sample_rate.max(1) as f32)
            .unwrap_or(0.0);
        rows.push(Transcript {
            started_unix_ms: crate::transcript::started_from_name(name).unwrap_or(0),
            segment: name.clone(),
            seconds,
            language,
            text,
            live: live_of(name),
        });
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_is_what_is_on_disk_and_not_yet_stored() {
        let disk = vec!["seg-3.wav".into(), "seg-1.wav".into(), "notes.txt".into(), "seg-2.wav".into()];
        let done = vec!["seg-2.wav".to_string()];
        // Oldest first: the retention sweep is closing in on those, so they are the ones at risk.
        assert_eq!(pending(&disk, &done), vec!["seg-1.wav", "seg-3.wav"]);
        assert!(pending(&[], &done).is_empty());
        assert!(pending(&disk, &disk).is_empty(), "nothing pending when everything is stored");
    }

    #[test]
    fn a_whisper_result_yields_its_text_and_detected_language() {
        let j = r#"{"result":{"language":"pt"},"transcription":[
            {"text":" Vamos fazer"},{"text":" uma coisa."}]}"#;
        let (text, lang) = parse_result(j).unwrap();
        assert_eq!(text, "Vamos fazer uma coisa.");
        assert_eq!(lang, "pt", "the language is DETECTED and recorded, never assumed");
    }

    /// A result with no language is recorded as unknown rather than quietly called English —
    /// defaulting would throw away exactly the multilingual behaviour that makes this worth having.
    #[test]
    fn a_missing_language_is_unknown_not_english() {
        let (_, lang) = parse_result(r#"{"transcription":[{"text":"hello"}]}"#).unwrap();
        assert_eq!(lang, "unknown");
    }

    #[test]
    fn a_result_that_is_not_whisper_output_is_refused() {
        assert!(parse_result("not json").is_err());
        assert!(parse_result("").is_err());
        let (t, _) = parse_result(r#"{"result":{"language":"en"},"transcription":[]}"#).unwrap();
        assert!(t.is_empty(), "no segments means no text, not a panic");
    }

    /// A whisper build that carries its own shared objects is unreachable without this: the build
    /// tree resolves them by an absolute RUNPATH into itself, and `cmake --install` strips that
    /// RUNPATH while laying out bin/ + lib/. Measured on this machine, the installed copy exits 127
    /// with "libwhisper.so.1: cannot open shared object file" and the ear reports the transcriber as
    /// simply broken.
    #[test]
    fn an_installed_whisper_finds_the_libraries_beside_its_bin_dir() {
        let root = std::env::temp_dir().join(format!("bsc-ear-libdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("prefix/bin")).unwrap();
        std::fs::create_dir_all(root.join("prefix/lib")).unwrap();
        let installed = root.join("prefix/bin/whisper-cli");
        std::fs::write(&installed, "").unwrap();
        assert_eq!(sibling_lib_dir(&installed).as_deref(), Some(root.join("prefix/lib").as_path()));

        // A build tree with no lib/ beside it, and a binary loose on PATH, are both spawned
        // unchanged — supplying a directory that does not exist would be its own bug.
        std::fs::create_dir_all(root.join("bare/bin")).unwrap();
        let bare = root.join("bare/bin/whisper-cli");
        std::fs::write(&bare, "").unwrap();
        assert_eq!(sibling_lib_dir(&bare), None, "no lib/ beside bin/ means nothing to add");

        let loose = root.join("whisper-cli");
        std::fs::write(&loose, "").unwrap();
        assert_eq!(sibling_lib_dir(&loose), None, "a binary not under a bin/ dir has no prefix");

        // A `lib` that is a FILE is not a library directory.
        std::fs::create_dir_all(root.join("odd/bin")).unwrap();
        std::fs::write(root.join("odd/lib"), "not a directory").unwrap();
        let odd = root.join("odd/bin/whisper-cli");
        std::fs::write(&odd, "").unwrap();
        assert_eq!(sibling_lib_dir(&odd), None, "a file named lib is not a library directory");
        let _ = std::fs::remove_dir_all(&root);
    }

}
