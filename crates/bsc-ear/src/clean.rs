//! Clean a recording before it is transcribed or a speaker is extracted from it.
//!
//! Two noise classes, two tools, because they are physically different problems:
//!
//! - **Transient, low-frequency** — a phone set down, a hand brushing the mic, a bump. Almost all
//!   the energy is below the voice, so a **high-pass filter** removes it without touching speech. A
//!   thump is a step in air pressure: broadband but bottom-heavy, and the part that survives into the
//!   voice band is small.
//! - **Stationary** — rain, hiss, mains hum, a fan. These have a steady spectral signature, so it
//!   can be *estimated from the quiet moments and subtracted*: **spectral subtraction**. The trap is
//!   over-subtraction, which leaves "musical noise" — random tonal blips where the estimate was
//!   momentarily exceeded — so every bin keeps a **floor** of its original magnitude rather than
//!   being driven to zero.
//!
//! What this deliberately does NOT do is separate two people talking at once. Two voices share the
//! same frequencies at the same time, so no filter or subtraction can tell them apart — that is
//! target-speaker extraction, a different and model-driven problem. This is the model-free pre-step
//! that hands both whisper and that extractor a cleaner signal to work from.
//!
//! Pure: samples in, samples out. It reuses the one FFT in the crate (`liveness::fft_public`) rather
//! than a second copy, and `prosody::Biquad` for the high-pass.

/// STFT frame size. 1024 at 16 kHz is 64 ms — long enough to resolve the low bins that matter for a
/// noise estimate, short enough that a transient does not smear across the whole utterance.
const FRAME: usize = 1024;
/// 75% overlap (hop = FRAME/4). Enough that the Hann window sums to a constant on reconstruction, so
/// overlap-add does not impose its own amplitude ripple on the output.
const HOP: usize = FRAME / 4;

/// Default high-pass corner. Voice fundamentals start ~85 Hz (a low male voice); handling thumps and
/// rumble live below that. 80 Hz keeps the voice and drops the thump.
pub const DEFAULT_HIGHPASS_HZ: f32 = 80.0;

/// How much of the estimated noise to subtract. >1 over-subtracts to fight noise harder at the cost
/// of more artefacts; 1.5 is a common, mild default.
pub const DEFAULT_OVERSUBTRACT: f32 = 1.5;

/// The spectral floor: the fraction of the original magnitude every bin keeps, however much noise was
/// estimated there. This is what trades a little residual noise for the absence of musical noise —
/// zeroing bins is what produces the warbling artefact, so we never zero.
pub const DEFAULT_FLOOR: f32 = 0.05;

/// Knobs, all with honest defaults. Exposed so the cleaning can be *tuned and measured* rather than
/// trusted (the standing direction for this chain).
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub highpass_hz: f32,
    pub oversubtract: f32,
    pub floor: f32,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            highpass_hz: DEFAULT_HIGHPASS_HZ,
            oversubtract: DEFAULT_OVERSUBTRACT,
            floor: DEFAULT_FLOOR,
        }
    }
}

/// High-pass one signal with a biquad, forward only (a single pass; phase is not corrected, which
/// does not matter for speech intelligibility or for the analysis that follows).
pub fn high_pass(samples: &[f32], sample_rate: u32, cutoff_hz: f32) -> Vec<f32> {
    if cutoff_hz <= 0.0 {
        return samples.to_vec();
    }
    let mut bq = crate::prosody::Biquad::highpass(sample_rate, cutoff_hz, std::f32::consts::FRAC_1_SQRT_2);
    samples.iter().map(|&x| bq.process(x)).collect()
}

/// Forward real FFT of one frame → (re, im), each `FRAME` long.
fn rfft(frame: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let mut re = frame.to_vec();
    let mut im = vec![0.0f32; frame.len()];
    crate::liveness::fft_public(&mut re, &mut im);
    (re, im)
}

/// Inverse FFT via the conjugation identity: ifft(X) = conj(fft(conj(X))) / N. Reuses the one
/// forward FFT rather than writing a second transform to get wrong.
fn irfft(re: &[f32], im: &[f32]) -> Vec<f32> {
    let n = re.len();
    let mut r: Vec<f32> = re.to_vec();
    let mut i: Vec<f32> = im.iter().map(|v| -v).collect(); // conj(X)
    crate::liveness::fft_public(&mut r, &mut i);
    // conj and scale; the real part is the time signal.
    r.iter().map(|v| v / n as f32).collect()
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos())
        .collect()
}

