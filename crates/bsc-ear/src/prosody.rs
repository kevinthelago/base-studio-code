//! Prosody — the measurable half of how something was said.
//!
//! This module deliberately does NOT classify emotion. Categorical speech-emotion models benchmark
//! around 70% on ACTED corpora and fall apart on spontaneous speech, and the label they emit
//! ("sad: 0.61") cannot be argued with because nothing about it is inspectable. What IS robust is
//! arousal — how activated the voice is — because it rides on physical correlates that are
//! straightforwardly measurable: pitch goes up and spreads out, the voice gets louder and less
//! even, speech gets faster, and vocal effort pushes energy higher up the spectrum.
//!
//! So this measures those, reports them individually, and combines them into ONE number that can
//! always be taken apart again. Valence — pleasant versus unpleasant — is deliberately absent: it
//! is the dimension acoustic models are worst at, and the transcript carries it far better.
//!
//! **Everything here is relative to the speaker.** A quiet person at their most animated may never
//! reach a loud person's baseline, so an absolute arousal number describes the microphone and the
//! larynx rather than the moment. [`Baseline`] is what makes the number mean anything.

use serde::{Deserialize, Serialize};

/// The band a human fundamental actually lives in.
///
/// Below this is not voice: mains hum, HVAC, desk thumps and handling noise, all of which carry
/// real energy and none of which has a pitch worth finding.
pub const VOICE_HP_HZ: f32 = 70.0;
/// Above this is harmonics, not the fundamental.
///
/// THIS IS THE FIX FOR OCTAVE ERRORS, and it is upstream of the peak-picking rather than a
/// threshold tuned against it. Autocorrelation cannot tell a fundamental from its own harmonics —
/// a voice with a strong second harmonic correlates nearly as well at half its true period, which
/// is how a 160 Hz "oh my god" was read as 340 Hz. Removing the harmonics before correlating
/// leaves the fundamental as the only thing left to lock onto. Standard practice in every
/// autocorrelation pitch detector, and no amount of tolerance-tuning substitutes for it — measured
/// across tolerances from 0.85 to 0.98, the implausible readings did not move at all.
pub const VOICE_LP_HZ: f32 = 900.0;

/// A single biquad section (RBJ cookbook). Enough filter for this, and no dependency.
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn new(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 }
    }

    pub fn lowpass(sample_rate: u32, cutoff_hz: f32, q: f32) -> Self {
        let w = 2.0 * std::f32::consts::PI * cutoff_hz / sample_rate as f32;
        let (sn, cs) = (w.sin(), w.cos());
        let alpha = sn / (2.0 * q);
        Biquad::new((1.0 - cs) / 2.0, 1.0 - cs, (1.0 - cs) / 2.0, 1.0 + alpha, -2.0 * cs, 1.0 - alpha)
    }

    pub fn highpass(sample_rate: u32, cutoff_hz: f32, q: f32) -> Self {
        let w = 2.0 * std::f32::consts::PI * cutoff_hz / sample_rate as f32;
        let (sn, cs) = (w.sin(), w.cos());
        let alpha = sn / (2.0 * q);
        Biquad::new((1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0, 1.0 + alpha, -2.0 * cs, 1.0 - alpha)
    }

    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        if y.is_finite() {
            y
        } else {
            0.0
        }
    }
}

/// Band-limit to the voice's fundamental range, for PITCH ONLY.
///
/// Applied to a copy: loudness and zero-crossing rate are measured on the RAW signal, because
/// zero-crossing rate is a stand-in for spectral tilt and lowpassing at 900 Hz would delete exactly
/// the high-frequency content it exists to measure. Each feature gets the signal it needs.
pub fn voice_band(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    const Q: f32 = 0.707; // Butterworth
    let mut hp = Biquad::highpass(sample_rate, VOICE_HP_HZ, Q);
    let mut lp = Biquad::lowpass(sample_rate, VOICE_LP_HZ, Q);
    samples.iter().map(|s| lp.process(hp.process(*s))).collect()
}

