//! Speaker EMBEDDINGS — a fingerprint of the voice that is the same across sessions.
//!
//! The cheap voiceprint (`diarize::Voiceprint`) was measured to encode the SESSION — room, day, mic
//! distance — not the speaker: it recognised the maintainer within one recording (6/7) and collapsed
//! across two (8/68). An embedding model is trained on thousands of speakers to do the opposite:
//! produce a vector that is close for the same person regardless of session, room, or channel, and
//! far for different people. That invariance is the whole point, and it is what makes an imprint
//! learned once actually recognise the user later.
//!
//! **The model is WeSpeaker ECAPA-TDNN512** (`voxceleb_ECAPA512_LM.onnx`, CC-BY-4.0 — attribution:
//! WeSpeaker, VoxCeleb2), run on the same `ort` runtime as Kokoro and DeepFilterNet. Its contract,
//! from the model's own `config.yaml`: 80-dim Kaldi fbank at 16 kHz (25 ms window, 10 ms shift) in,
//! a 192-dim embedding out.
//!
//! **The work is the fbank frontend**, and matching Kaldi's conventions is where a silent mismatch
//! hides (as the ERB frontend was for DeepFilterNet). Kaldi's order is: subtract the frame's DC,
//! pre-emphasis 0.97, a Povey window, power spectrum, an 80-band mel filterbank, log. WeSpeaker then
//! mean-normalises the features over time before the model. Correctness is not asserted against a
//! reference fbank — there is none to hand — but END TO END: same-speaker embeddings must land close
//! and different-speaker far, which a broken frontend cannot fake.

use realfft::num_complex::Complex32;
use realfft::RealFftPlanner;
use std::path::Path;

const SR: u32 = 16_000;
const FRAME_LEN: usize = 400; // 25 ms
const FRAME_SHIFT: usize = 160; // 10 ms
const NFFT: usize = 512; // next power of two >= FRAME_LEN
const NUM_MEL: usize = 80;
const MEL_LOW_HZ: f32 = 20.0;
const MEL_HIGH_HZ: f32 = 8000.0; // Nyquist
const PREEMPH: f32 = 0.97;
pub const EMBED_DIM: usize = 192;

fn hz_to_mel(f: f32) -> f32 {
    1127.0 * (1.0 + f / 700.0).ln()
}
fn mel_to_hz(m: f32) -> f32 {
    700.0 * ((m / 1127.0).exp() - 1.0)
}

/// The 80 triangular mel filters over the `NFFT/2+1` power-spectrum bins — Kaldi's layout: `NUM_MEL`
/// centres evenly spaced in mel between `MEL_LOW_HZ` and `MEL_HIGH_HZ`, each triangle spanning its
/// neighbours' centres.
fn mel_filterbank() -> Vec<Vec<(usize, f32)>> {
    let bins = NFFT / 2 + 1;
    let bin_hz = |k: usize| k as f32 * SR as f32 / NFFT as f32;
    let lo = hz_to_mel(MEL_LOW_HZ);
    let hi = hz_to_mel(MEL_HIGH_HZ);
    let centres: Vec<f32> = (0..NUM_MEL + 2)
        .map(|i| mel_to_hz(lo + (hi - lo) * i as f32 / (NUM_MEL + 1) as f32))
        .collect();
    (0..NUM_MEL)
        .map(|m| {
            let (left, centre, right) = (centres[m], centres[m + 1], centres[m + 2]);
            let mut taps = Vec::new();
            for k in 0..bins {
                let f = bin_hz(k);
                let w = if f >= left && f <= centre {
                    (f - left) / (centre - left)
                } else if f > centre && f <= right {
                    (right - f) / (right - centre)
                } else {
                    0.0
                };
                if w > 0.0 {
                    taps.push((k, w));
                }
            }
            taps
        })
        .collect()
}

/// Povey window: a Hann raised to 0.85, Kaldi's default for fbank.
fn povey_window() -> Vec<f32> {
    (0..FRAME_LEN)
        .map(|n| {
            let hann = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / (FRAME_LEN - 1) as f32).cos();
            hann.powf(0.85)
        })
        .collect()
}

/// 80-dim log-mel fbank per frame, Kaldi-style, then mean-normalised over time (WeSpeaker's step).
/// Returns `[T, NUM_MEL]` flattened row-major.
fn fbank(samples: &[f32], r2c: &std::sync::Arc<dyn realfft::RealToComplex<f32>>) -> (usize, Vec<f32>) {
    let window = povey_window();
    let fb = mel_filterbank();
    let mut feats: Vec<[f32; NUM_MEL]> = Vec::new();
    let mut buf = r2c.make_input_vec();
    let mut spec = r2c.make_output_vec();
    let mut at = 0usize;
    while at + FRAME_LEN <= samples.len() {
        let frame = &samples[at..at + FRAME_LEN];
        // Kaldi: subtract DC, pre-emphasise, window.
        let mean: f32 = frame.iter().sum::<f32>() / FRAME_LEN as f32;
        let mut w = [0.0f32; FRAME_LEN];
        let mut prev = frame[0] - mean;
        for i in 0..FRAME_LEN {
            let x = frame[i] - mean;
            let pe = x - PREEMPH * if i == 0 { x } else { prev };
            prev = x;
            w[i] = pe * window[i];
        }
        for (i, b) in buf.iter_mut().enumerate() {
            *b = if i < FRAME_LEN { w[i] } else { 0.0 };
        }
        r2c.process(&mut buf, &mut spec).expect("fbank fft");
        let mut mel = [0.0f32; NUM_MEL];
        for (m, taps) in fb.iter().enumerate() {
            let mut e = 0.0f32;
            for &(k, wt) in taps {
                let c: Complex32 = spec[k];
                e += (c.re * c.re + c.im * c.im) * wt; // power spectrum
            }
            mel[m] = e.max(1e-10).ln();
        }
        feats.push(mel);
        at += FRAME_SHIFT;
    }
    let t = feats.len();
    if t == 0 {
        return (0, vec![]);
    }
    // Mean-normalise each mel dimension over time.
    let mut colmean = [0.0f32; NUM_MEL];
    for f in &feats {
        for m in 0..NUM_MEL {
            colmean[m] += f[m];
        }
    }
    for cm in colmean.iter_mut() {
        *cm /= t as f32;
    }
    let mut out = Vec::with_capacity(t * NUM_MEL);
    for f in &feats {
        for m in 0..NUM_MEL {
            out.push(f[m] - colmean[m]);
        }
    }
    (t, out)
}

