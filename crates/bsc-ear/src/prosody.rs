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
    /// Harmonics-to-noise ratio in dB, or `None` when the frame is unvoiced.
    ///
    /// Free, and it was being thrown away: [`f0_autocorr`] already normalises its correlation and
    /// picks a peak, and that peak IS the harmonic fraction. See [`hnr_from_peak`].
    pub hnr_db: Option<f32>,
    /// Cycle-to-cycle variation in PERIOD, as a fraction of the mean period. `None` when the frame
    /// is unvoiced or holds too few glottal pulses to average over — see [`MIN_CYCLES`].
    pub jitter: Option<f32>,
    /// Cycle-to-cycle variation in AMPLITUDE, as a fraction of the mean pulse amplitude.
    pub shimmer: Option<f32>,
}

/// The quietest harmonics-to-noise ratio worth reporting, in dB.
///
/// A frame at the voicing threshold is already most noise, and the estimator's log runs to negative
/// infinity as the correlation approaches zero. Reporting a floor keeps the number comparable
/// instead of letting one breathy frame dominate every mean it enters.
pub const HNR_FLOOR_DB: f32 = -10.0;
/// The loudest worth reporting. A real larynx does not exceed this; a frame that claims to is a
/// synthetic tone or a numerical artefact of near-perfect correlation.
pub const HNR_CEIL_DB: f32 = 40.0;

/// The smallest number of glottal pulses that can yield a jitter figure.
///
/// Jitter averages the DIFFERENCES between consecutive periods, so three pulses give two periods and
/// one difference — a single number with no spread, which is not an average. Four is the floor at
/// which the mean means anything, and a 40 ms frame holds that many cycles from about 100 Hz up.
pub const MIN_CYCLES: usize = 4;

/// How far from its expected position the next pulse may sit, as a fraction of the period.
///
/// Wide enough to follow real perturbation — a disordered voice moves several percent cycle to
/// cycle — and narrow enough that the search cannot skip to the neighbouring pulse and report a
/// period that never happened.
const PULSE_SEARCH: f32 = 0.25;

/// Estimate the fundamental by normalised autocorrelation.
///
/// Returns `None` when the frame is unvoiced. The normalisation is what makes the threshold mean
/// the same thing at every volume — a raw autocorrelation peak scales with energy, so a fixed
/// threshold against it would call loud noise voiced and quiet speech silent.
pub fn f0_autocorr(frame: &[f32], sample_rate: u32) -> Option<f32> {
    f0_and_hnr(frame, sample_rate).map(|(f0, _)| f0)
}

/// Harmonics-to-noise ratio in dB, from the normalised autocorrelation peak.
///
/// Boersma's estimator. A periodic signal correlates with itself at its own period and whatever is
/// left over is noise, so `r / (1 - r)` IS the harmonic-to-noise POWER ratio and ten times its log
/// is the dB figure. This is not a second analysis of the frame: the peak is already computed to
/// find the pitch, and was being discarded.
pub fn hnr_from_peak(r: f32) -> f32 {
    // THE LIMITS ARE THE dB CONSTANTS, and nothing else may encode them. This used to clamp `r` to
    // 0.999 first, which caps the ratio at 10*log10(999) = 30 dB and made HNR_CEIL_DB = 40
    // unreachable — two numbers for one limit, where raising the named one silently changed
    // nothing. Saturating on `r` directly means the ceiling is whatever the constant says.
    if r >= 1.0 {
        // Perfect periodicity. The log would be infinity, and an infinity makes every later
        // comparison quietly return false instead of failing.
        return HNR_CEIL_DB;
    }
    if r <= f32::EPSILON {
        // No correlation at all, or anti-correlation: no harmonic content to take a ratio of.
        return HNR_FLOOR_DB;
    }
    (10.0 * (r / (1.0 - r)).log10()).clamp(HNR_FLOOR_DB, HNR_CEIL_DB)
}