/// Frames are 40 ms so the lowest pitch we look for fits twice inside one.
pub const FRAME_MS: u32 = 40;
/// 20 ms hop — frames overlap by half, so a short vowel is not missed between them.
pub const HOP_MS: u32 = 20;
/// The human speech range we search. Below 50 Hz is room rumble; above 400 Hz is mostly a
/// harmonic being mistaken for the fundamental.
pub const F0_MIN_HZ: f32 = 50.0;
pub const F0_MAX_HZ: f32 = 400.0;
/// Normalised autocorrelation below this is called unvoiced. Deliberately not near zero: noise
/// correlates with itself, and a detector that finds pitch in silence reports a confident number
/// about nothing.
pub const VOICING_THRESHOLD: f32 = 0.35;
/// A frame quieter than this is not analysed for pitch at all.
///
/// MEASURED, and it is not a nicety. Without it seven of twenty-three real segments reported a
/// confident f0 of exactly 400 Hz — the ceiling — every one of them near-silent at rms 0.0015. Two
/// causes compound: adjacent samples of ANY band-limited signal correlate, so the shortest lags
/// (highest frequencies) always score well, and normalising a near-zero frame divides small by
/// small. The result is the exact failure this module was written to avoid: a confident number
/// about nothing.
pub const MIN_VOICED_RMS: f32 = 0.005;

/// One frame's verdict.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Frame {
    /// Fundamental frequency in Hz, or `None` when the frame is unvoiced.
    pub f0: Option<f32>,
    pub rms: f32,
    /// Zero-crossing rate, a cheap stand-in for spectral tilt: vocal effort pushes energy upward,
    /// and more high-frequency content crosses zero more often. Cheap enough to need no FFT, which
    /// keeps this module dependency-free.
    pub zcr: f32,
}

/// Estimate the fundamental by normalised autocorrelation.
///
/// Returns `None` when the frame is unvoiced. The normalisation is what makes the threshold mean
/// the same thing at every volume — a raw autocorrelation peak scales with energy, so a fixed
/// threshold against it would call loud noise voiced and quiet speech silent.
pub fn f0_autocorr(frame: &[f32], sample_rate: u32) -> Option<f32> {
    let min_lag = (sample_rate as f32 / F0_MAX_HZ) as usize;
    let max_lag = (sample_rate as f32 / F0_MIN_HZ) as usize;
    if frame.len() <= max_lag || min_lag >= max_lag {
        return None;
    }
    let energy: f32 = frame.iter().map(|s| s * s).sum();
    if energy <= f32::EPSILON {
        return None;
    }
    // Silence has no pitch. Gated before any correlation is computed — see MIN_VOICED_RMS.
    if (energy / frame.len() as f32).sqrt() < MIN_VOICED_RMS {
        return None;
    }

    let mut r = vec![0.0f32; max_lag + 2];
    for lag in min_lag..=max_lag {
        let mut num = 0.0f32;
        let mut den_b = 0.0f32;
        for i in 0..frame.len() - lag {
            num += frame[i] * frame[i + lag];
            den_b += frame[i + lag] * frame[i + lag];
        }
        if den_b > f32::EPSILON {
            // Normalised against BOTH windows, so the score is a correlation in [-1, 1] rather
            // than something that grows with loudness.
            r[lag] = num / (energy.sqrt() * den_b.sqrt());
        }
    }

    // A TRUE PERIOD IS A LOCAL PEAK, and requiring that is what stops the ceiling being reported.
    // The global maximum alone is not enough: correlation rises monotonically toward the shortest
    // lags for any band-limited signal, so an ungated search lands on `min_lag`, which IS
    // `F0_MAX_HZ`, whenever the frame has no real periodicity.
    //
    // Among genuine peaks, the SHORTEST one within reach of the strongest wins. Autocorrelation
    // peaks at EVERY multiple of the true period, so the long lags are sub-harmonics — preferring
    // them reads 120 Hz as 60 Hz, which is what this code did before the test caught it. Requiring
    // the peak to be near-maximal is the other half: it rejects the weak short-lag peak that a
    // strong second harmonic produces when the fundamental is faint.
    let peak = |lag: usize| r[lag] >= r[lag - 1] && r[lag] > r[lag + 1];
    let strongest = (min_lag + 1..max_lag).filter(|&l| peak(l)).fold(0.0f32, |m, l| m.max(r[l]));
    if strongest < VOICING_THRESHOLD {
        return None;
    }
    let best_lag = (min_lag + 1..max_lag).find(|&l| peak(l) && r[l] >= strongest * 0.85)?;
    Some(sample_rate as f32 / best_lag as f32)
}

/// Zero crossings per sample.
pub fn zcr(frame: &[f32]) -> f32 {
    if frame.len() < 2 {
        return 0.0;
    }
    let crossings = frame.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
    crossings as f32 / (frame.len() - 1) as f32
}