/// Estimate the stationary noise magnitude spectrum: the per-bin average over the QUIETEST frames.
///
/// The quietest frames, because those are the gaps between speech where only the room is heard —
/// estimating noise over speech would subtract the speaker's own energy. Uses the lowest-energy
/// third of frames, which is robust when at least some of the recording is non-speech (a
/// conversation is mostly gaps) and degrades gracefully when it is not (it just estimates a
/// conservative floor from the quietest speech).
fn estimate_noise(frames_mag: &[Vec<f32>]) -> Vec<f32> {
    let bins = frames_mag.first().map(|f| f.len()).unwrap_or(0);
    if frames_mag.is_empty() || bins == 0 {
        return vec![0.0; bins];
    }
    let mut order: Vec<usize> = (0..frames_mag.len()).collect();
    let energy = |i: usize| frames_mag[i].iter().map(|m| m * m).sum::<f32>();
    order.sort_by(|&a, &b| energy(a).partial_cmp(&energy(b)).unwrap());
    let quiet = order.iter().take((frames_mag.len() / 3).max(1));
    let mut noise = vec![0.0f32; bins];
    let mut n = 0usize;
    for &fi in quiet {
        for (b, m) in frames_mag[fi].iter().enumerate() {
            noise[b] += m;
        }
        n += 1;
    }
    noise.iter().map(|s| s / n as f32).collect()
}

/// Spectral subtraction: subtract the estimated stationary noise, keeping a floor of each bin so no
/// bin is zeroed (which is what makes musical noise). Phase is untouched — the ear is insensitive to
/// spectral phase, and keeping it avoids inventing artefacts.
pub fn spectral_subtract(samples: &[f32], opts: &Options) -> Vec<f32> {
    if samples.len() < FRAME {
        return samples.to_vec();
    }
    let win = hann(FRAME);
    // Analysis pass: collect complex spectra and magnitudes per frame.
    let mut specs: Vec<(Vec<f32>, Vec<f32>)> = Vec::new();
    let mut mags: Vec<Vec<f32>> = Vec::new();
    let mut at = 0usize;
    while at + FRAME <= samples.len() {
        let framed: Vec<f32> = (0..FRAME).map(|i| samples[at + i] * win[i]).collect();
        let (re, im) = rfft(&framed);
        let mag: Vec<f32> = re.iter().zip(&im).map(|(r, i)| (r * r + i * i).sqrt()).collect();
        specs.push((re, im));
        mags.push(mag);
        at += HOP;
    }
    let noise = estimate_noise(&mags);

    // Synthesis pass: attenuate each bin toward (mag - k*noise), floored, keep phase, overlap-add.
    let mut out = vec![0.0f32; samples.len()];
    let mut wsum = vec![0.0f32; samples.len()];
    for (fi, (re, im)) in specs.iter().enumerate() {
        let mut r = vec![0.0f32; FRAME];
        let mut i = vec![0.0f32; FRAME];
        for b in 0..FRAME {
            let mag = mags[fi][b];
            if mag <= 1e-12 {
                continue;
            }
            let reduced = (mag - opts.oversubtract * noise[b]).max(opts.floor * mag);
            let gain = reduced / mag;
            r[b] = re[b] * gain;
            i[b] = im[b] * gain;
        }
        let time = irfft(&r, &i);
        let start = fi * HOP;
        for k in 0..FRAME {
            if start + k < out.len() {
                out[start + k] += time[k] * win[k];
                wsum[start + k] += win[k] * win[k];
            }
        }
    }
    // Normalise by the summed squared window so overlap-add is unity-gain where frames cover.
    for (o, w) in out.iter_mut().zip(&wsum) {
        if *w > 1e-6 {
            *o /= *w;
        }
    }
    out
}

/// Which denoiser to run.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Engine {
    /// Hand-rolled high-pass + spectral subtraction. Model-free, no dependency; weak on the
    /// non-stationary noise (rain, handling) that has no steady spectrum to estimate.
    Spectral,
    /// The RNNoise recurrent neural denoiser (via nnnoiseless). Trained on real noise, so it removes
    /// the non-stationary noise spectral subtraction cannot. Operates at 48 kHz only.
    Rnnoise,
}

/// Denoise with RNNoise. Requires 48 kHz mono — the network is trained at that rate, and resampling
/// is the caller's job (we hold the 48 kHz originals, so we denoise those and downsample after).
///
/// RNNoise expects samples in i16 MAGNITUDE, not normalised [-1, 1] — a normalised signal fed in
/// reads as near-silence and the denoiser passes it through untouched, which looks like "it did
/// nothing." So we scale up on the way in and back down on the way out.
pub fn denoise_rnnoise(samples: &[f32], sample_rate: u32) -> Result<Vec<f32>, String> {
    if sample_rate != 48_000 {
        return Err(format!(
            "rnnoise needs 48kHz audio; this is {sample_rate}Hz — denoise the 48k original, then downsample"
        ));
    }
    let mut st = nnnoiseless::DenoiseState::new();
    let f = nnnoiseless::DenoiseState::FRAME_SIZE;
    let mut inbuf = vec![0.0f32; f];
    let mut outbuf = vec![0.0f32; f];
    let mut out = Vec::with_capacity(samples.len());
    for chunk in samples.chunks(f) {
        for (i, slot) in inbuf.iter_mut().enumerate() {
            *slot = chunk.get(i).copied().unwrap_or(0.0) * 32768.0;
        }
        st.process_frame(&mut outbuf, &inbuf);
        out.extend(outbuf.iter().take(chunk.len()).map(|s| s / 32768.0));
    }
    Ok(out)
}

