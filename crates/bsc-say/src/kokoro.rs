//! Kokoro — the neural voice, run locally through ONNX Runtime.
//!
//! Piper is a good floor and its ceiling is audible. Kokoro is 82M parameters against piper's few,
//! Apache-2.0, and runs faster than realtime on CPU. The cost is that it does not take text: it
//! takes phoneme IDs, so this module owns the whole chain from words to a waveform.
//!
//! **The chain is: text → IPA (espeak-ng) → token ids (the model's own vocab) → ONNX → samples.**
//! The step that looked risky was the middle one, and measurement retired that worry before any of
//! this was written: every character espeak-ng emits for English maps into Kokoro's 115-symbol
//! vocabulary, 76 of 76 on the first sentence tried. The vocab is single IPA characters including
//! stress, length and aspiration marks, which is exactly espeak's output alphabet.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Kokoro emits at 24 kHz.
pub const SAMPLE_RATE: u32 = 24_000;
/// Style vectors are 256-dimensional.
pub const STYLE_DIM: usize = 256;
/// The model's positional limit; token sequences are clamped to it.
pub const MAX_TOKENS: usize = 510;

#[derive(Deserialize)]
struct TokenizerFile {
    model: TokenizerModel,
}
#[derive(Deserialize)]
struct TokenizerModel {
    vocab: HashMap<String, i64>,
}

/// Where the model, its vocabulary and its voices live.
pub struct Paths {
    pub model: PathBuf,
    pub tokenizer: PathBuf,
    pub voices: PathBuf,
}

impl Paths {
    pub fn resolve() -> Option<Paths> {
        let root = match std::env::var_os("BSC_KOKORO_DIR") {
            Some(d) => PathBuf::from(d),
            None => bsc_util::bsc_base_dir()?.join("models").join("kokoro"),
        };
        Some(Paths {
            model: root.join("model.onnx"),
            tokenizer: root.join("tokenizer.json"),
            voices: root.join("voices"),
        })
    }

    pub fn complete(&self) -> bool {
        self.model.is_file() && self.tokenizer.is_file() && self.voices.is_dir()
    }
}

/// Load the phoneme→id table.
pub fn load_vocab(path: &Path) -> Result<HashMap<String, i64>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let t: TokenizerFile =
        serde_json::from_str(&raw).map_err(|e| format!("{} is not a tokenizer: {e}", path.display()))?;
    Ok(t.model.vocab)
}

/// Turn text into IPA with espeak-ng.
///
/// PUNCTUATION IS PRESERVED BY PHONEMIZING BETWEEN IT, not by hoping espeak keeps it. `espeak -q
/// --ipa` discards punctuation entirely, and Kokoro's vocabulary contains comma, period, question
/// and exclamation marks for a reason — they are where it places pauses and final intonation.
/// Losing them is why a naive port sounds like one long breathless sentence, and it is audible
/// immediately: "waiting for you. The gate" phonemised as one run gives "fɔːɹ juːðə".
pub fn phonemize(espeak: &Path, data_dir: &Path, text: &str, voice: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut chunk = String::new();
    // Split so each run of words keeps the mark that terminated it.
    for ch in text.chars() {
        if matches!(ch, '.' | ',' | '!' | '?' | ';' | ':') {
            if !chunk.trim().is_empty() {
                out.push_str(espeak_ipa(espeak, data_dir, chunk.trim(), voice)?.trim());
            }
            out.push(ch);
            out.push(' ');
            chunk.clear();
        } else {
            chunk.push(ch);
        }
    }
    if !chunk.trim().is_empty() {
        out.push_str(espeak_ipa(espeak, data_dir, chunk.trim(), voice)?.trim());
    }
    Ok(out.trim().to_string())
}