/// Analyse a whole segment into frames.
pub fn frames(samples: &[f32], sample_rate: u32) -> Vec<Frame> {
    let flen = (sample_rate as usize * FRAME_MS as usize) / 1000;
    let hop = (sample_rate as usize * HOP_MS as usize) / 1000;
    if flen == 0 || hop == 0 || samples.len() < flen {
        return vec![];
    }
    // Pitch reads the band-limited copy; loudness and zero-crossing rate read the raw signal.
    let banded = voice_band(samples, sample_rate);
    (0..=(samples.len() - flen) / hop)
        .map(|i| {
            let raw = &samples[i * hop..i * hop + flen];
            let bnd = &banded[i * hop..i * hop + flen];
            Frame { f0: f0_autocorr(bnd, sample_rate), rms: crate::audio::rms(raw), zcr: zcr(raw) }
        })
        .collect()
}

/// The measurements, each one inspectable on its own.
///
/// Kept separate from the arousal score on purpose: a single number nobody can take apart is
/// exactly the black box this module exists to avoid being.
#[derive(Clone, Copy, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct Prosody {
    /// Median voiced pitch, Hz. Median rather than mean — octave errors are the classic failure of
    /// autocorrelation pitch, and one halved frame drags a mean while barely moving a median.
    pub f0_median: f32,
    /// Spread of voiced pitch: the 10th-to-90th percentile range, in Hz. A monotone has a narrow
    /// one however high it sits.
    pub f0_range: f32,
    pub rms_mean: f32,
    /// Standard deviation of frame energy — an animated voice is uneven, not merely loud.
    pub rms_sd: f32,
    pub zcr_mean: f32,
    /// Fraction of frames that were voiced.
    pub voiced_fraction: f32,
    /// Voiced onsets per second — a stand-in for syllable rate, which is a stand-in for how fast
    /// someone is talking. Not a phonetic count and not claimed to be one.
    pub onset_rate: f32,
    pub duration_s: f32,
}

fn percentile(sorted: &[f32], p: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f32 * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<f32>() / v.len() as f32
}

fn sd(v: &[f32]) -> f32 {
    if v.len() < 2 {
        return 0.0;
    }
    let m = mean(v);
    (v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / (v.len() - 1) as f32).sqrt()
}

/// Reduce frames to the measurements.
pub fn measure(frames: &[Frame], sample_rate: u32) -> Prosody {
    if frames.is_empty() {
        return Prosody::default();
    }
    let mut voiced: Vec<f32> = frames.iter().filter_map(|f| f.f0).collect();
    voiced.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rmss: Vec<f32> = frames.iter().map(|f| f.rms).collect();
    let zcrs: Vec<f32> = frames.iter().map(|f| f.zcr).collect();

    // An ONSET is a transition from unvoiced to voiced — roughly, the start of a syllable.
    let onsets = frames
        .windows(2)
        .filter(|w| w[0].f0.is_none() && w[1].f0.is_some())
        .count();
    let duration_s = (frames.len() as f32 * HOP_MS as f32) / 1000.0;
    let _ = sample_rate;

    Prosody {
        f0_median: percentile(&voiced, 0.5),
        f0_range: (percentile(&voiced, 0.9) - percentile(&voiced, 0.1)).max(0.0),
        rms_mean: mean(&rmss),
        rms_sd: sd(&rmss),
        zcr_mean: mean(&zcrs),
        voiced_fraction: voiced.len() as f32 / frames.len() as f32,
        onset_rate: if duration_s > 0.0 { onsets as f32 / duration_s } else { 0.0 },
        duration_s,
    }
}

/// One speaker's habitual prosody, against which a moment can be called activated or not.
///
/// THE WHOLE POINT. A quiet person at their most animated may never reach a loud person's resting
/// level, so an absolute arousal number describes the larynx and the microphone rather than the
/// moment. Accumulating a per-speaker baseline is also the honest answer to gain: turning the
/// preamp up shifts every number here together, and a z-score against the speaker's own history is
/// immune to that in a way a fixed threshold never is.
#[derive(Clone, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct Baseline {
    pub n: u32,
    f0_median: Vec<f32>,
    f0_range: Vec<f32>,
    rms_mean: Vec<f32>,
    rms_sd: Vec<f32>,
    zcr_mean: Vec<f32>,
    onset_rate: Vec<f32>,
}

/// Fewer samples than this and a z-score is noise dressed as a measurement.
pub const MIN_BASELINE: u32 = 6;