/// Clean with a chosen engine.
pub fn clean_with(samples: &[f32], sample_rate: u32, engine: Engine, opts: &Options) -> Result<Vec<f32>, String> {
    match engine {
        Engine::Spectral => Ok(clean(samples, sample_rate, opts)),
        // High-pass the transients first (RNNoise targets broadband noise, not a DC-ish thump), then
        // hand the rest to the network.
        Engine::Rnnoise => denoise_rnnoise(&high_pass(samples, sample_rate, opts.highpass_hz), sample_rate),
    }
}

/// The full cleaning pass: high-pass the transients, then spectrally subtract the stationary noise.
/// Order matters — removing the low-frequency thump first keeps it out of the noise estimate, so the
/// estimate describes the steady room rather than being skewed by a one-off bump.
pub fn clean(samples: &[f32], sample_rate: u32, opts: &Options) -> Vec<f32> {
    let hp = high_pass(samples, sample_rate, opts.highpass_hz);
    spectral_subtract(&hp, opts)
}

/// Root-mean-square, for before/after level reporting.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Energy below `hz`, as a fraction of total — the number a high-pass should shrink, and the one a
/// set-down thump inflates. Lets the cleaning be MEASURED, not just trusted.
pub fn low_freq_fraction(samples: &[f32], sample_rate: u32, hz: f32) -> f32 {
    if samples.len() < FRAME {
        return 0.0;
    }
    let win = hann(FRAME);
    let cutoff_bin = (hz * FRAME as f32 / sample_rate as f32) as usize;
    let (mut low, mut total) = (0.0f64, 0.0f64);
    let mut at = 0usize;
    while at + FRAME <= samples.len() {
        let framed: Vec<f32> = (0..FRAME).map(|i| samples[at + i] * win[i]).collect();
        let (re, im) = rfft(&framed);
        for b in 0..FRAME / 2 {
            let p = (re[b] * re[b] + im[b] * im[b]) as f64;
            total += p;
            if b <= cutoff_bin {
                low += p;
            }
        }
        at += HOP;
    }
    if total <= 0.0 {
        0.0
    } else {
        (low / total) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: u32 = 16000;

    fn tone(hz: f32, secs: f32, amp: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        (0..n).map(|i| amp * (2.0 * PI * hz * i as f32 / SR as f32).sin()).collect()
    }

    /// The high-pass keeps the voice and drops the thump: a 40 Hz rumble is strongly attenuated while
    /// a 200 Hz voice-band tone passes nearly untouched. This is the set-down-thump fix in miniature.
    #[test]
    fn high_pass_drops_low_keeps_voice() {
        let low = tone(40.0, 1.0, 0.5);
        let voice = tone(200.0, 1.0, 0.5);
        let low_out = high_pass(&low, SR, DEFAULT_HIGHPASS_HZ);
        let voice_out = high_pass(&voice, SR, DEFAULT_HIGHPASS_HZ);
        let keep_low = rms(&low_out) / rms(&low);
        let keep_voice = rms(&voice_out) / rms(&voice);
        assert!(keep_low < 0.35, "40Hz rumble should be strongly cut, kept {keep_low}");
        assert!(keep_voice > 0.80, "200Hz voice should pass, kept {keep_voice}");
    }

    /// A real set-down is a low-frequency transient riding under speech. The high-pass shrinks the
    /// sub-80Hz energy fraction — the measurable signature of the thump — without gutting the signal.
    #[test]
    fn a_low_transient_is_attenuated_and_measurable() {
        let mut sig = tone(220.0, 1.0, 0.3); // voice
        // a thump in the first 60ms: a decaying 30Hz burst
        let thump = SR as usize * 60 / 1000;
        for (i, s) in sig.iter_mut().take(thump).enumerate() {
            *s += 0.8 * (2.0 * PI * 30.0 * i as f32 / SR as f32).sin() * (1.0 - i as f32 / (SR as f32 * 0.06));
        }
        let before = low_freq_fraction(&sig, SR, 80.0);
        let after = low_freq_fraction(&high_pass(&sig, SR, 80.0), SR, 80.0);
        assert!(after < before * 0.5, "high-pass should at least halve sub-80Hz energy: {before} -> {after}");
    }

    /// Spectral subtraction reduces added stationary noise, and — the property that matters — does
    /// NOT zero the signal: the spectral floor keeps the voice present. Proven by measuring residual
    /// noise down AND voice-band energy preserved.
    #[test]
    fn spectral_subtraction_reduces_noise_without_zeroing_voice() {
        // Voice present only in the middle; quiet (noise-only) at the ends so the estimator has gaps.
        let mut sig = vec![0.0f32; SR as usize * 3];
        let voice = tone(300.0, 1.0, 0.4);
        for (k, v) in voice.iter().enumerate() {
            sig[SR as usize + k] += v;
        }
        // add stationary broadband-ish noise everywhere (a fixed pseudo-random hiss)
        let mut seed = 12345u32;
        for s in sig.iter_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *s += ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.05;
        }
        let opts = Options::default();
        let cleaned = spectral_subtract(&sig, &opts);
        // Residual noise, measured on the quiet tail, should drop.
        let tail = SR as usize * 2 + SR as usize / 2;
        let noise_before = rms(&sig[tail..]);
        let noise_after = rms(&cleaned[tail..]);
        assert!(noise_after < noise_before, "noise should drop on the quiet tail: {noise_before} -> {noise_after}");
        // Voice must survive — not zeroed by over-subtraction.
        let vseg = SR as usize + SR as usize / 4..SR as usize + 3 * SR as usize / 4;
        assert!(rms(&cleaned[vseg]) > 0.1, "the voice must remain present, not be scrubbed to silence");
    }

    /// The floor is honoured: with the floor set high, a bin is never pushed below that fraction even
    /// under heavy over-subtraction — the guard against musical noise. Bite: floor 0 lets it collapse.
    #[test]
    fn the_spectral_floor_prevents_zeroing() {
        let mut sig = tone(300.0, 2.0, 0.02); // quiet steady tone ~ treated as its own noise
        let mut seed = 7u32;
        for s in sig.iter_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *s += ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.02;
        }
        let heavy = Options { highpass_hz: 0.0, oversubtract: 5.0, floor: 0.3 };
        let kept = rms(&spectral_subtract(&sig, &heavy)) / rms(&sig);
        assert!(kept > 0.2, "a 0.3 floor must keep the signal from collapsing under 5x oversubtract: {kept}");
        let nofloor = Options { highpass_hz: 0.0, oversubtract: 5.0, floor: 0.0 };
        let collapsed = rms(&spectral_subtract(&sig, &nofloor)) / rms(&sig);
        assert!(collapsed < kept, "with no floor the same signal collapses further: {collapsed} < {kept}");
    }

    /// The RNNoise engine refuses non-48kHz (the network's trained rate) rather than silently
    /// producing garbage, and at 48kHz it runs and preserves length. Quality is judged by ear on
    /// real speech, not asserted on a synthetic tone RNNoise's speech-trained VAD would gate.
    #[test]
    fn rnnoise_requires_48k_and_preserves_length() {
        let sig = tone(300.0, 0.5, 0.3); // SR = 16000
        assert!(denoise_rnnoise(&sig, SR).is_err(), "non-48k must be refused, not fudged");
        let n = 48_000usize / 2;
        let s48: Vec<f32> = (0..n).map(|i| 0.2 * (2.0 * PI * 300.0 * i as f32 / 48_000.0).sin()).collect();
        let out = denoise_rnnoise(&s48, 48_000).expect("48k must run");
        assert_eq!(out.len(), s48.len(), "denoise must preserve length");
    }

    /// Clean, INTERMITTENT audio survives the pass near unity — the cleaning must not distort what
    /// was already clean. The signal has to be intermittent (tone bursts with silent gaps) because
    /// that is the structure spectral subtraction assumes: it estimates noise from the quiet frames.
    /// A perfectly unbroken tone has no quiet frames and is correctly treated as noise — a real
    /// property to know, not a failure, and the reason speech (which has gaps) is the right input.
    #[test]
    fn clean_intermittent_audio_survives_the_pass_at_unity_gain() {
        // 200ms tone, 200ms silence, repeated — like speech, it has gaps for the estimator.
        let burst = tone(300.0, 0.2, 0.3);
        let gap = vec![0.0f32; SR as usize / 5];
        let mut sig = Vec::new();
        for _ in 0..5 {
            sig.extend_from_slice(&burst);
            sig.extend_from_slice(&gap);
        }
        let out = spectral_subtract(&sig, &Options::default());
        // Measure on a burst region, not the whole (the gaps dilute rms equally either way).
        let b = SR as usize / 20..SR as usize / 5 - SR as usize / 20;
        let ratio = rms(&out[b.clone()]) / rms(&sig[b]);
        assert!((0.6..=1.4).contains(&ratio), "clean intermittent input should survive near unity, got {ratio}");
    }
}
