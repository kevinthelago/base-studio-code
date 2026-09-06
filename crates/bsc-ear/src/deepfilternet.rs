//! DeepFilterNet3 speech enhancement — the clarity layer that removes noise WITHOUT RNNoise's
//! metallic "snare-drum" artifact.
//!
//! RNNoise is effective but leaves a boxy, ringing residue on the speech. DeepFilterNet's advantage
//! is its second stage — a *deep filter*, a short complex FIR across time applied per frequency bin,
//! which reconstructs the speech's fine structure instead of just gating bands. That is what keeps
//! the voice natural. The price is a real DSP frontend around the neural graph, ported here exactly
//! from the Apache/MIT reference (`libDF`) so a subtle mismatch does not quietly corrupt the output.
//!
//! **The neural graph is one fused ONNX** (soniqo's verified export of official DeepFilterNet3
//! v0.5.6): it takes normalised ERB and complex-spectrum features and returns an ERB gain mask plus
//! the deep-filter coefficients. Everything else — STFT, ERB features with their two exponential
//! normalisation states, the ERB matrices and window (read from the shipped auxiliary file, not
//! re-derived), the mask application, the deep filter, and the ISTFT — is here. It runs on the same
//! `ort` runtime as Kokoro, so no torch and nothing leaves the machine.
//!
//! Constants are DeepFilterNet3's, confirmed against the model's own `config.json`.

use realfft::num_complex::Complex32;
use realfft::RealFftPlanner;
use std::path::Path;

const SR: u32 = 48_000;
const FFT: usize = 960;
const HOP: usize = 480;
const FREQ: usize = FFT / 2 + 1; // 481
const ERB: usize = 32;
const DF_BINS: usize = 96;
const DF_ORDER: usize = 5;
const DF_LOOKAHEAD: usize = 2;
const ALPHA: f32 = 0.99;
const MEAN_NORM_INIT: [f32; 2] = [-60.0, -90.0];
const UNIT_NORM_INIT: [f32; 2] = [0.001, 0.0001];

/// The deterministic constants the reference ships in `deepfilter-auxiliary.bin`: the forward and
/// inverse ERB matrices and the analysis/synthesis window. Reading them rather than re-deriving
/// removes the biggest source of a silent mismatch.
struct Aux {
    fwd: Vec<f32>,    // [FREQ, ERB] row-major: erb[b] = Σ_i fwd[i*ERB+b] * power[i]
    inv: Vec<f32>,    // [ERB, FREQ] row-major: gain[i] = Σ_b inv[b*FREQ+i] * mask[b]
    window: Vec<f32>, // [FFT]
}

fn load_aux(path: &Path) -> Result<Aux, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let want = (FREQ * ERB + ERB * FREQ + FFT) * 4;
    if bytes.len() != want {
        return Err(format!("{} is {} bytes, expected {want}", path.display(), bytes.len()));
    }
    let mut floats = Vec::with_capacity(bytes.len() / 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        floats.push(f32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]));
        i += 4;
    }
    let (fwd, rest) = floats.split_at(FREQ * ERB);
    let (inv, window) = rest.split_at(ERB * FREQ);
    Ok(Aux { fwd: fwd.to_vec(), inv: inv.to_vec(), window: window.to_vec() })
}

/// The window-normalisation factor libDF applies on the forward transform; combined with the window
/// applied on both transforms and 50%-plus overlap-add, the round trip is unity.
fn wnorm() -> f32 {
    1.0 / (FFT.pow(2) as f32 / (2 * HOP) as f32)
}

