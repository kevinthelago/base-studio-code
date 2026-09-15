//! Acoustics — how a voice MEASURES, not what it says.
//!
//! Two numbers carry most of whether a voice reads as male or female, and neither needs a model:
//!
//! - **Pitch (F0)** — how fast the vocal folds vibrate. Adult male speech sits around 85–155 Hz and
//!   female around 165–255 Hz, and the overlap near 150–175 Hz is where a listener hesitates.
//! - **Formant dispersion (ΔF)** — the average spacing of the vocal tract's resonances, which is set by
//!   the tract's LENGTH. A longer tract spaces them closer. This is the cue pitch alone misses: a
//!   raised voice through a long tract still sounds like a man speaking high.
//!
//! So neither is enough by itself, and a voice is placed on BOTH axes. [`Reference`] derives where
//! female and male sit from voices that are labelled, rather than from population averages, because
//! the question is "between these synthetic voices", and a synthetic voice need not match people.
//!
//! This is for SYNTHETIC voices. It is deliberately not on the `bsc ear` listening path — voice
//! attribution anonymizes everyone but the user, and a gender reading of a real person is not a
//! thing this system produces.

// Signal processing reads as index arithmetic, and the iterator spellings clippy suggests obscure
// which sample is being compared with which.
#![allow(clippy::needless_range_loop)]

/// The pitch search range. Below 60 Hz is creak, above 400 Hz is not speech from these voices.
pub const PITCH_MIN_HZ: f32 = 60.0;
pub const PITCH_MAX_HZ: f32 = 400.0;
/// YIN's aperiodicity threshold. 0.15 is the value its paper recommends for speech.
const YIN_THRESHOLD: f32 = 0.15;
/// Frames quieter than this fraction of the loudest frame are silence, not unvoiced speech.
const SILENCE_FRACTION: f32 = 0.05;
/// Formant analysis runs at about this rate: enough bandwidth for F3 of a high voice, few enough
/// LPC poles to find roots cheaply.
const FORMANT_RATE_HZ: u32 = 12_000;
/// A resonance wider than this is a spectral tilt artifact, not a formant.
const MAX_FORMANT_BANDWIDTH_HZ: f64 = 400.0;
/// Nothing below this is F1 — it is the glottal source or a nasal pole.
const MIN_FORMANT_HZ: f64 = 200.0;

/// What a clip measured as.
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    /// Median F0 over voiced frames, when any frame was voiced.
    pub f0_hz: Option<f32>,
    /// The fraction of non-silent frames that carried a pitch.
    pub voiced: f32,
    /// Median F1, F2 and F3 over voiced frames.
    pub formants: [Option<f32>; 3],
    /// Median per-frame formant dispersion — the vocal-tract-length cue.
    pub dispersion_hz: Option<f32>,
    /// How much the pitch MOVES, in semitones (a robust spread around the median). Intonation range
    /// is a cue of its own, and not the direction folklore expects: measured 2026-09-15 on Kokoro's
    /// English voices, the MALE median moved more (4.3 st against 3.5).
    pub f0_spread_st: Option<f32>,
    /// The RMS frequency of voiced speech — how bright or dark the tone is, independent of pitch.
    /// Measured the same day it did NOT separate the labels (female 715 Hz, male 657 Hz, inside one
    /// spread), so a reference built from those voices leaves it out of every grading.
    pub brightness_hz: Option<f32>,
}

/// Measure a clip.
pub fn profile(samples: &[f32], sample_rate: u32) -> Profile {
    let track = pitch_track(samples, sample_rate);
    let spoken = track.iter().filter(|f| f.is_some()).count();
    let voiced_frames: Vec<f32> = track.iter().filter_map(|f| f.flatten()).collect();
    let voiced = if spoken == 0 { 0.0 } else { voiced_frames.len() as f32 / spoken as f32 };
    let f0_hz = median(voiced_frames.clone());
    let f0_spread_st = f0_hz.and_then(|m| {
        if voiced_frames.len() < 5 {
            return None;
        }
        // Median absolute deviation, scaled to a standard deviation: one octave error in a sentence
        // must not read as a sing-song voice.
        median(voiced_frames.iter().map(|f| (12.0 * (f / m).log2()).abs()).collect()).map(|d| d * 1.4826)
    });

    // RMS frequency from the ratio of the first difference's energy to the signal's: for a sinusoid
    // it is exactly 2·sin(πf/fs), so no FFT is needed to ask how bright a sound is.
    let len = pitch_frame_len(sample_rate);
    let hop = ((sample_rate as f32 * HOP_SECS) as usize).max(1);
    let (mut energy, mut slope) = (0.0f64, 0.0f64);
    for (i, frame) in track.iter().enumerate() {
        if matches!(frame, Some(Some(_))) {
            for w in samples[i * hop..i * hop + len].windows(2) {
                energy += (w[1] as f64).powi(2);
                slope += (w[1] as f64 - w[0] as f64).powi(2);
            }
        }
    }
    let brightness_hz = (energy > 0.0).then(|| {
        let ratio = ((slope / energy).sqrt() / 2.0).min(1.0);
        (sample_rate as f64 / std::f64::consts::PI * ratio.asin()) as f32
    });

    let per_frame = formant_track(samples, sample_rate, &track);
    let pick = |i: usize| median(per_frame.iter().map(|f| f[i]).collect());
    let dispersion_hz = median(per_frame.iter().map(dispersion).collect());
    Profile { f0_hz, voiced, formants: [pick(0), pick(1), pick(2)], dispersion_hz, f0_spread_st, brightness_hz }
}