fn espeak_ipa(espeak: &Path, data_dir: &Path, text: &str, voice: &str) -> Result<String, String> {
    let out = std::process::Command::new(espeak)
        .arg("-q")
        .arg("--ipa")
        .arg("-v")
        .arg(voice)
        // Text as one argv element and never interpolated, same rule as everywhere else here.
        .arg(text)
        .env("ESPEAK_DATA_PATH", data_dir)
        .env("LD_LIBRARY_PATH", data_dir)
        .output()
        .map_err(|e| format!("could not run {}: {e}", espeak.display()))?;
    if !out.status.success() {
        return Err(format!(
            "espeak-ng failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).replace('\n', " "))
}

/// Split a phoneme string into pieces the model can actually hold.
///
/// MEASURED: an ordinary paragraph is 805 phoneme characters against a 510 ceiling, and before this
/// existed the surplus was simply dropped — the audio stopped mid-word and nothing said so. Silence
/// at the end of a sentence sounds exactly like the end of a sentence, which is what makes the
/// failure invisible rather than merely bad.
///
/// It splits at SENTENCE boundaries first, then clause boundaries, and only cuts blindly when a
/// single run has neither. That order matters for more than tidiness: each chunk is synthesised with
/// its own style vector, which the model selects by token count, so a chunk that ends where a
/// speaker would pause gets a style fitted to a phrase rather than to an arbitrary slice of one.
pub fn chunk_phonemes(ipa: &str, max: usize) -> Vec<String> {
    if max == 0 {
        return vec![];
    }
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();

    // Break after sentence-final marks, keeping the mark with the sentence it ends.
    let mut units: Vec<String> = Vec::new();
    let mut unit = String::new();
    for ch in ipa.chars() {
        unit.push(ch);
        if matches!(ch, '.' | '!' | '?' | '…') {
            units.push(std::mem::take(&mut unit));
        }
    }
    if !unit.trim().is_empty() {
        units.push(unit);
    }

    for u in units {
        for piece in split_to_fit(&u, max) {
            if cur.chars().count() + piece.chars().count() > max && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            cur.push_str(&piece);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out.into_iter().filter(|c| !c.trim().is_empty()).collect()
}

/// One sentence, reduced to pieces that fit — at clauses if it has any, bluntly if it does not.
fn split_to_fit(s: &str, max: usize) -> Vec<String> {
    if s.chars().count() <= max {
        return vec![s.to_string()];
    }
    let mut pieces = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        cur.push(ch);
        let at_clause = matches!(ch, ',' | ';' | ':' | '—');
        if at_clause && cur.chars().count() > max / 2 {
            pieces.push(std::mem::take(&mut cur));
        } else if cur.chars().count() >= max {
            // No clause boundary in reach. A blunt cut is ugly but it is AUDIBLE, where dropping
            // the remainder is not — and being able to hear the seam is what gets it reported.
            pieces.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        pieces.push(cur);
    }
    pieces
}

/// What could not be turned into a token, so a silent mangling is never possible.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Unmapped {
    pub chars: Vec<char>,
}

/// IPA text → token ids, reporting anything the vocabulary did not contain.
///
/// Unmapped characters are DROPPED but never silently: a phoneme the model cannot represent turns
/// into a mispronounced word, which is the kind of defect that gets attributed to the model rather
/// than to the mapping, and then chased in the wrong place.
pub fn tokenize(ipa: &str, vocab: &HashMap<String, i64>) -> (Vec<i64>, Unmapped) {
    let mut ids = Vec::new();
    let mut missing = Vec::new();
    for ch in ipa.chars() {
        match vocab.get(&ch.to_string()) {
            Some(id) => ids.push(*id),
            None => {
                if !missing.contains(&ch) {
                    missing.push(ch);
                }
            }
        }
    }
    ids.truncate(MAX_TOKENS);
    (ids, Unmapped { chars: missing })
}

/// Read the style vector for a token count.
///
/// A voice file is 510 stacked 256-float vectors, one per sequence length — the model was trained
/// with a style that varies with utterance length, so indexing by the wrong length is not a crash
/// but a subtly wrong delivery.
pub fn style_for(voice_bytes: &[u8], n_tokens: usize) -> Result<Vec<f32>, String> {
    let stride = STYLE_DIM * 4;
    let rows = voice_bytes.len() / stride;
    if rows == 0 {
        return Err(format!(
            "a voice file must hold at least one {STYLE_DIM}-float vector; this one is {} bytes",
            voice_bytes.len()
        ));
    }
    let row = n_tokens.min(rows - 1);
    let start = row * stride;
    Ok(voice_bytes[start..start + stride]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect())
}

/// The token sequence the model expects: padded with the `$` boundary token at both ends.
pub fn pad(ids: &[i64]) -> Vec<i64> {
    let mut v = Vec::with_capacity(ids.len() + 2);
    v.push(0);
    v.extend_from_slice(ids);
    v.push(0);
    v
}

// ── Inference ─────────────────────────────────────────────────────────────────────────────────────

/// A loaded model, ready to speak.
pub struct Voice {
    session: ort::session::Session,
    vocab: HashMap<String, i64>,
}

impl Voice {
    pub fn load(paths: &Paths) -> Result<Voice, String> {
        let vocab = load_vocab(&paths.tokenizer)?;
        let session = ort::session::Session::builder()
            .map_err(|e| format!("could not create an ONNX session: {e}"))?
            .commit_from_file(&paths.model)
            .map_err(|e| format!("could not load {}: {e}", paths.model.display()))?;
        Ok(Voice { session, vocab })
    }

    pub fn vocab(&self) -> &HashMap<String, i64> {
        &self.vocab
    }

    /// Synthesise IPA into samples at [`SAMPLE_RATE`].
    /// Synthesise a whole utterance, however long, by chunking it to the model's ceiling.
    ///
    /// `voice_bytes` rather than a pre-selected style, because the style vector is chosen BY TOKEN
    /// COUNT and each chunk has its own — selecting one for the whole utterance and reusing it would
    /// hand every chunk a style fitted to a length it does not have.
    pub fn speak(&mut self, ipa: &str, voice_bytes: &[u8], speed: f32) -> Result<(Vec<f32>, Unmapped), String> {
        let mut all = Vec::new();
        let mut missing = Unmapped::default();
        for chunk in chunk_phonemes(ipa, MAX_TOKENS) {
            let (ids, _) = tokenize(&chunk, &self.vocab);
            if ids.is_empty() {
                continue;
            }
            let style = style_for(voice_bytes, ids.len())?;
            let (samples, m) = self.speak_ipa(&chunk, &style, speed)?;
            all.extend(samples);
            for c in m.chars {
                if !missing.chars.contains(&c) {
                    missing.chars.push(c);
                }
            }
        }
        if all.is_empty() {
            return Err("nothing in that text survived phonemisation".into());
        }
        Ok((all, missing))
    }

    pub fn speak_ipa(&mut self, ipa: &str, style: &[f32], speed: f32) -> Result<(Vec<f32>, Unmapped), String> {
        let (ids, missing) = tokenize(ipa, &self.vocab);
        if ids.is_empty() {
            return Err("nothing in that text survived phonemisation".into());
        }
        let padded = pad(&ids);
        let n = padded.len();
        let ids_t = ort::value::Tensor::from_array(([1usize, n], padded))
            .map_err(|e| format!("input_ids: {e}"))?;
        let style_t = ort::value::Tensor::from_array(([1usize, STYLE_DIM], style.to_vec()))
            .map_err(|e| format!("style: {e}"))?;
        let speed_t = ort::value::Tensor::from_array(([1usize], vec![speed]))
            .map_err(|e| format!("speed: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs!["input_ids" => ids_t, "style" => style_t, "speed" => speed_t])
            .map_err(|e| format!("inference failed: {e}"))?;
        let (_, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("could not read the waveform: {e}"))?;
        Ok((data.to_vec(), missing))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab() -> HashMap<String, i64> {
        [("a", 1i64), ("b", 2), (".", 3), (",", 4), (" ", 5)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    #[test]
    fn tokens_are_padded_at_both_ends() {
        assert_eq!(pad(&[7, 8]), vec![0, 7, 8, 0]);
        assert_eq!(pad(&[]), vec![0, 0], "even an empty utterance keeps its boundaries");
    }

    /// A phoneme the vocabulary lacks becomes a mispronounced word, and a mispronunciation gets
    /// blamed on the model rather than on the mapping. So it is reported.
    #[test]
    fn an_unmappable_phoneme_is_reported_rather_than_silently_dropped() {
        let (ids, missing) = tokenize("abZQ.", &vocab());
        assert_eq!(ids, vec![1, 2, 3]);
        assert_eq!(missing.chars, vec!['Z', 'Q']);
        let (_, none) = tokenize("ab.", &vocab());
        assert!(none.chars.is_empty());
    }

    #[test]
    fn a_sequence_is_clamped_to_what_the_model_can_position() {
        let long = "a".repeat(MAX_TOKENS + 200);
        let (ids, _) = tokenize(&long, &vocab());
        assert_eq!(ids.len(), MAX_TOKENS);
    }

    #[test]
    fn the_style_vector_is_selected_by_token_count_and_never_runs_off_the_end() {
        // Three rows of 256 floats, each row filled with its own index.
        let mut bytes = Vec::new();
        for row in 0..3u32 {
            for _ in 0..STYLE_DIM {
                bytes.extend_from_slice(&(row as f32).to_le_bytes());
            }
        }
        assert_eq!(style_for(&bytes, 0).unwrap()[0], 0.0);
        assert_eq!(style_for(&bytes, 2).unwrap()[0], 2.0);
        // Past the end clamps to the last row rather than panicking.
        assert_eq!(style_for(&bytes, 99).unwrap()[0], 2.0);
        assert_eq!(style_for(&bytes, 1).unwrap().len(), STYLE_DIM);
        assert!(style_for(&[], 0).is_err(), "an empty voice file must be refused, not indexed");
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::*;

    /// THE BUG THIS EXISTS FOR. An ordinary paragraph measured 805 phoneme characters against a 510
    /// ceiling; the surplus was dropped and the audio stopped mid-word with nothing reported.
    /// Silence at the end of a sentence sounds exactly like the end of a sentence.
    #[test]
    fn nothing_is_dropped_however_long_the_input() {
        let sentence = "ðɪs ɪz ə sˈɛntəns. ";
        let long = sentence.repeat(60); // far past any ceiling
        let chunks = chunk_phonemes(&long, MAX_TOKENS);
        let rejoined: String = chunks.concat();
        assert_eq!(
            rejoined.chars().filter(|c| !c.is_whitespace()).count(),
            long.chars().filter(|c| !c.is_whitespace()).count(),
            "every phoneme must survive the split"
        );
        assert!(chunks.len() > 1, "it must actually have split");
    }

    #[test]
    fn every_chunk_fits_the_model() {
        let long = "ðɪs ɪz ə sˈɛntəns wɪð nˈoʊ ˈɛnd tʊ ɪt ".repeat(40);
        for c in chunk_phonemes(&long, MAX_TOKENS) {
            assert!(c.chars().count() <= MAX_TOKENS, "a chunk of {} exceeds the ceiling", c.chars().count());
        }
    }

    /// Chunks are synthesised independently, so a seam falls where a speaker would pause — or it is
    /// audible as a glitch. Sentence boundaries first, then clauses.
    #[test]
    fn it_breaks_at_sentences_before_clauses_and_clauses_before_nothing() {
        let three = "wˈʌn. tˈuː. θrˈiː.";
        let chunks = chunk_phonemes(three, 8);
        assert!(chunks.iter().all(|c| c.trim_end().ends_with('.')), "split at sentences: {chunks:?}");

        // No sentence marks, but clauses: it should prefer those.
        let clauses = "wˈʌn, tˈuː, θrˈiː, fˈɔːr, fˈaɪv,";
        let c2 = chunk_phonemes(clauses, 12);
        assert!(c2.len() > 1);
        assert!(c2[0].ends_with(','), "preferred a clause boundary: {c2:?}");
    }

    /// A single unbroken run with no punctuation still has to be cut. Ugly is acceptable; dropped is
    /// not — a blunt seam can be heard and reported, a missing tail cannot.
    #[test]
    fn an_unbreakable_run_is_cut_bluntly_rather_than_truncated() {
        let run = "ɑ".repeat(1200);
        let chunks = chunk_phonemes(&run, 100);
        assert_eq!(chunks.concat().chars().count(), 1200, "nothing lost");
        assert!(chunks.iter().all(|c| c.chars().count() <= 100));
    }

    #[test]
    fn empty_and_degenerate_inputs_do_not_panic() {
        assert!(chunk_phonemes("", MAX_TOKENS).is_empty());
        assert!(chunk_phonemes("   ", MAX_TOKENS).is_empty());
        assert!(chunk_phonemes("ɑ", 0).is_empty(), "a zero ceiling yields nothing rather than looping");
        assert_eq!(chunk_phonemes("ɑ", MAX_TOKENS), vec!["ɑ"]);
    }

    /// Multibyte throughout — IPA is not ASCII, and counting bytes rather than characters would cut
    /// a phoneme in half and produce a token that is not in the vocabulary.
    #[test]
    fn chunking_counts_characters_not_bytes() {
        let ipa = "ðɪs ɪz ˈmʌltibaɪt. ".repeat(30);
        for c in chunk_phonemes(&ipa, 60) {
            assert!(c.chars().count() <= 60, "{} chars", c.chars().count());
            assert!(std::str::from_utf8(c.as_bytes()).is_ok(), "never split mid-codepoint");
        }
    }
}
