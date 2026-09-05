//! Telling a voice in the room from a voice played at the microphone.
//!
//! MEASURED before any of this was written, on 28 recordings through one mic in one room. The
//! discriminating feature is a single band ratio and the separation is total:
//!
//! ```text
//!   energy(100-300 Hz) / energy(20-100 Hz)
//!   LIVE    min   3.78   median  234.30   max 1411.48
//!   REPLAY  min   0.01   median    0.28   max    1.67
//! ```
//!
//! The physics does the work. A loudspeaker ADDS cabinet and room resonance below 100 Hz while
//! ATTENUATING the 100-300 Hz fundamental, so replayed speech is bass-heavy and hollow in exactly
//! the band a real voice occupies. The first hypothesis was the opposite — that proximity effect
//! would give live speech MORE sub-bass — and the controlled test refuted it: replay had fifteen
//! times more. Measuring beat reasoning about it.
//!
//! **No model, and deliberately so.** Pretrained replay detectors exist (AASIST, RawNet2, from the
//! ASVspoof Physical Access track) and would bring a PyTorch stack to beat a feature that already
//! separates without error. They are the fallback for when this stops working, not the starting
//! point.
//!
//! **The threshold is PER DEVICE and is never assumed.** Every number above came from one monitor
//! and one Scarlett. A phone speaker has a different response — plausibly less sub-bass, which would
//! push it toward the live class and break the detector in the direction that matters most, since a
//! phone is exactly the mobile-tunnel case. So a pairing that has not been calibrated is REFUSED
//! rather than guessed at.

use serde::{Deserialize, Serialize};

/// The bands the feature is built from, in Hz.
pub const RUMBLE: (f32, f32) = (20.0, 100.0);
pub const FUNDAMENTAL: (f32, f32) = (100.0, 300.0);
/// Below this overall level there is not enough signal to measure a band ratio against.
///
/// AN ENERGY GATE, NOT A VOICING GATE. Silence has no fundamental and so scores exactly like a
/// replay; but replayed speech is itself barely voiced, so gating on voicing throws away the class
/// being detected. Measured: the maintainer's silent segments sit at rms 0.0015-0.003, live speech
/// around 0.05, and replayed speech comfortably between — loud, with a weak fundamental.
pub const MIN_MEASURABLE_RMS: f32 = 0.005;

/// Window length for the transform. A power of two, and long enough that a 20 Hz bin exists at
/// 16 kHz — 2048 samples gives ~7.8 Hz resolution.
pub const WINDOW: usize = 2048;

/// In-place iterative radix-2 FFT. Small enough to own; a dependency for one transform would put a
/// whole numerics crate in the build of something that measures microphones.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two());
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        let mut i = 0;
        while i < n {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (ur, ui) = (re[i + k], im[i + k]);
                let (vr, vi) = (
                    re[i + k + len / 2] * cr - im[i + k + len / 2] * ci,
                    re[i + k + len / 2] * ci + im[i + k + len / 2] * cr,
                );
                re[i + k] = ur + vr;
                im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr;
                im[i + k + len / 2] = ui - vi;
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// The FFT, for other measurements in this crate that need one. A second copy would be a second
/// thing to get wrong.
pub fn fft_public(re: &mut [f32], im: &mut [f32]) {
    fft(re, im)
}

/// Magnitude spectrum of one Hann-windowed frame, up to Nyquist.
pub fn magnitudes(frame: &[f32]) -> Vec<f32> {
    let n = frame.len();
    let mut re: Vec<f32> = frame
        .iter()
        .enumerate()
        .map(|(i, s)| s * (0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos()))
        .collect();
    let mut im = vec![0.0f32; n];
    fft(&mut re, &mut im);
    (0..n / 2).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt()).collect()
}

/// Energy in one band of one Hann-windowed frame.
fn band_energy(frame: &[f32], sample_rate: u32, band: (f32, f32)) -> f32 {
    let n = frame.len();
    let mut re: Vec<f32> = frame
        .iter()
        .enumerate()
        .map(|(i, s)| s * (0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos()))
        .collect();
    let mut im = vec![0.0f32; n];
    fft(&mut re, &mut im);
    let lo = (band.0 * n as f32 / sample_rate as f32) as usize;
    let hi = ((band.1 * n as f32 / sample_rate as f32) as usize).min(n / 2);
    (lo..hi).map(|k| re[k] * re[k] + im[k] * im[k]).sum()
}