/// Correlation at ONE lag, normalised against the energy of the OVERLAP ALONE.
///
/// THE SEARCH ARRAY AND THE RATIO NEED DIFFERENT NORMALISATIONS, and using one for both is what
/// this exists to stop. The search in [`f0_and_hnr`] divides by the whole frame's energy while the
/// sums run only to `len - lag`, so its score carries a taper that shrinks with lag. For CHOOSING a
/// period that is harmless and mildly useful — it penalises long lags, biasing the search away from
/// sub-harmonics. For a RATIO it is a lie: at 120 Hz in a 40 ms frame only 79% of the samples have a
/// partner, so a perfectly periodic signal scores sqrt(0.79) = 0.89 and reports 9 dB of noise that
/// is not in the signal. MEASURED: the synthetic vowel read 9.18 dB before this correction.
///
/// Praat corrects the same bias by dividing by the window's own autocorrelation. Doing it at the
/// chosen lag only keeps every existing voicing decision — and the corpus measurements that rest on
/// them — exactly as they were.
fn overlap_correlation(frame: &[f32], lag: usize) -> f32 {
    if lag >= frame.len() {
        return 0.0;
    }
    let (mut num, mut den_a, mut den_b) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..frame.len() - lag {
        num += frame[i] * frame[i + lag];
        den_a += frame[i] * frame[i];
        den_b += frame[i + lag] * frame[i + lag];
    }
    if den_a <= f32::EPSILON || den_b <= f32::EPSILON {
        return 0.0;
    }
    num / (den_a.sqrt() * den_b.sqrt())
}

/// Index of the largest sample in a slice.
fn argmax(v: &[f32]) -> usize {
    v.iter()
        .enumerate()
        .fold((0usize, f32::NEG_INFINITY), |(bi, bv), (i, &x)| if x > bv { (i, x) } else { (bi, bv) })
        .0
}

/// Locate successive glottal pulses, seeded by the period the pitch detector already found.
///
/// Tracked rather than peak-picked wholesale: the expected position of the next pulse is one period
/// on, and only a narrow window around it is searched. A global peak-picker on a harmonic-rich vowel
/// finds the harmonics too, and the periods it then reports are fractions of the real one.
fn pulses(frame: &[f32], period: f32) -> Vec<(usize, f32)> {
    let p = period.round() as usize;
    if p < 2 || frame.len() < p * 2 {
        return vec![];
    }
    let w = ((period * PULSE_SEARCH).round() as usize).max(1);
    // Start on a real peak rather than wherever the frame happened to be cut: the strongest sample
    // in the opening period and a half.
    let first_end = (p + p / 2).min(frame.len());
    let mut at = argmax(&frame[..first_end]);
    let mut out = vec![(at, frame[at])];
    loop {
        let expect = at + p;
        let lo = expect.saturating_sub(w);
        let hi = (expect + w + 1).min(frame.len());
        if lo >= hi {
            break;
        }
        let k = lo + argmax(&frame[lo..hi]);
        if k <= at {
            break;
        }
        out.push((k, frame[k]));
        at = k;
    }
    out
}

/// Mean absolute difference between consecutive values, over their mean.
///
/// The "local" form of both jitter and shimmer, and DIMENSIONLESS — which is what makes it survive a
/// gain change, unlike the absolute perturbation it is derived from.
fn rel_mean_abs_diff(v: &[f32]) -> Option<f32> {
    if v.len() < 2 {
        return None;
    }
    let m = mean(v);
    if m.abs() <= f32::EPSILON {
        return None;
    }
    let diffs: Vec<f32> = v.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
    Some(mean(&diffs) / m)
}

/// Jitter and shimmer for one voiced frame, as fractions of the mean period and mean amplitude.
///
/// Both are reported as fractions rather than the percentages the clinical literature prints —
/// multiply by 100 for that convention. `None` when the frame holds fewer than [`MIN_CYCLES`]
/// pulses, because a mean over one difference is not a mean.
pub fn jitter_shimmer(frame: &[f32], sample_rate: u32, f0: f32) -> Option<(f32, f32)> {
    if f0 <= 0.0 {
        return None;
    }
    let p = pulses(frame, sample_rate as f32 / f0);
    if p.len() < MIN_CYCLES {
        return None;
    }
    let periods: Vec<f32> = p.windows(2).map(|w| (w[1].0 - w[0].0) as f32).collect();
    let amps: Vec<f32> = p.iter().map(|(_, a)| a.abs()).collect();
    Some((rel_mean_abs_diff(&periods)?, rel_mean_abs_diff(&amps)?))
}