fn median(mut v: Vec<f32>) -> Option<f32> {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return None;
    }
    v.sort_by(f32::total_cmp);
    let m = v.len() / 2;
    Some(if v.len().is_multiple_of(2) { (v[m - 1] + v[m]) / 2.0 } else { v[m] })
}

/// Least-squares ΔF from F1–F3, modelling the tract as a uniform tube: Fi = (2i − 1)·ΔF / 2.
pub fn dispersion(f: &[f32; 3]) -> f32 {
    let (num, den) = f.iter().enumerate().fold((0.0, 0.0), |(n, d), (i, fi)| {
        let k = (2 * i + 1) as f32 / 2.0;
        (n + fi * k, d + k * k)
    });
    num / den
}

// ── Pitch ─────────────────────────────────────────────────────────────────────────────────────────

/// The pitch track's frame hop, in seconds. The formant track uses the same hop so the two align.
const HOP_SECS: f32 = 0.010;

fn pitch_frame_len(sample_rate: u32) -> usize {
    // Two periods of the lowest pitch, rounded up to a power of two.
    ((2.0 * sample_rate as f32 / PITCH_MIN_HZ) as usize + 1).next_power_of_two()
}

/// One entry per 10 ms frame: `None` for silence, `Some(None)` for unvoiced speech, `Some(Some(hz))`
/// for a pitch.
pub fn pitch_track(samples: &[f32], sample_rate: u32) -> Vec<Option<Option<f32>>> {
    let len = pitch_frame_len(sample_rate);
    let hop = ((sample_rate as f32 * HOP_SECS) as usize).max(1);
    if samples.len() < len {
        return Vec::new();
    }
    let frames: Vec<&[f32]> = (0..=(samples.len() - len) / hop).map(|i| &samples[i * hop..i * hop + len]).collect();
    let rms: Vec<f32> = frames.iter().map(|f| (f.iter().map(|x| x * x).sum::<f32>() / f.len() as f32).sqrt()).collect();
    let loudest = rms.iter().copied().fold(0.0f32, f32::max);
    frames
        .iter()
        .zip(&rms)
        .map(|(f, r)| (loudest > 0.0 && *r >= loudest * SILENCE_FRACTION).then(|| yin(f, sample_rate)))
        .collect()
}

/// YIN (de Cheveigné & Kawahara, 2002) on one frame: the first dip of the cumulative-mean-normalised
/// difference function below the threshold, refined by a parabola.
pub fn yin(frame: &[f32], sample_rate: u32) -> Option<f32> {
    let w = frame.len() / 2;
    let tau_min = (sample_rate as f32 / PITCH_MAX_HZ) as usize;
    let tau_max = ((sample_rate as f32 / PITCH_MIN_HZ) as usize).min(w);
    if tau_min < 2 || tau_max <= tau_min + 1 {
        return None;
    }
    let mut d = vec![0.0f32; tau_max + 1];
    for tau in 1..=tau_max {
        let mut s = 0.0;
        for j in 0..w {
            let diff = frame[j] - frame[j + tau];
            s += diff * diff;
        }
        d[tau] = s;
    }
    let mut cmnd = vec![1.0f32; tau_max + 1];
    let mut running = 0.0;
    for tau in 1..=tau_max {
        running += d[tau];
        cmnd[tau] = if running > 0.0 { d[tau] * tau as f32 / running } else { 1.0 };
    }
    let mut tau = tau_min;
    while tau < tau_max {
        if cmnd[tau] < YIN_THRESHOLD {
            while tau + 1 < tau_max && cmnd[tau + 1] < cmnd[tau] {
                tau += 1;
            }
            let (a, b, c) = (cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]);
            let denom = a - 2.0 * b + c;
            let shift = if denom.abs() > f32::EPSILON { 0.5 * (a - c) / denom } else { 0.0 };
            return Some(sample_rate as f32 / (tau as f32 + shift.clamp(-1.0, 1.0)));
        }
        tau += 1;
    }
    None
}

// ── Formants ──────────────────────────────────────────────────────────────────────────────────────