/// The feature: voice fundamental over rumble, measured on the loudest frames.
///
/// The LOUDEST frames, because a recording is mostly gaps and a ratio computed over silence
/// describes the room's noise floor rather than anything that was said.
pub fn liveness_ratio(samples: &[f32], sample_rate: u32) -> Option<f32> {
    if samples.len() < WINDOW * 2 || sample_rate == 0 {
        return None;
    }
    let mut frames: Vec<(f32, usize)> = (0..)
        .map(|i| i * WINDOW)
        .take_while(|&at| at + WINDOW <= samples.len())
        .map(|at| (samples[at..at + WINDOW].iter().map(|s| s * s).sum::<f32>(), at))
        .collect();
    frames.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let take = frames.len().min(6);
    let mut rumble = 0.0f32;
    let mut fundamental = 0.0f32;
    for &(_, at) in frames.iter().take(take) {
        let f = &samples[at..at + WINDOW];
        rumble += band_energy(f, sample_rate, RUMBLE);
        fundamental += band_energy(f, sample_rate, FUNDAMENTAL);
    }
    if !rumble.is_finite() || !fundamental.is_finite() || rumble <= 0.0 {
        return None;
    }
    Some(fundamental / rumble)
}

/// What one microphone-and-speaker pairing measures, so a threshold is never a guess.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Calibration {
    /// The capture device this was measured on.
    pub device: String,
    pub live_min: f32,
    pub live_median: f32,
    pub replay_max: f32,
    pub replay_median: f32,
    pub n_live: usize,
    pub n_replay: usize,
    /// The chosen boundary — the geometric midpoint of the gap.
    pub threshold: f32,
    /// False when the two classes overlap, so this pairing cannot be judged on this feature alone.
    pub separable: bool,
}

/// Fewer than this per class and the boundary is an accident of which clips were picked.
pub const MIN_SAMPLES: usize = 4;

/// Build a calibration from measured ratios.
pub fn calibrate(device: &str, live: &[f32], replay: &[f32]) -> Result<Calibration, String> {
    if live.len() < MIN_SAMPLES || replay.len() < MIN_SAMPLES {
        return Err(format!(
            "need at least {MIN_SAMPLES} samples of each; got {} live and {} replayed. A boundary \
             drawn from fewer is an accident of which clips were picked.",
            live.len(),
            replay.len()
        ));
    }
    let med = |v: &[f32]| {
        let mut s = v.to_vec();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        s[s.len() / 2]
    };
    let live_min = live.iter().copied().fold(f32::INFINITY, f32::min);
    let replay_max = replay.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let separable = live_min > replay_max;
    // The geometric midpoint, because the feature is a ratio and spans orders of magnitude — the
    // arithmetic mean of 1.67 and 3.78 sits much closer to the replay class than it looks.
    let threshold = if separable { (live_min * replay_max).sqrt() } else { (live_min + replay_max) / 2.0 };
    Ok(Calibration {
        device: device.to_string(),
        live_min,
        live_median: med(live),
        replay_max,
        replay_median: med(replay),
        n_live: live.len(),
        n_replay: replay.len(),
        threshold,
        separable,
    })
}

/// The verdict on one recording.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// A voice in the room.
    Live,
    /// A voice played at the microphone.
    Replayed,
    /// This pairing has no usable calibration, so nothing is claimed.
    Unknown,
}