/// STFT: one complex spectrum (`FREQ` bins) per `HOP` samples, windowed with the shipped window and
/// scaled by `wnorm`. Mirrors libDF `frame_analysis` — each analysis frame is the previous hop plus
/// the new hop, both windowed.
fn stft(samples: &[f32], window: &[f32], r2c: &std::sync::Arc<dyn realfft::RealToComplex<f32>>) -> Vec<Vec<Complex32>> {
    let norm = wnorm();
    let mut prev = vec![0.0f32; FFT - HOP]; // analysis memory (480)
    let mut frames = Vec::new();
    let mut buf = r2c.make_input_vec();
    let mut spec = r2c.make_output_vec();
    let mut at = 0usize;
    while at < samples.len() {
        let hop: Vec<f32> = (0..HOP).map(|i| samples.get(at + i).copied().unwrap_or(0.0)).collect();
        for i in 0..(FFT - HOP) {
            buf[i] = prev[i] * window[i];
        }
        for i in 0..HOP {
            buf[FFT - HOP + i] = hop[i] * window[FFT - HOP + i];
        }
        r2c.process(&mut buf, &mut spec).expect("stft");
        frames.push(spec.iter().map(|c| c * norm).collect());
        prev = hop;
        at += HOP;
    }
    frames
}

/// ISTFT with overlap-add, mirroring libDF `frame_synthesis`. Consumes the frames and returns audio.
fn istft(mut frames: Vec<Vec<Complex32>>, window: &[f32], c2r: &std::sync::Arc<dyn realfft::ComplexToReal<f32>>) -> Vec<f32> {
    let mut mem = vec![0.0f32; FFT - HOP];
    let mut out = Vec::with_capacity(frames.len() * HOP);
    let mut time = c2r.make_output_vec();
    for frame in frames.iter_mut() {
        // realfft's inverse rejects a non-zero imaginary part at DC and Nyquist.
        frame[0].im = 0.0;
        frame[FREQ - 1].im = 0.0;
        c2r.process(frame, &mut time).expect("istft");
        for i in 0..FFT {
            time[i] *= window[i];
        }
        for i in 0..HOP {
            out.push(time[i] + mem[i]);
        }
        // 50% overlap (FFT == 2*HOP): the memory carried to the next frame is exactly this frame's
        // tail — no multi-frame accumulation term.
        mem.copy_from_slice(&time[HOP..FFT]);
    }
    out
}

/// ERB band power via the forward matrix, then to dB, then the exponential mean-norm with its state.
fn feat_erb(spec: &[Complex32], fwd: &[f32], state: &mut [f32]) -> Vec<f32> {
    let mut erb = vec![0.0f32; ERB];
    for (i, c) in spec.iter().enumerate() {
        let power = c.re * c.re + c.im * c.im;
        for b in 0..ERB {
            erb[b] += fwd[i * ERB + b] * power;
        }
    }
    for (x, s) in erb.iter_mut().zip(state.iter_mut()) {
        *x = (*x + 1e-10).log10() * 10.0;
        *s = *x * (1.0 - ALPHA) + *s * ALPHA;
        *x -= *s;
        *x /= 40.0;
    }
    erb
}

/// Complex unit-norm of the first `DF_BINS` bins, with its state. Returns real-plane then imag-plane
/// (the `[2, DF_BINS]` layout the model's `feat_spec` expects).
fn feat_spec(spec: &[Complex32], state: &mut [f32]) -> (Vec<f32>, Vec<f32>) {
    let mut re = vec![0.0f32; DF_BINS];
    let mut im = vec![0.0f32; DF_BINS];
    for f in 0..DF_BINS {
        let c = spec[f];
        let s = &mut state[f];
        *s = c.norm() * (1.0 - ALPHA) + *s * ALPHA;
        let d = s.sqrt();
        re[f] = c.re / d;
        im[f] = c.im / d;
    }
    (re, im)
}

fn init_state(range: [f32; 2], n: usize) -> Vec<f32> {
    let step = (range[1] - range[0]) / (n - 1) as f32;
    (0..n).map(|i| range[0] + i as f32 * step).collect()
}