/// F1–F3 for every voiced frame whose LPC polynomial yielded three plausible resonances.
fn formant_track(samples: &[f32], sample_rate: u32, pitch: &[Option<Option<f32>>]) -> Vec<[f32; 3]> {
    let factor = (sample_rate / FORMANT_RATE_HZ).max(1) as usize;
    let rate = sample_rate / factor as u32;
    let x = decimate(samples, factor);
    let order = 2 + (rate / 1000) as usize;
    let len = (rate as f32 * 0.025) as usize;
    let hop = ((rate as f32 * HOP_SECS) as usize).max(1);
    if x.len() < len || len <= order {
        return Vec::new();
    }
    let pitch_len_secs = pitch_frame_len(sample_rate) as f32 / sample_rate as f32;
    let window: Vec<f64> =
        (0..len).map(|n| 0.54 - 0.46 * (2.0 * std::f64::consts::PI * n as f64 / (len - 1) as f64).cos()).collect();

    let mut out = Vec::new();
    for start in (0..=x.len() - len).step_by(hop) {
        // The pitch frame whose centre is nearest this frame's centre.
        let centre = (start as f32 + len as f32 / 2.0) / rate as f32;
        let i = ((centre - pitch_len_secs / 2.0) / HOP_SECS).round().max(0.0) as usize;
        if !matches!(pitch.get(i), Some(Some(Some(_)))) {
            continue;
        }
        let mut frame: Vec<f64> = Vec::with_capacity(len);
        let mut prev = if start > 0 { x[start - 1] as f64 } else { 0.0 };
        for n in 0..len {
            // Pre-emphasis flattens the source's −6 dB/octave tilt so F2 and F3 are not buried.
            let s = x[start + n] as f64;
            frame.push((s - 0.97 * prev) * window[n]);
            prev = s;
        }
        if let Some(f) = lpc(&frame, order).and_then(|a| resonances(&a, rate)) {
            out.push(f);
        }
    }
    out
}

/// Low-pass then keep every `factor`th sample. A windowed-sinc FIR, so nothing above the new Nyquist
/// folds down into the formant range.
pub fn decimate(samples: &[f32], factor: usize) -> Vec<f32> {
    if factor <= 1 {
        return samples.to_vec();
    }
    const HALF: isize = 32;
    let cutoff = 0.9 * 0.5 / factor as f64;
    let taps: Vec<f64> = (-HALF..=HALF)
        .map(|n| {
            let m = n as f64;
            let sinc = if n == 0 { 2.0 * cutoff } else { (2.0 * std::f64::consts::PI * cutoff * m).sin() / (std::f64::consts::PI * m) };
            let hamming = 0.54 + 0.46 * (std::f64::consts::PI * m / HALF as f64).cos();
            sinc * hamming
        })
        .collect();
    let len = samples.len() as isize;
    (0..samples.len())
        .step_by(factor)
        .map(|c| {
            let c = c as isize;
            let mut acc = 0.0;
            for (k, t) in taps.iter().enumerate() {
                let i = c + k as isize - HALF;
                if (0..len).contains(&i) {
                    acc += samples[i as usize] as f64 * t;
                }
            }
            acc as f32
        })
        .collect()
}

/// Linear prediction coefficients by Levinson–Durbin: `a[0] = 1`, and `A(z) = Σ a[k]·z^−k`.
pub fn lpc(frame: &[f64], order: usize) -> Option<Vec<f64>> {
    let mut r = vec![0.0; order + 1];
    for k in 0..=order {
        r[k] = frame.iter().zip(frame.iter().skip(k)).map(|(a, b)| a * b).sum();
    }
    if r[0] <= 0.0 {
        return None;
    }
    // A hair of white noise keeps a near-singular frame from producing unstable poles.
    r[0] *= 1.0 + 1e-9;
    let mut a = vec![0.0; order + 1];
    a[0] = 1.0;
    let mut err = r[0];
    for i in 1..=order {
        let acc: f64 = r[i] + (1..i).map(|j| a[j] * r[i - j]).sum::<f64>();
        let k = -acc / err;
        let prev = a.clone();
        for j in 1..i {
            a[j] = prev[j] + k * prev[i - j];
        }
        a[i] = k;
        err *= 1.0 - k * k;
        if err <= 0.0 {
            return None;
        }
    }
    Some(a)
}

#[derive(Clone, Copy, Debug)]
struct Complex {
    re: f64,
    im: f64,
}

impl Complex {
    fn add(self, o: Complex) -> Complex {
        Complex { re: self.re + o.re, im: self.im + o.im }
    }
    fn sub(self, o: Complex) -> Complex {
        Complex { re: self.re - o.re, im: self.im - o.im }
    }
    fn mul(self, o: Complex) -> Complex {
        Complex { re: self.re * o.re - self.im * o.im, im: self.re * o.im + self.im * o.re }
    }
    fn div(self, o: Complex) -> Complex {
        let d = o.re * o.re + o.im * o.im;
        Complex { re: (self.re * o.re + self.im * o.im) / d, im: (self.im * o.re - self.re * o.im) / d }
    }
    fn norm(self) -> f64 {
        self.re.hypot(self.im)
    }
}