/// Judge a ratio against a calibration.
///
/// An uncalibrated or overlapping pairing yields [`Verdict::Unknown`], never a guess. The failure
/// this avoids is a phone speaker — plausibly less bass-heavy than a monitor, which would move it
/// toward the live class and produce a confident wrong answer in the case that matters most.
pub fn judge(ratio: Option<f32>, cal: Option<&Calibration>) -> Verdict {
    match (ratio, cal) {
        (Some(r), Some(c)) if c.separable && r.is_finite() => {
            if r >= c.threshold {
                Verdict::Live
            } else {
                Verdict::Replayed
            }
        }
        _ => Verdict::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 16_000;

    fn tone(hz: f32, secs: f32, amp: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin()).collect()
    }
    fn mix(a: &[f32], b: &[f32]) -> Vec<f32> {
        a.iter().zip(b).map(|(x, y)| x + y).collect()
    }

    /// The transform has to be right before anything built on it means anything.
    #[test]
    fn the_transform_finds_energy_where_the_tone_actually_is() {
        let f = tone(200.0, 0.2, 0.5);
        let fund = band_energy(&f[..WINDOW], SR, FUNDAMENTAL);
        let rum = band_energy(&f[..WINDOW], SR, RUMBLE);
        assert!(fund > rum * 50.0, "a 200Hz tone belongs in the fundamental band: {fund} vs {rum}");

        let low = tone(50.0, 0.2, 0.5);
        let fund2 = band_energy(&low[..WINDOW], SR, FUNDAMENTAL);
        let rum2 = band_energy(&low[..WINDOW], SR, RUMBLE);
        assert!(rum2 > fund2 * 50.0, "a 50Hz tone belongs in the rumble band: {rum2} vs {fund2}");
    }

    /// The shape measured on real recordings: live speech is fundamental-dominant, replayed speech
    /// is rumble-dominant because the speaker adds cabinet and room resonance below 100Hz.
    #[test]
    fn a_fundamental_heavy_signal_scores_far_above_a_rumble_heavy_one() {
        let live = mix(&tone(180.0, 1.0, 0.5), &tone(40.0, 1.0, 0.02));
        let replayed = mix(&tone(180.0, 1.0, 0.08), &tone(45.0, 1.0, 0.5));
        let (l, r) = (liveness_ratio(&live, SR).unwrap(), liveness_ratio(&replayed, SR).unwrap());
        assert!(l > r * 20.0, "live {l:.2} should dwarf replayed {r:.2}");
    }

    #[test]
    fn too_little_audio_yields_no_ratio_rather_than_a_number() {
        assert_eq!(liveness_ratio(&[], SR), None);
        assert_eq!(liveness_ratio(&tone(200.0, 0.05, 0.5), SR), None, "shorter than two windows");
        assert_eq!(liveness_ratio(&tone(200.0, 1.0, 0.5), 0), None, "no sample rate, no answer");
        assert_eq!(liveness_ratio(&vec![0.0; SR as usize], SR), None, "silence has no ratio");
    }

    fn cal_of(live: &[f32], replay: &[f32]) -> Result<Calibration, String> {
        calibrate("test-mic", live, replay)
    }

    /// The real measurement: live 3.78..1411, replay 0.01..1.67 — a clean gap.
    #[test]
    fn a_separated_pairing_puts_the_boundary_inside_the_gap() {
        let c = cal_of(&[3.78, 92.7, 234.3, 1411.5], &[0.01, 0.28, 0.74, 1.67]).unwrap();
        assert!(c.separable);
        assert!(c.threshold > 1.67 && c.threshold < 3.78, "threshold {} is outside the gap", c.threshold);
        assert_eq!(judge(Some(5.0), Some(&c)), Verdict::Live);
        assert_eq!(judge(Some(0.5), Some(&c)), Verdict::Replayed);
    }

    /// The boundary is the GEOMETRIC midpoint because the feature is a ratio spanning orders of
    /// magnitude — an arithmetic mean sits much closer to the replay class than it appears to.
    #[test]
    fn the_boundary_is_geometric_not_arithmetic() {
        let c = cal_of(&[4.0, 100.0, 200.0, 400.0], &[0.1, 0.5, 0.8, 1.0]).unwrap();
        assert!((c.threshold - 2.0).abs() < 0.01, "sqrt(4*1)=2, got {}", c.threshold);
        assert!(c.threshold < (4.0 + 1.0) / 2.0, "and below the arithmetic midpoint");
    }

    /// A pairing whose classes overlap cannot be judged on this feature, and must say so rather than
    /// pick a side. A phone speaker is the case this exists for.
    #[test]
    fn an_overlapping_pairing_refuses_to_judge() {
        let c = cal_of(&[0.9, 2.0, 5.0, 8.0], &[0.5, 1.2, 3.0, 4.0]).unwrap();
        assert!(!c.separable, "these classes overlap");
        assert_eq!(judge(Some(2.5), Some(&c)), Verdict::Unknown, "no confident answer is available");
    }

    #[test]
    fn an_uncalibrated_pairing_is_unknown_never_a_guess() {
        assert_eq!(judge(Some(500.0), None), Verdict::Unknown, "no calibration, no verdict");
        let c = cal_of(&[3.78, 92.7, 234.3, 1411.5], &[0.01, 0.28, 0.74, 1.67]).unwrap();
        assert_eq!(judge(None, Some(&c)), Verdict::Unknown, "no ratio, no verdict");
        assert_eq!(judge(Some(f32::NAN), Some(&c)), Verdict::Unknown);
    }

    #[test]
    fn a_thin_calibration_is_refused_with_the_count_named() {
        let e = cal_of(&[1.0, 2.0], &[0.1, 0.2, 0.3, 0.4]).unwrap_err();
        assert!(e.contains("at least"), "{e}");
        assert!(e.contains("got 2 live"), "{e}");
    }
}