/// A loaded ECAPA-TDNN embedder.
/// The WeSpeaker ECAPA-TDNN512 graph names its tensors `feats` (in) and `embs` (out) — read from
/// the model file. If a different export is dropped in, this is the one place to change.
const INPUT: &str = "feats";
const OUTPUT: &str = "embs";

pub struct Embedder {
    session: ort::session::Session,
    r2c: std::sync::Arc<dyn realfft::RealToComplex<f32>>,
}

impl Embedder {
    /// Load the model. `path` is the `.onnx` file.
    pub fn load(path: &Path) -> Result<Embedder, String> {
        if !path.is_file() {
            return Err(format!("no speaker-embedding model at {}", path.display()));
        }
        let session = ort::session::Session::builder()
            .map_err(|e| format!("ort: {e}"))?
            .commit_from_file(path)
            .map_err(|e| format!("loading {}: {e}", path.display()))?;
        let mut planner = RealFftPlanner::<f32>::new();
        let r2c = planner.plan_fft_forward(NFFT);
        Ok(Embedder { session, r2c })
    }

    /// Embed 16 kHz mono speech into an L2-normalised 192-d vector.
    pub fn embed(&mut self, samples: &[f32], sample_rate: u32) -> Result<Vec<f32>, String> {
        if sample_rate != SR {
            return Err(format!("embedding needs {SR}Hz; got {sample_rate}Hz"));
        }
        let (t, feats) = fbank(samples, &self.r2c);
        if t == 0 {
            return Err("too little audio to embed".into());
        }
        let input = ort::value::Tensor::from_array(([1usize, t, NUM_MEL], feats))
            .map_err(|e| format!("ort feats: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs![INPUT => input])
            .map_err(|e| format!("ort run: {e}"))?;
        let (_, emb) =
            outputs[OUTPUT].try_extract_tensor::<f32>().map_err(|e| format!("emb: {e}"))?;
        Ok(l2_normalise(emb))
    }
}

fn l2_normalise(v: &[f32]) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
    v.iter().map(|x| x / n).collect()
}

/// Cosine distance between two L2-normalised embeddings, in `[0, 2]` (0 = identical direction).
pub fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    1.0 - dot
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mel filterbank covers the band with overlapping triangles: every filter has taps, the
    /// centres ascend, and adjacent filters overlap (a bin shared by neighbours) — a bank that
    /// collapsed to empty or non-overlapping filters would silently feed the model garbage.
    #[test]
    fn mel_filterbank_is_covering_and_overlapping() {
        let fb = mel_filterbank();
        assert_eq!(fb.len(), NUM_MEL);
        assert!(fb.iter().all(|f| !f.is_empty()), "every mel filter must have taps");
        // Overlap: some FFT bin appears in two adjacent filters.
        let shares = (1..NUM_MEL).any(|m| {
            let prev: std::collections::HashSet<usize> = fb[m - 1].iter().map(|&(k, _)| k).collect();
            fb[m].iter().any(|&(k, _)| prev.contains(&k))
        });
        assert!(shares, "adjacent mel filters must overlap");
    }

    /// The Povey window is a raised Hann: zero at the edges, one-ish in the middle, and strictly the
    /// Hann^0.85 Kaldi uses (not a plain Hann, which would shift the features).
    #[test]
    fn povey_window_matches_kaldi() {
        let w = povey_window();
        assert_eq!(w.len(), FRAME_LEN);
        assert!(w[0] < 1e-3, "window is ~0 at the edge");
        let mid = w[FRAME_LEN / 2];
        assert!(mid > 0.99, "window is ~1 in the middle, got {mid}");
        // Hann^0.85 at quarter point differs from plain Hann there.
        let n = FRAME_LEN / 4;
        let hann = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / (FRAME_LEN - 1) as f32).cos();
        assert!((w[n] - hann.powf(0.85)).abs() < 1e-5);
    }

    /// L2 normalisation makes a unit vector, so cosine distance is `1 - dot` and identical vectors
    /// are distance 0.
    #[test]
    fn l2_and_cosine() {
        let v = l2_normalise(&[3.0, 4.0]);
        assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6);
        assert!(cosine_distance(&v, &v).abs() < 1e-6);
        let orth = l2_normalise(&[4.0, -3.0]);
        assert!((cosine_distance(&v, &orth) - 1.0).abs() < 1e-6, "orthogonal → distance 1");
    }
}