/// Roots of `z^p + a[1]·z^(p−1) + … + a[p]` by Durand–Kerner. `None` when it does not converge,
/// which drops the frame rather than reporting a formant that was never found.
fn roots(a: &[f64]) -> Option<Vec<Complex>> {
    let p = a.len() - 1;
    let eval = |z: Complex| a[1..].iter().fold(Complex { re: 1.0, im: 0.0 }, |acc, c| acc.mul(z).add(Complex { re: *c, im: 0.0 }));
    let seed = Complex { re: 0.4, im: 0.9 };
    let mut z: Vec<Complex> = Vec::with_capacity(p);
    let mut cur = Complex { re: 1.0, im: 0.0 };
    for _ in 0..p {
        cur = cur.mul(seed);
        z.push(cur);
    }
    for _ in 0..800 {
        let mut moved = 0.0f64;
        for i in 0..p {
            let mut den = Complex { re: 1.0, im: 0.0 };
            for j in 0..p {
                if i != j {
                    den = den.mul(z[i].sub(z[j]));
                }
            }
            if den.norm() < 1e-300 {
                return None;
            }
            let step = eval(z[i]).div(den);
            z[i] = z[i].sub(step);
            moved = moved.max(step.norm());
        }
        if moved < 1e-10 {
            return Some(z);
        }
    }
    None
}

/// The first three plausible resonances of an LPC polynomial, lowest first.
fn resonances(a: &[f64], rate: u32) -> Option<[f32; 3]> {
    let fs = rate as f64;
    let mut found: Vec<f64> = roots(a)?
        .into_iter()
        .filter(|z| z.im > 0.0)
        .filter_map(|z| {
            let freq = z.im.atan2(z.re) * fs / (2.0 * std::f64::consts::PI);
            let bandwidth = -z.norm().ln() * fs / std::f64::consts::PI;
            (freq > MIN_FORMANT_HZ && freq < fs / 2.0 - 50.0 && bandwidth < MAX_FORMANT_BANDWIDTH_HZ).then_some(freq)
        })
        .collect();
    found.sort_by(f64::total_cmp);
    (found.len() >= 3).then(|| [found[0] as f32, found[1] as f32, found[2] as f32])
}

// ── Placement ─────────────────────────────────────────────────────────────────────────────────────

/// Where one group of labelled voices sits: MEDIANS, on a ratio scale — 100→200 Hz is the same step
/// as 200→400 Hz, and a median is unchanged by taking logs.
///
/// A median, not a mean, because one odd voice must not move the axis: measured 2026-09-15, Kokoro's
/// `af_nicole` whispers, has almost no voicing to find formants in, and measured ΔF 1541 Hz against
/// every other female voice's 1105–1302.
/// The cues a voice is placed on, in [`features`] order.
pub const FEATURES: [&str; 4] = ["pitch", "formant", "intonation", "brightness"];

/// The cues on scales where a step means the same thing everywhere: pitch, spacing and brightness as
/// logs, because they are heard as ratios; intonation is already in semitones.
pub fn features(p: &Profile) -> Option<[f32; 4]> {
    Some([p.f0_hz?.ln(), p.dispersion_hz?.ln(), p.f0_spread_st?, p.brightness_hz?.ln()])
}

#[derive(Clone, Debug, PartialEq)]
pub struct Centroid {
    pub f0_hz: f32,
    pub dispersion_hz: f32,
    pub voices: usize,
    /// The median of each cue, in [`features`] units.
    pub centre: [f32; 4],
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reference {
    pub female: Centroid,
    pub male: Centroid,
    /// A robust spread per cue — the median absolute deviation within each group, pooled — which is
    /// what "a big difference" means for that cue.
    pub scale: [f32; 4],
    /// The cues that separate the groups by at least half a spread. A cue both groups share is not
    /// evidence either way, and dividing by its tiny gap would let noise decide every score. Pitch and
    /// formant spacing always count: the placement is built on them.
    pub separating: [bool; 4],
    female_points: Vec<[f32; 4]>,
    male_points: Vec<[f32; 4]>,
}

/// The ways "androgynous" is scored. Each is a DIFFERENT QUESTION, which is the point of having
/// several: the first one asked only about pitch and spacing, and a listener heard its winners as
/// female because other cues — how much the pitch moves, how bright the tone is — were never asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grading {
    Midpoint,
    AllCues,
    Discriminant,
    Neighbours,
    Anchored,
}

impl Grading {
    pub const ALL: [Grading; 5] =
        [Grading::Midpoint, Grading::AllCues, Grading::Discriminant, Grading::Neighbours, Grading::Anchored];