/// A segment with less voiced content than this carries no speech to measure.
///
/// It is not "low arousal" — it is not speech. Five of twenty-three real segments landed here, and
/// every one of them was a segment Whisper transcribed as "Thank you.", its well-known hallucination
/// on non-speech. Prosody and ASR disagreeing like that is a signal worth keeping, not smoothing
/// over: two independent measurements agreeing that nothing was said is stronger than either alone.
pub const MIN_VOICED_FRACTION: f32 = 0.05;

impl Prosody {
    /// Whether there is any speech here to talk about.
    pub fn has_speech(&self) -> bool {
        self.voiced_fraction >= MIN_VOICED_FRACTION && self.f0_median > 0.0
    }
}

impl Baseline {
    /// Only speech shapes the baseline. Folding silence in drags every mean toward zero and makes
    /// ordinary talking look activated by comparison.
    pub fn observe(&mut self, p: &Prosody) {
        if !p.has_speech() {
            return;
        }
        self.observe_unchecked(p)
    }

    fn observe_unchecked(&mut self, p: &Prosody) {
        self.n += 1;
        self.f0_median.push(p.f0_median);
        self.f0_range.push(p.f0_range);
        self.rms_mean.push(p.rms_mean);
        self.rms_sd.push(p.rms_sd);
        self.zcr_mean.push(p.zcr_mean);
        self.onset_rate.push(p.onset_rate);
    }

    pub fn ready(&self) -> bool {
        self.n >= MIN_BASELINE
    }

    fn z(v: &[f32], x: f32) -> f32 {
        let m = mean(v);
        let s = sd(v);
        // A feature that never varies carries no information; it must contribute 0 rather than
        // divide by ~0 and dominate the composite.
        //
        // THE GUARD IS RELATIVE, and an absolute epsilon is not enough — this cost a failing test to
        // find. Summing eight IDENTICAL f32 values and dividing leaves a mean a few ulps off, so
        // each deviation is ~1e-5 and so is the standard deviation: comfortably above `f32::EPSILON`
        // yet entirely floating-point noise. Dividing one by the other yields a z of about ±1, and a
        // speaker whose pitch barely varies would have had numerical dust reported as character.
        if s <= f32::EPSILON || s < m.abs() * 1e-4 {
            return 0.0;
        }
        ((x - m) / s).clamp(-4.0, 4.0)
    }
}

/// How activated this sounded, against the speaker's own habit.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct Arousal {
    /// Roughly a z-score: 0 is this speaker's ordinary, positive is more activated.
    pub score: f32,
    /// The parts, so the score can always be argued with.
    pub z_pitch: f32,
    pub z_pitch_range: f32,
    pub z_loudness: f32,
    pub z_variability: f32,
    pub z_effort: f32,
    pub z_rate: f32,
    /// False when the baseline is too thin to mean anything. A score without this is a number
    /// pretending to be a measurement.
    pub grounded: bool,
}

/// Weights over the five correlates. Pitch and its range dominate because they are the most robust
/// arousal cues in the literature and the least confounded by microphone gain; loudness is real but
/// is exactly what a preamp also changes, so it is weighted lower.
const W_PITCH: f32 = 0.25;
const W_RANGE: f32 = 0.25;
const W_LOUD: f32 = 0.15;
const W_VAR: f32 = 0.10;
const W_EFFORT: f32 = 0.10;
const W_RATE: f32 = 0.15;