/// Estimate the fundamental AND the harmonic fraction in one pass.
///
/// The pair exists because they come from the same computation: the normalised autocorrelation peak
/// that identifies the period also states how much of the frame is periodic. [`f0_autocorr`] is the
/// pitch-only wrapper, kept because most callers want exactly that.
pub fn f0_and_hnr(frame: &[f32], sample_rate: u32) -> Option<(f32, f32)> {
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
    // The correlation AT THE CHOSEN LAG, not `strongest`. The two differ whenever the shortest
    // qualifying peak is taken at 85% of the strongest, and the harmonic fraction belongs to the
    // period actually reported — otherwise a frame's HNR describes a period its own f0 rejected.
    //
    // RECOMPUTED rather than read out of `r`, because `r` carries the search taper that
    // [`overlap_correlation`] exists to remove. Reading `r[best_lag]` here understates every HNR by
    // an amount that depends on the pitch, which would make a low voice look noisier than a high one
    // for a reason that is purely an artefact of the frame length.
    Some((sample_rate as f32 / best_lag as f32, hnr_from_peak(overlap_correlation(frame, best_lag))))
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
            // Pitch and the harmonic fraction come from ONE pass; jitter and shimmer need the period
            // that pass found, so they are measured on the same band-limited copy rather than the raw
            // signal — a glottal pulse is a fundamental-band event, and the unfiltered waveform's
            // largest sample is as often a fricative as a pulse.
            let (f0, hnr_db) = match f0_and_hnr(bnd, sample_rate) {
                Some((f, h)) => (Some(f), Some(h)),
                None => (None, None),
            };
            let (jitter, shimmer) = f0
                .and_then(|f| jitter_shimmer(bnd, sample_rate, f))
                .map_or((None, None), |(j, s)| (Some(j), Some(s)));
            Frame { f0, rms: crate::audio::rms(raw), zcr: zcr(raw), hnr_db, jitter, shimmer }
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
    /// Median harmonics-to-noise ratio over the voiced frames, in dB. Higher is a cleaner voice;
    /// breathiness, hoarseness and noise all pull it down.
    ///
    /// VOICE QUALITY, NOT AROUSAL. This and the two below are deliberately absent from
    /// [`arousal`]'s weighted sum: that score is about how ACTIVATED a voice is, its weights were
    /// set against measured arousal correlates, and quietly folding quality measures into it would
    /// redefine what it means while every existing claim about it still read as true.
    pub hnr_db: f32,
    /// Median cycle-to-cycle PERIOD variation, as a fraction of the mean period. Multiply by 100
    /// for the percentage the clinical literature prints.
    pub jitter_local: f32,
    /// Median cycle-to-cycle AMPLITUDE variation, as a fraction of the mean pulse amplitude.
    pub shimmer_local: f32,
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

    // MEDIAN, and only over the frames that actually produced a value. A frame with too few glottal
    // pulses reports nothing rather than zero — zero is a claim of perfect periodicity, which is the
    // opposite of "could not tell" — so folding the absent ones in as zeros would make a segment look
    // steadier the less of it could be measured.
    let median_of = |mut v: Vec<f32>| -> f32 {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        percentile(&v, 0.5)
    };
    let hnrs: Vec<f32> = frames.iter().filter_map(|f| f.hnr_db).collect();
    let jitters: Vec<f32> = frames.iter().filter_map(|f| f.jitter).collect();
    let shimmers: Vec<f32> = frames.iter().filter_map(|f| f.shimmer).collect();

    Prosody {
        f0_median: percentile(&voiced, 0.5),
        f0_range: (percentile(&voiced, 0.9) - percentile(&voiced, 0.1)).max(0.0),
        rms_mean: mean(&rmss),
        rms_sd: sd(&rmss),
        zcr_mean: mean(&zcrs),
        voiced_fraction: voiced.len() as f32 / frames.len() as f32,
        onset_rate: if duration_s > 0.0 { onsets as f32 / duration_s } else { 0.0 },
        duration_s,
        hnr_db: median_of(hnrs),
        jitter_local: median_of(jitters),
        shimmer_local: median_of(shimmers),
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
    /// The voice-QUALITY habit, accumulated alongside the arousal correlates above but scored
    /// separately — see [`Prosody::hnr_db`] for why these stay out of [`arousal`].
    ///
    /// `serde(default)` because a baseline stored before these existed must still load: an absent
    /// field reads as an empty history, which [`Baseline::z`] already treats as no information
    /// rather than as a measurement of zero.
    #[serde(default)]
    hnr_db: Vec<f32>,
    #[serde(default)]
    jitter_local: Vec<f32>,
    #[serde(default)]
    shimmer_local: Vec<f32>,
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
        self.hnr_db.push(p.hnr_db);
        self.jitter_local.push(p.jitter_local);
        self.shimmer_local.push(p.shimmer_local);
    }

    /// How far this segment's VOICE QUALITY sits from the speaker's habit, per measure.
    ///
    /// Separate from [`arousal`] on purpose, and it returns the parts rather than a composite: there
    /// is no measured weighting for these the way there is for the arousal correlates, and inventing
    /// one would be the single unarguable number this module exists to avoid. `grounded` carries the
    /// same meaning it does there — below [`MIN_BASELINE`] the z-scores are noise dressed as
    /// measurement.
    pub fn quality_z(&self, p: &Prosody) -> QualityZ {
        QualityZ {
            z_hnr: Baseline::z(&self.hnr_db, p.hnr_db),
            z_jitter: Baseline::z(&self.jitter_local, p.jitter_local),
            z_shimmer: Baseline::z(&self.shimmer_local, p.shimmer_local),
            grounded: self.ready(),
        }
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

/// How this segment's VOICE QUALITY compares with the speaker's habit.
///
/// The parts only, with no composite. The arousal weights below were set against measured arousal
/// correlates; nothing equivalent has been measured for quality, so combining these would be an
/// invented weighting wearing the authority of the measured one.
///
/// A POSITIVE jitter or shimmer z means MORE cycle-to-cycle variation than usual, and a NEGATIVE
/// HNR z means a noisier voice than usual — so the impaired direction is not the same sign on every
/// axis, and a reader must be told which way each one points rather than infer it.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct QualityZ {
    pub z_hnr: f32,
    pub z_jitter: f32,
    pub z_shimmer: f32,
    /// False when the baseline is too thin to mean anything — the same contract [`Arousal`] keeps.
    pub grounded: bool,
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

    /// A clean periodic signal is nearly all harmonics; noise is nearly all noise. The estimator has
    /// to separate those by a wide margin or it is measuring nothing.
    #[test]
    fn harmonics_to_noise_separates_a_tone_from_noise() {
        let clean = measure(&frames(&voiced(120.0, 1.0, 0.3), SR), SR);
        assert!(clean.hnr_db > 15.0, "a synthetic vowel should be strongly harmonic, got {}", clean.hnr_db);

        // Noise loud enough to be analysed at all, so this tests the ESTIMATOR rather than the
        // silence gate that would otherwise reject the frame before any correlation runs.
        let hissy = measure(&frames(&noise(1.0, 0.05), SR), SR);
        // WHAT THE TWO ARMS EACH ESTABLISH, stated because the aggregate alone is ambiguous: an
        // unvoiced segment reports 0 dB (percentile of an empty vector), so "noise scores low"
        // could mean the estimator ranked it low OR that nothing reached the estimator at all.
        // Pinning both voiced fractions separates those, and both readings are findings worth
        // keeping — a tone must be voiced throughout, and noise must not be read as voiced.
        assert!(clean.voiced_fraction > 0.9, "a steady tone must be voiced, got {}", clean.voiced_fraction);
        assert!(hissy.voiced_fraction < 0.25, "noise must not read as voiced, got {}", hissy.voiced_fraction);
        assert!(
            hissy.hnr_db < clean.hnr_db - 10.0,
            "noise ({}) must sit far below a tone ({})",
            hissy.hnr_db,
            clean.hnr_db
        );

        // The floor and ceiling hold, so one pathological frame cannot dominate a mean it enters.
        assert_eq!(hnr_from_peak(0.0), HNR_FLOOR_DB);
        assert_eq!(hnr_from_peak(1.0), HNR_CEIL_DB, "perfect correlation must not report infinity");
        assert!(hnr_from_peak(0.5).abs() < 0.001, "r = 0.5 is equal parts harmonic and noise: 0 dB");
    }

    /// A voice with a KNOWN period perturbation must read back at roughly that perturbation.
    ///
    /// The signal is built by emitting one cycle at a time and alternating the period by a fixed
    /// fraction, so the mean absolute difference between consecutive periods IS that fraction — the
    /// answer is known by construction rather than by running the code and blessing the output.
    #[test]
    fn jitter_recovers_a_known_period_perturbation() {
        let steady = perturbed(120.0, 1.0, 0.3, 0.0, 0.0);
        let jittered = perturbed(120.0, 1.0, 0.3, 0.04, 0.0);

        let (a, b) = (measure(&frames(&steady, SR), SR), measure(&frames(&jittered, SR), SR));
        assert!(
            b.jitter_local > a.jitter_local * 2.0,
            "4% period perturbation ({}) must read well above steady ({})",
            b.jitter_local,
            a.jitter_local
        );
        assert!(b.jitter_local < 0.25, "and must stay in the right order of magnitude: {}", b.jitter_local);
    }

    /// The amplitude twin of the test above, and it must move INDEPENDENTLY: perturbing amplitude
    /// alone must not be reported as period instability.
    #[test]
    fn shimmer_recovers_an_amplitude_perturbation_without_moving_jitter() {
        let steady = measure(&frames(&perturbed(120.0, 1.0, 0.3, 0.0, 0.0), SR), SR);
        let shimmered = measure(&frames(&perturbed(120.0, 1.0, 0.3, 0.0, 0.20), SR), SR);

        assert!(
            shimmered.shimmer_local > steady.shimmer_local * 2.0,
            "20% amplitude perturbation ({}) must read above steady ({})",
            shimmered.shimmer_local,
            steady.shimmer_local
        );
        assert!(
            shimmered.jitter_local < 0.05,
            "amplitude perturbation must not leak into jitter: {}",
            shimmered.jitter_local
        );
    }

    /// A mean over one difference is not a mean. Too few pulses must report NOTHING rather than a
    /// confident zero — zero claims perfect periodicity, which is the opposite of "could not tell".
    #[test]
    fn too_few_cycles_reports_nothing_rather_than_perfect_periodicity() {
        // At 60 Hz a 40 ms frame holds under three cycles, short of MIN_CYCLES.
        let flen = (SR as usize * FRAME_MS as usize) / 1000;
        let low = voiced(60.0, 0.2, 0.3);
        let banded = voice_band(&low, SR);
        assert_eq!(jitter_shimmer(&banded[..flen], SR, 60.0), None, "under {MIN_CYCLES} pulses");
        assert_eq!(jitter_shimmer(&banded[..flen], SR, 0.0), None, "an unvoiced frame has no cycles");
    }

    /// VOICE QUALITY IS NOT AROUSAL, and this pins the decision. The quality measures are scored
    /// separately; folding them into the arousal composite would redefine a number whose weights
    /// were set against measured arousal correlates, while every existing claim about it still read
    /// as true.
    #[test]
    fn quality_is_scored_apart_from_arousal() {
        let mut b = Baseline::default();
        for hz in [110.0, 115.0, 108.0, 112.0, 118.0, 105.0, 111.0] {
            b.observe(&measure(&frames(&voiced(hz, 1.0, 0.2), SR), SR));
        }
        assert!(b.ready());

        // A voice that is ordinary in pitch and rate but much noisier than habit.
        let mut rough = perturbed(111.0, 1.0, 0.2, 0.06, 0.25);
        for (i, s) in rough.iter_mut().enumerate() {
            let t = i as f32 / SR as f32;
            *s += 0.02 * ((i as f32 * 7.3).sin() + (t * 3000.0).cos());
        }
        let p = measure(&frames(&rough, SR), SR);

        let q = b.quality_z(&p);
        assert!(q.grounded, "the baseline is ready, so quality must be grounded too");
        assert!(
            q.z_jitter > 0.5 || q.z_shimmer > 0.5 || q.z_hnr < -0.5,
            "a rougher voice must move at least one quality axis: {q:?}"
        );
        assert!(q.z_hnr.is_finite() && q.z_jitter.is_finite() && q.z_shimmer.is_finite());
    }

    /// A vowel whose period and amplitude are perturbed by KNOWN fractions, one cycle at a time.
    ///
    /// Built cycle-by-cycle rather than by modulating a continuous sine, because the quantity under
    /// test is the difference between CONSECUTIVE periods — a slow vibrato would move the mean period
    /// without producing the cycle-to-cycle difference jitter is defined as.
    fn perturbed(hz: f32, secs: f32, amp: f32, jitter: f32, shimmer: f32) -> Vec<f32> {
        let total = (SR as f32 * secs) as usize;
        let base = SR as f32 / hz;
        let mut out: Vec<f32> = Vec::with_capacity(total);
        let mut cycle = 0usize;
        while out.len() < total {
            // Alternating, so every consecutive pair differs by the full fraction.
            let sign = if cycle.is_multiple_of(2) { 1.0 } else { -1.0 };
            let period = (base * (1.0 + sign * jitter)).max(2.0);
            let a = amp * (1.0 + sign * shimmer);
            let n = period.round() as usize;
            for i in 0..n {
                if out.len() >= total {
                    break;
                }
                let w = 2.0 * std::f32::consts::PI * (i as f32 / period);
                out.push(a * (w.sin() + 0.5 * (2.0 * w).sin() + 0.25 * (3.0 * w).sin()));
            }
            cycle += 1;
        }
        out
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