    pub const fn name(self) -> &'static str {
        match self {
            Grading::Midpoint => "midpoint",
            Grading::AllCues => "all-cues",
            Grading::Discriminant => "discriminant",
            Grading::Neighbours => "neighbours",
            Grading::Anchored => "anchored",
        }
    }

    /// A column-width label.
    pub const fn short(self) -> &'static str {
        match self {
            Grading::Midpoint => "mid",
            Grading::AllCues => "cues",
            Grading::Discriminant => "disc",
            Grading::Neighbours => "nbrs",
            Grading::Anchored => "anchor",
        }
    }

    pub const fn describe(self) -> &'static str {
        match self {
            Grading::Midpoint => "pitch and formant spacing both halfway between the centroids",
            Grading::AllCues => "halfway on EVERY cue that separates the voices, intonation and brightness included",
            Grading::Discriminant => "a linear classifier cannot tell — opposing cues may cancel",
            Grading::Neighbours => "as close to the nearest female voices as to the nearest male ones",
            Grading::Anchored => "closest to a blend a listener already judged ambiguous (--anchor)",
        }
    }

    const fn index(self) -> usize {
        match self {
            Grading::Midpoint => 0,
            Grading::AllCues => 1,
            Grading::Discriminant => 2,
            Grading::Neighbours => 3,
            Grading::Anchored => 4,
        }
    }
}

/// A clip's position between the two centroids, and its score under each grading. Every score reads
/// the same way: 0 is fully androgynous, and larger is further from it.
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    /// Per cue: −1 at the male centroid, +1 at the female, 0 exactly between.
    pub positions: [f32; 4],
    /// `positions[0]` and `[1]`, named, because they are the two the midpoint grading uses.
    pub pitch: f32,
    pub formant: f32,
    /// The midpoint score. Root-mean-square, so a high pitch through a long tract — which reads as a
    /// man speaking high, not as ambiguous — is NOT scored as neutral just because the two cancel.
    pub distance: f32,
    /// The mean of the pitch and formant positions: which way the clip leans, when it leans.
    pub lean: f32,
    scores: [Option<f32>; 5],
}

impl Placement {
    /// `None` only for [`Grading::Anchored`] when no anchor was given.
    pub fn score(&self, g: Grading) -> Option<f32> {
        self.scores[g.index()]
    }
}

fn centroid(points: &[[f32; 4]]) -> Option<Centroid> {
    let mut centre = [0.0f32; 4];
    for i in 0..4 {
        centre[i] = median(points.iter().map(|p| p[i]).collect())?;
    }
    Some(Centroid { f0_hz: centre[0].exp(), dispersion_hz: centre[1].exp(), voices: points.len(), centre })
}

impl Reference {
    pub fn from_groups(female: &[Profile], male: &[Profile]) -> Result<Reference, String> {
        let female_points: Vec<[f32; 4]> = female.iter().filter_map(features).collect();
        let male_points: Vec<[f32; 4]> = male.iter().filter_map(features).collect();
        let female = centroid(&female_points).ok_or("no female reference voice measured every cue")?;
        let male = centroid(&male_points).ok_or("no male reference voice measured every cue")?;
        let gap = |i: usize| (female.centre[i] - male.centre[i]).abs();
        if gap(0) < 0.01 || gap(1) < 0.001 {
            return Err(format!(
                "the reference groups do not separate (female {:.0} Hz / ΔF {:.0}, male {:.0} Hz / ΔF {:.0}) — there is no axis to place anything on",
                female.f0_hz, female.dispersion_hz, male.f0_hz, male.dispersion_hz
            ));
        }
        let mut scale = [0.0f32; 4];
        let mut separating = [true; 4];
        for i in 0..4 {
            let deviations = female_points
                .iter()
                .map(|p| (p[i] - female.centre[i]).abs())
                .chain(male_points.iter().map(|p| (p[i] - male.centre[i]).abs()))
                .collect();
            scale[i] = (median(deviations).unwrap_or(0.0) * 1.4826).max(1e-3);
            if i >= 2 {
                separating[i] = gap(i) >= 0.5 * scale[i];
            }
        }
        Ok(Reference { female, male, scale, separating, female_points, male_points })
    }

    fn positions(&self, x: &[f32; 4]) -> [f32; 4] {
        let mut out = [0.0f32; 4];
        for i in 0..4 {
            let half = (self.female.centre[i] - self.male.centre[i]) / 2.0;
            let mid = (self.female.centre[i] + self.male.centre[i]) / 2.0;
            out[i] = if half.abs() > f32::EPSILON { (x[i] - mid) / half } else { 0.0 };
        }
        out
    }

    pub fn place(&self, p: &Profile) -> Option<Placement> {
        self.place_anchored(p, None)
    }