/// Score one segment against a baseline.
pub fn arousal(p: &Prosody, b: &Baseline) -> Arousal {
    let z_pitch = Baseline::z(&b.f0_median, p.f0_median);
    let z_pitch_range = Baseline::z(&b.f0_range, p.f0_range);
    let z_loudness = Baseline::z(&b.rms_mean, p.rms_mean);
    let z_variability = Baseline::z(&b.rms_sd, p.rms_sd);
    let z_effort = Baseline::z(&b.zcr_mean, p.zcr_mean);
    let z_rate = Baseline::z(&b.onset_rate, p.onset_rate);
    Arousal {
        score: z_pitch * W_PITCH
            + z_pitch_range * W_RANGE
            + z_loudness * W_LOUD
            + z_variability * W_VAR
            + z_effort * W_EFFORT
            + z_rate * W_RATE,
        z_pitch,
        z_pitch_range,
        z_loudness,
        z_variability,
        z_effort,
        z_rate,
        grounded: b.ready(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 16_000;

    /// The band-limiting must not shave a genuinely high voice down to something plausible.
    ///
    /// MEASURED on real speech, and it nearly cost a correct reading: two segments read 333 Hz and
    /// 225 Hz, which looked like octave errors for a male speaker. Sweeping the cutoff from 900 Hz
    /// down to 400 Hz moved them to 314 and 216 — drifting with the filter's rolloff, never halving.
    /// An octave error collapses to half; these did not, so they were real, and the speaker had
    /// simply pitched up saying "oh my god". A tighter filter would have attenuated the truth into
    /// looking like the expectation.
    #[test]
    fn the_filter_passes_a_genuinely_high_fundamental_rather_than_flattening_it() {
        let high = voiced(300.0, 0.2, 0.3);
        let banded = voice_band(&high, SR);
        let flen = (SR as usize * FRAME_MS as usize) / 1000;
        let got = f0_autocorr(&banded[..flen], SR).expect("a 300Hz voice is still a voice");
        assert!((got - 300.0).abs() < 30.0, "a real 300Hz fundamental came back as {got}Hz");
    }

    #[test]
    fn the_filter_removes_rumble_and_leaves_the_voice() {
        let mut mixed = voiced(120.0, 0.5, 0.2);
        // 35 Hz desk thump, well below anything a larynx does, at twice the voice's amplitude.
        for (i, s) in mixed.iter_mut().enumerate() {
            let t = i as f32 / SR as f32;
            *s += 0.4 * (2.0 * std::f32::consts::PI * 35.0 * t).sin();
        }
        let banded = voice_band(&mixed, SR);
        let flen = (SR as usize * FRAME_MS as usize) / 1000;
        // Skip the filter's settling transient.
        let got = f0_autocorr(&banded[flen..flen * 2], SR).expect("voiced");
        assert!((got - 120.0).abs() < 15.0, "rumble dragged the pitch to {got}Hz");
    }

    /// A synthetic vowel: a fundamental plus two harmonics, which is what makes a pitch detector's
    /// octave problem real — the harmonics correlate strongly at fractions of the true period.
    fn voiced(hz: f32, secs: f32, amp: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let w = 2.0 * std::f32::consts::PI * hz * t;
                amp * (w.sin() + 0.5 * (2.0 * w).sin() + 0.25 * (3.0 * w).sin())
            })
            .collect()
    }

    fn noise(secs: f32, amp: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        (0..n)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                amp * (((state >> 40) as f32 / 8_388_608.0) - 1.0)
            })
            .collect()
    }

    #[test]
    fn a_known_pitch_is_recovered_within_a_few_hz() {
        for hz in [90.0, 120.0, 180.0, 240.0] {
            let f = voiced(hz, 0.04, 0.3);
            let got = f0_autocorr(&f, SR).unwrap_or_else(|| panic!("{hz}Hz read as unvoiced"));
            assert!((got - hz).abs() < hz * 0.06, "{hz}Hz came back as {got}Hz");
        }
    }

    /// THE BUG THIS MODULE SHIPPED WITH, found against real audio. Seven of twenty-three segments
    /// reported a confident f0 of exactly 400 Hz — the ceiling — every one near-silent. Correlation
    /// rises toward the shortest lags for any band-limited signal, so an ungated search lands on
    /// `min_lag`, which IS `F0_MAX_HZ`.
    #[test]
    fn silence_has_no_pitch_and_never_reports_the_ceiling() {
        let quiet = vec![0.0f32; (SR as f32 * 0.04) as usize];
        assert_eq!(f0_autocorr(&quiet, SR), None, "digital silence");

        let hiss = noise(0.04, 0.0015); // the measured level of the real dead segments
        assert_eq!(f0_autocorr(&hiss, SR), None, "quiet hiss must not be given a pitch");

        // And nothing may ever come back AT the ceiling, which is the fingerprint of the bug.
        for amp in [0.001, 0.003, 0.01, 0.05] {
            if let Some(f0) = f0_autocorr(&noise(0.04, amp), SR) {
                assert!(
                    f0 < F0_MAX_HZ - 1.0,
                    "noise at amp {amp} reported {f0}Hz, pinned at the ceiling"
                );
            }
        }
    }

    /// A period repeats at every multiple of itself, so a strong peak at half the true period is
    /// the classic octave-up error. Preferring the longest qualifying lag rejects it.
    #[test]
    fn a_harmonic_is_not_mistaken_for_the_fundamental() {
        let f = voiced(100.0, 0.04, 0.3);
        let got = f0_autocorr(&f, SR).expect("voiced");
        assert!(got < 150.0, "reported {got}Hz — an octave error on a 100Hz fundamental");
    }

    #[test]
    fn zero_crossing_rate_rises_with_frequency() {
        let low = zcr(&voiced(100.0, 0.04, 0.3));
        let high = zcr(&voiced(300.0, 0.04, 0.3));
        assert!(high > low, "300Hz ({high}) should cross zero more than 100Hz ({low})");
        assert_eq!(zcr(&[]), 0.0);
        assert_eq!(zcr(&[0.5]), 0.0, "one sample cannot cross");
    }

    #[test]
    fn measuring_a_steady_tone_gives_a_narrow_range_and_full_voicing() {
        let p = measure(&frames(&voiced(120.0, 1.0, 0.3), SR), SR);
        assert!(p.has_speech());
        assert!((p.f0_median - 120.0).abs() < 10.0, "median {}", p.f0_median);
        assert!(p.f0_range < 30.0, "a steady tone must not look expressive: range {}", p.f0_range);
        assert!(p.voiced_fraction > 0.9, "voiced {}", p.voiced_fraction);
    }

    /// Silence is NOT low arousal — it is an absence of speech, and scoring it as though it were
    /// the quiet end of a scale is how a baseline gets dragged until ordinary talking looks
    /// activated. Every one of the five real segments that landed here was also one ASR
    /// hallucinated "Thank you." over.
    #[test]
    fn a_segment_with_no_voiced_content_is_not_speech_and_never_enters_the_baseline() {
        let silent = measure(&frames(&noise(2.0, 0.0015), SR), SR);
        assert!(!silent.has_speech(), "voiced fraction {}", silent.voiced_fraction);

        let mut b = Baseline::default();
        for _ in 0..10 {
            b.observe(&silent);
        }
        assert_eq!(b.n, 0, "silence must not count toward the baseline");

        let real = measure(&frames(&voiced(120.0, 1.0, 0.3), SR), SR);
        b.observe(&real);
        assert_eq!(b.n, 1);
    }

    #[test]
    fn a_thin_baseline_is_reported_as_not_grounded_rather_than_scored_anyway() {
        let p = measure(&frames(&voiced(120.0, 1.0, 0.3), SR), SR);
        let mut b = Baseline::default();
        b.observe(&p);
        assert!(!arousal(&p, &b).grounded, "one sample is not a baseline");
        for _ in 0..MIN_BASELINE {
            b.observe(&p);
        }
        assert!(arousal(&p, &b).grounded);
    }

    /// A feature that never varies carries no information. It must contribute zero rather than
    /// divide by zero and take the whole composite to NaN — where every comparison is false and the
    /// score silently stops meaning anything instead of failing.
    #[test]
    fn a_feature_with_no_variance_contributes_nothing_instead_of_infinity() {
        let p = measure(&frames(&voiced(120.0, 1.0, 0.3), SR), SR);
        let mut b = Baseline::default();
        for _ in 0..8 {
            b.observe(&p); // identical every time: zero variance in every feature
        }
        let a = arousal(&p, &b);
        assert!(a.score.is_finite(), "score was {}", a.score);
        assert_eq!(a.score, 0.0, "identical to the baseline is exactly ordinary");
    }

    /// The direction the whole module rests on: a higher, wider, faster voice must score ABOVE the
    /// speaker's habit. Measured on real speech, f0 range tracked the score at r = +0.77.
    #[test]
    fn a_higher_and_wider_voice_scores_above_the_speakers_own_habit() {
        let mut b = Baseline::default();
        for hz in [110.0, 115.0, 108.0, 112.0, 118.0, 105.0, 111.0] {
            b.observe(&measure(&frames(&voiced(hz, 1.0, 0.2), SR), SR));
        }
        assert!(b.ready());

        let calm = measure(&frames(&voiced(110.0, 1.0, 0.2), SR), SR);
        // Excited: higher, and swept so the range is genuinely wider.
        let mut animated = voiced(170.0, 0.5, 0.35);
        animated.extend(voiced(230.0, 0.5, 0.35));
        let excited = measure(&frames(&animated, SR), SR);

        let (ca, ea) = (arousal(&calm, &b), arousal(&excited, &b));
        assert!(ea.score > ca.score, "excited {:.2} must exceed calm {:.2}", ea.score, ca.score);
        assert!(ea.z_pitch > 0.0, "pitch should read high, got {:.2}", ea.z_pitch);
    }
}