/// Enhance 48 kHz mono speech with DeepFilterNet3. `model_dir` holds `deepfilter.onnx` and
/// `deepfilter-auxiliary.bin`.
pub fn denoise(samples: &[f32], sample_rate: u32, model_dir: &Path) -> Result<Vec<f32>, String> {
    if sample_rate != SR {
        return Err(format!("deepfilter needs {SR}Hz; this is {sample_rate}Hz — denoise the 48k original"));
    }
    let aux = load_aux(&model_dir.join("deepfilter-auxiliary.bin"))?;
    let onnx = model_dir.join("deepfilter.onnx");
    if !onnx.is_file() {
        return Err(format!("no model at {}", onnx.display()));
    }

    let mut planner = RealFftPlanner::<f32>::new();
    let r2c = planner.plan_fft_forward(FFT);
    let c2r = planner.plan_fft_inverse(FFT);

    // Analyse. Append one FFT-length tail so the last real samples get full overlap (offline parity).
    let mut padded = samples.to_vec();
    padded.resize(padded.len() + FFT, 0.0);
    let noisy = stft(&padded, &aux.window, &r2c);
    let t = noisy.len();
    if t == 0 {
        return Ok(vec![]);
    }

    // Features.
    let mut erb_state = init_state(MEAN_NORM_INIT, ERB);
    let mut unit_state = init_state(UNIT_NORM_INIT, DF_BINS);
    let mut feat_erb_buf = vec![0.0f32; t * ERB];
    let mut feat_spec_buf = vec![0.0f32; 2 * t * DF_BINS]; // [2, T, DF_BINS]
    for (ti, frame) in noisy.iter().enumerate() {
        let e = feat_erb(frame, &aux.fwd, &mut erb_state);
        feat_erb_buf[ti * ERB..(ti + 1) * ERB].copy_from_slice(&e);
        let (re, im) = feat_spec(frame, &mut unit_state);
        feat_spec_buf[ti * DF_BINS..(ti + 1) * DF_BINS].copy_from_slice(&re);
        feat_spec_buf[(t + ti) * DF_BINS..(t + ti + 1) * DF_BINS].copy_from_slice(&im);
    }

    // Neural graph: one session, one run over all frames.
    let mut session = ort::session::Session::builder()
        .map_err(|e| format!("ort: {e}"))?
        .commit_from_file(&onnx)
        .map_err(|e| format!("loading {}: {e}", onnx.display()))?;
    let erb_t = ort::value::Tensor::from_array(([1usize, 1, t, ERB], feat_erb_buf))
        .map_err(|e| format!("ort feat_erb: {e}"))?;
    let spec_t = ort::value::Tensor::from_array(([1usize, 2, t, DF_BINS], feat_spec_buf))
        .map_err(|e| format!("ort feat_spec: {e}"))?;
    let outputs = session
        .run(ort::inputs!["feat_erb" => erb_t, "feat_spec" => spec_t])
        .map_err(|e| format!("ort run: {e}"))?;
    let (_, erb_mask) =
        outputs["erb_mask"].try_extract_tensor::<f32>().map_err(|e| format!("erb_mask: {e}"))?;
    let (_, df_coefs) =
        outputs["df_coefs"].try_extract_tensor::<f32>().map_err(|e| format!("df_coefs: {e}"))?;

    // Reconstruct each frame's spectrum.
    let mut enhanced: Vec<Vec<Complex32>> = Vec::with_capacity(t);
    for ti in 0..t {
        let mut spec = noisy[ti].clone();
        // Stage 1: ERB gain mask across ALL bins (gain per bin from the inverse ERB matrix).
        for (i, sp) in spec.iter_mut().enumerate() {
            let mut g = 0.0f32;
            for b in 0..ERB {
                g += aux.inv[b * FREQ + i] * erb_mask[ti * ERB + b];
            }
            *sp *= g;
        }
        // Stage 2: deep filter over the low DF_BINS, from the IMMUTABLE noisy spectrum, replacing
        // stage-1's low bins. deep[f] = Σ_o coef[o,t,f] * noisy[t+o-lookahead][f].
        for f in 0..DF_BINS {
            let mut acc = Complex32::new(0.0, 0.0);
            for o in 0..DF_ORDER {
                let src = ti as isize + o as isize - DF_LOOKAHEAD as isize;
                if src < 0 || src as usize >= t {
                    continue;
                }
                // df_coefs shape [1, DF_ORDER, T, DF_BINS, 2]
                let base = (((o * t) + ti) * DF_BINS + f) * 2;
                let c = Complex32::new(df_coefs[base], df_coefs[base + 1]);
                acc += noisy[src as usize][f] * c;
            }
            spec[f] = acc;
        }
        enhanced.push(spec);
    }

    let mut audio = istft(enhanced, &aux.window, &c2r);
    // Remove the STFT delay (one hop) introduced by the analysis window, and trim to input length.
    if audio.len() > HOP {
        audio.drain(0..HOP);
    }
    audio.truncate(samples.len());
    Ok(audio)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// STFT→ISTFT with a unity mask (no model) reconstructs the input, up to the one-hop delay and
    /// edge frames — proof the window, wnorm, and overlap-add are right BEFORE any model is involved.
    /// If this drifts, every downstream judgement is on a broken transform.
    #[test]
    fn stft_istft_round_trips() {
        let mut planner = RealFftPlanner::<f32>::new();
        let r2c = planner.plan_fft_forward(FFT);
        let c2r = planner.plan_fft_inverse(FFT);
        // A window is needed; synthesise the sqrt-Hann-ish window libDF uses so the test needs no aux
        // file. libDF's window: sin(0.5*pi*sin(0.5*pi*(i+0.5)/win_h)^2), win_h = FFT/2.
        let win_h = FFT / 2;
        let window: Vec<f32> = (0..FFT)
            .map(|i| {
                let s = (0.5 * std::f32::consts::PI * (i as f32 + 0.5) / win_h as f32).sin();
                (0.5 * std::f32::consts::PI * s * s).sin()
            })
            .collect();
        // A test signal: a couple of tones.
        let n = FFT * 6;
        let sig: Vec<f32> = (0..n)
            .map(|i| 0.3 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / SR as f32).sin())
            .collect();
        let mut padded = sig.clone();
        padded.resize(padded.len() + FFT, 0.0);
        let frames = stft(&padded, &window, &r2c);
        let mut out = istft(frames, &window, &c2r);
        if out.len() > HOP {
            out.drain(0..HOP);
        }
        out.truncate(sig.len());
        // Compare the steady middle (skip edge frames where OLA hasn't ramped up).
        let a = FFT * 2;
        let b = sig.len() - FFT * 2;
        let err: f32 = (a..b).map(|i| (out[i] - sig[i]).powi(2)).sum::<f32>() / (b - a) as f32;
        let energy: f32 = (a..b).map(|i| sig[i].powi(2)).sum::<f32>() / (b - a) as f32;
        assert!(err / energy < 0.02, "round-trip error {}% too high", 100.0 * err / energy);
    }

    /// The normalisation states initialise as the reference specifies — a linear ramp across bands.
    /// A wrong init is a classic silent mismatch (the model was trained expecting exactly this warm
    /// start), so it is pinned.
    #[test]
    fn norm_states_initialise_as_a_linear_ramp() {
        let erb = init_state(MEAN_NORM_INIT, ERB);
        assert_eq!(erb.len(), ERB);
        assert!((erb[0] - -60.0).abs() < 1e-4);
        assert!((erb[ERB - 1] - -90.0).abs() < 1e-4);
        let unit = init_state(UNIT_NORM_INIT, DF_BINS);
        assert!((unit[0] - 0.001).abs() < 1e-6);
        assert!((unit[DF_BINS - 1] - 0.0001).abs() < 1e-6);
    }

    /// Non-48k is refused, not resampled behind the caller's back (the network is trained at 48k).
    #[test]
    fn rejects_non_48k() {
        let err = denoise(&[0.0; 100], 16_000, Path::new("/nonexistent")).unwrap_err();
        assert!(err.contains("48"), "{err}");
    }
}