    /// Place a clip and score it under every grading; `anchor` enables [`Grading::Anchored`].
    pub fn place_anchored(&self, p: &Profile, anchor: Option<&Profile>) -> Option<Placement> {
        let x = features(p)?;
        let pos = self.positions(&x);
        let used: Vec<usize> = (0..4).filter(|i| self.separating[*i]).collect();
        let rms = |sq: f32| (sq / used.len() as f32).sqrt();
        let (pitch, formant) = (pos[0], pos[1]);
        let distance = ((pitch * pitch + formant * formant) / 2.0).sqrt();
        let all_cues = rms(used.iter().map(|i| pos[*i] * pos[*i]).sum());

        // A diagonal linear discriminant: each cue weighted by its gap over its spread squared, the
        // projection normalised so a centroid lands at ±1. Unlike every other grading here, opposing
        // cues CANCEL — it asks whether a classifier could tell, not whether each cue is neutral.
        let weight = |i: usize| (self.female.centre[i] - self.male.centre[i]) / (self.scale[i] * self.scale[i]);
        let half: f32 = used.iter().map(|i| weight(*i) * (self.female.centre[*i] - self.male.centre[*i]) / 2.0).sum();
        let projection: f32 = used
            .iter()
            .map(|i| weight(*i) * (x[*i] - (self.female.centre[*i] + self.male.centre[*i]) / 2.0))
            .sum();
        let discriminant = (projection / half).abs();

        // Mean distance to the three nearest voices of each label, in spread units.
        let nearest = |points: &[[f32; 4]]| {
            let mut d: Vec<f32> = points
                .iter()
                .map(|q| used.iter().map(|i| ((x[*i] - q[*i]) / self.scale[*i]).powi(2)).sum::<f32>().sqrt())
                .collect();
            d.sort_by(f32::total_cmp);
            let k = d.len().clamp(1, 3);
            d.iter().take(k).sum::<f32>() / k as f32
        };
        let (to_female, to_male) = (nearest(&self.female_points), nearest(&self.male_points));
        let neighbours =
            if to_female + to_male > 0.0 { (to_female - to_male).abs() / (to_female + to_male) } else { 0.0 };

        let anchored = anchor.and_then(features).map(|a| {
            let at = self.positions(&a);
            rms(used.iter().map(|i| (pos[*i] - at[*i]).powi(2)).sum())
        });
        Some(Placement {
            positions: pos,
            pitch,
            formant,
            distance,
            lean: (pitch + formant) / 2.0,
            scores: [Some(distance), Some(all_cues), Some(discriminant), Some(neighbours), anchored],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 24_000;

    /// A glottal pulse train through three two-pole resonators: a vowel with KNOWN pitch and formants.
    fn vowel(f0: f32, formants: [f32; 3], secs: f32) -> Vec<f32> {
        glide(f0, f0, formants, secs)
    }

    /// The same, with the pitch moving linearly from `from` to `to` — a voice with intonation.
    fn glide(from: f32, to: f32, formants: [f32; 3], secs: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        let mut phase = 0.0f32;
        let mut x: Vec<f64> = (0..n)
            .map(|i| {
                phase += (from + (to - from) * i as f32 / n as f32) / SR as f32;
                if phase >= 1.0 {
                    phase -= 1.0;
                    1.0
                } else {
                    0.0
                }
            })
            .collect();
        for f in formants {
            let r = (-std::f64::consts::PI * 80.0 / SR as f64).exp();
            let theta = 2.0 * std::f64::consts::PI * f as f64 / SR as f64;
            let (b1, b2) = (2.0 * r * theta.cos(), -r * r);
            let (mut y1, mut y2) = (0.0, 0.0);
            for s in x.iter_mut() {
                let y = *s + b1 * y1 + b2 * y2;
                y2 = y1;
                y1 = y;
                *s = y;
            }
        }
        let peak = x.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        x.iter().map(|v| (v / peak * 0.8) as f32).collect()
    }

    fn close(got: f32, want: f32, tolerance: f32) -> bool {
        ((got - want) / want).abs() <= tolerance
    }

    #[test]
    fn a_known_pitch_is_measured_for_a_low_and_a_high_voice() {
        for f0 in [110.0, 220.0] {
            let p = profile(&vowel(f0, [600.0, 1700.0, 2700.0], 0.6), SR);
            let got = p.f0_hz.expect("a pulse train is voiced");
            assert!(close(got, f0, 0.02), "wanted {f0} Hz, measured {got}");
            assert!(p.voiced > 0.9, "a sustained vowel is voiced throughout: {}", p.voiced);
        }
    }

    #[test]
    fn silence_has_no_pitch_and_no_formants_rather_than_a_zero() {
        let p = profile(&vec![0.0; SR as usize], SR);
        assert_eq!(p.f0_hz, None);
        assert_eq!(p.dispersion_hz, None);
        assert_eq!(p.formants, [None, None, None]);
    }

    #[test]
    fn known_resonances_are_recovered_as_formants() {
        let want = [650.0, 1750.0, 2800.0];
        let p = profile(&vowel(130.0, want, 0.6), SR);
        for (i, w) in want.iter().enumerate() {
            let got = p.formants[i].unwrap_or_else(|| panic!("F{} missing: {p:?}", i + 1));
            assert!(close(got, *w, 0.08), "F{}: wanted {w}, measured {got}", i + 1);
        }
        let df = p.dispersion_hz.expect("dispersion follows from three formants");
        assert!(close(df, dispersion(&want), 0.08), "ΔF {df}");
    }

    #[test]
    fn a_shorter_tract_measures_a_wider_dispersion() {
        let long = profile(&vowel(120.0, [500.0, 1500.0, 2500.0], 0.5), SR);
        let short = profile(&vowel(120.0, [600.0, 1800.0, 3000.0], 0.5), SR);
        assert!(short.dispersion_hz.unwrap() > long.dispersion_hz.unwrap() * 1.1);
    }

    #[test]
    fn dispersion_of_a_uniform_tube_is_its_spacing() {
        // A 17.5 cm tube resonates at 500, 1500, 2500 Hz: odd multiples of ΔF/2 with ΔF = 1000.
        assert!((dispersion(&[500.0, 1500.0, 2500.0]) - 1000.0).abs() < 1e-3);
    }

    #[test]
    fn a_moving_pitch_measures_more_intonation_than_a_steady_one() {
        let steady = profile(&vowel(140.0, [600.0, 1700.0, 2700.0], 0.8), SR);
        let moving = profile(&glide(100.0, 170.0, [600.0, 1700.0, 2700.0], 0.8), SR);
        let (s, m) = (steady.f0_spread_st.unwrap(), moving.f0_spread_st.unwrap());
        assert!(s < 0.3, "a held note barely moves: {s}");
        assert!(m > 1.5, "a glide across nine semitones moves: {m}");
    }

    #[test]
    fn higher_resonances_measure_brighter_at_the_same_pitch() {
        let dark = profile(&vowel(130.0, [500.0, 1400.0, 2400.0], 0.5), SR).brightness_hz.unwrap();
        let bright = profile(&vowel(130.0, [750.0, 2100.0, 3300.0], 0.5), SR).brightness_hz.unwrap();
        assert!(bright > dark * 1.1, "dark {dark}, bright {bright}");
    }

    fn measured(f0: f32, df: f32) -> Profile {
        cued(f0, df, 2.0, 1500.0)
    }

    fn cued(f0: f32, df: f32, spread: f32, brightness: f32) -> Profile {
        Profile {
            f0_hz: Some(f0),
            voiced: 1.0,
            formants: [None, None, None],
            dispersion_hz: Some(df),
            f0_spread_st: Some(spread),
            brightness_hz: Some(brightness),
        }
    }

    /// Two voices per label, slightly apart, differing on all four cues.
    fn four_cue_reference() -> Reference {
        Reference::from_groups(
            &[cued(195.0, 1190.0, 3.1, 1950.0), cued(205.0, 1210.0, 2.9, 2050.0)],
            &[cued(98.0, 990.0, 1.6, 1380.0), cued(102.0, 1010.0, 1.4, 1420.0)],
        )
        .unwrap()
    }

    #[test]
    fn every_grading_scores_a_voice_exactly_between_as_zero() {
        let r = four_cue_reference();
        assert_eq!(r.separating, [true; 4], "all four cues separate this reference");
        let between = cued((200.0f32 * 100.0).sqrt(), (1200.0f32 * 1000.0).sqrt(), 2.25, (2000.0f32 * 1400.0).sqrt());
        let p = r.place_anchored(&between, Some(&between)).unwrap();
        for g in Grading::ALL {
            let s = p.score(g).unwrap();
            assert!(s < 0.02, "{} scored {s}", g.name());
        }
    }

    #[test]
    fn a_centroid_scores_one_on_the_centroid_scaled_gradings() {
        let r = four_cue_reference();
        let female = cued(200.0, 1200.0, 3.0, 2000.0);
        let p = r.place(&female).unwrap();
        for g in [Grading::Midpoint, Grading::AllCues, Grading::Discriminant] {
            assert!((p.score(g).unwrap() - 1.0).abs() < 0.02, "{} scored {:?}", g.name(), p.score(g));
        }
        assert!(p.score(Grading::Neighbours).unwrap() > 0.5, "right among the female voices");
        assert_eq!(p.score(Grading::Anchored), None, "no anchor, no anchored score");
    }

    #[test]
    fn midpoint_ignores_the_cues_that_all_cues_catches() {
        let r = four_cue_reference();
        // Halfway on pitch and spacing, female on intonation and brightness: the case a listener
        // heard as female while the first grading called it neutral.
        let p = r
            .place(&cued((200.0f32 * 100.0).sqrt(), (1200.0f32 * 1000.0).sqrt(), 3.0, 2000.0))
            .unwrap();
        assert!(p.score(Grading::Midpoint).unwrap() < 0.02);
        assert!(p.score(Grading::AllCues).unwrap() > 0.6, "{:?}", p.score(Grading::AllCues));
    }

    #[test]
    fn only_the_discriminant_lets_opposing_cues_cancel() {
        let r = four_cue_reference();
        let conflicted = r.place(&cued(200.0, 1200.0, 1.5, 1400.0)).unwrap();
        let all = conflicted.score(Grading::AllCues).unwrap();
        let disc = conflicted.score(Grading::Discriminant).unwrap();
        assert!(all > 0.9, "every cue is at a centroid: {all}");
        assert!(disc < all * 0.6, "female on two, male on two, and the classifier is torn: {disc}");
    }

    #[test]
    fn the_anchor_scores_zero_and_the_far_side_does_not() {
        let r = four_cue_reference();
        let anchor = cued(140.0, 1080.0, 2.0, 1600.0);
        assert!(r.place_anchored(&anchor, Some(&anchor)).unwrap().score(Grading::Anchored).unwrap() < 1e-4);
        let far = r.place_anchored(&cued(200.0, 1200.0, 3.0, 2000.0), Some(&anchor)).unwrap();
        assert!(far.score(Grading::Anchored).unwrap() > 0.5);
    }

    #[test]
    fn a_cue_both_labels_share_does_not_count() {
        let r = Reference::from_groups(
            &[cued(195.0, 1190.0, 2.0, 1500.0), cued(205.0, 1210.0, 2.4, 1600.0)],
            &[cued(98.0, 990.0, 2.2, 1550.0), cued(102.0, 1010.0, 2.1, 1520.0)],
        )
        .unwrap();
        assert_eq!(r.separating, [true, true, false, false]);
        // Wildly off on the shared cues, halfway on the real ones: still neutral.
        let p = r.place(&cued((200.0f32 * 100.0).sqrt(), (1200.0f32 * 1000.0).sqrt(), 9.0, 4000.0)).unwrap();
        assert!(p.score(Grading::AllCues).unwrap() < 0.02, "{:?}", p.score(Grading::AllCues));
    }

    #[test]
    fn the_centroids_sit_at_plus_and_minus_one_and_between_is_zero() {
        let r = Reference::from_groups(&[measured(200.0, 1200.0)], &[measured(100.0, 1000.0)]).unwrap();
        let f = r.place(&measured(200.0, 1200.0)).unwrap();
        let m = r.place(&measured(100.0, 1000.0)).unwrap();
        assert!((f.pitch - 1.0).abs() < 1e-4 && (f.formant - 1.0).abs() < 1e-4 && (f.distance - 1.0).abs() < 1e-4);
        assert!((m.lean + 1.0).abs() < 1e-4 && (m.distance - 1.0).abs() < 1e-4);
        // Between, on the ratio scale: the geometric mean.
        let mid = r.place(&measured((200.0f32 * 100.0).sqrt(), (1200.0f32 * 1000.0).sqrt())).unwrap();
        assert!(mid.distance < 1e-3, "{mid:?}");
    }

    #[test]
    fn cues_that_disagree_are_not_scored_as_androgynous() {
        let r = Reference::from_groups(&[measured(200.0, 1200.0)], &[measured(100.0, 1000.0)]).unwrap();
        // A female pitch through a male tract: the positions cancel, the distance must not.
        let conflicted = r.place(&measured(200.0, 1000.0)).unwrap();
        assert!(conflicted.lean.abs() < 1e-4);
        assert!(conflicted.distance > 0.9, "{conflicted:?}");
    }

    #[test]
    fn one_outlying_reference_voice_does_not_move_its_centroid() {
        let typical = [measured(180.0, 1180.0), measured(190.0, 1200.0), measured(200.0, 1220.0)];
        let mut with_whisper = typical.to_vec();
        with_whisper.push(measured(185.0, 1600.0));
        with_whisper.push(measured(195.0, 1210.0));
        let male = [measured(110.0, 1000.0)];
        let calm = Reference::from_groups(&typical, &male).unwrap();
        let skewed = Reference::from_groups(&with_whisper, &male).unwrap();
        assert!((skewed.female.dispersion_hz - calm.female.dispersion_hz).abs() < 15.0, "{skewed:?}");
    }

    #[test]
    fn groups_that_do_not_separate_are_refused() {
        let e = Reference::from_groups(&[measured(150.0, 1100.0)], &[measured(150.0, 1100.0)]).unwrap_err();
        assert!(e.contains("do not separate"), "{e}");
    }

    #[test]
    fn decimation_keeps_the_band_and_halves_the_length() {
        let tone: Vec<f32> = (0..2400).map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / SR as f32).sin()).collect();
        let d = decimate(&tone, 2);
        assert_eq!(d.len(), 1200);
        let rms = (d[100..1100].iter().map(|x| x * x).sum::<f32>() / 1000.0).sqrt();
        assert!((rms - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.05, "a 1 kHz tone passes: rms {rms}");
    }
}
