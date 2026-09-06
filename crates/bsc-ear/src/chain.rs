//! The signal chain, measured rather than named.
//!
//! The system can tell us "Scarlett Solo USB". It cannot tell us there is an AT2020 condenser on
//! it, what the gain knob is set to, whether the pad or phantom is engaged, or what the room sounds
//! like. Two identical interfaces — one on a condenser, one on a dynamic — produce entirely
//! different signals under an identical device name. **The label is not the chain.**
//!
//! So the chain is characterised by what it does when nothing is happening. A microphone's own
//! self-noise, plus the room's, has a shape: a condenser hisses differently from a laptop mic, and
//! HVAC prints on the low bands. That costs nothing to measure — record silence — and needs no
//! reference signal, unlike a round-trip sweep.
//!
//! **Shape and level are stored separately, and that is the point.** Turning a gain knob moves the
//! level and leaves the shape alone. Storing one number would make every gain change look like a
//! different microphone, which is exactly the failure this exists to avoid.

use serde::{Deserialize, Serialize};

/// Log-spaced bands, in Hz. Log rather than linear because hearing and microphone response are both
/// roughly logarithmic — eight linear bands would spend six of them above 4 kHz where almost
/// nothing distinguishing happens.
pub const BANDS: [(f32, f32); 8] = [
    (20.0, 60.0),
    (60.0, 125.0),
    (125.0, 250.0),
    (250.0, 500.0),
    (500.0, 1000.0),
    (1000.0, 2000.0),
    (2000.0, 4000.0),
    (4000.0, 8000.0),
];

/// What a capture chain sounds like when nothing is happening.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Signature {
    /// The device as the SYSTEM names it. Recorded for reference, never trusted as identity.
    pub device: String,
    /// Absolute self-noise level, RMS. Moves with the gain knob.
    pub level: f32,
    /// Fraction of noise energy per band, summing to 1. Does NOT move with the gain knob, which is
    /// why identity lives here and not in `level`.
    pub shape: Vec<f32>,
    pub seconds: f32,
    /// What the chain does to a played sound, per band, in dB relative to its own mean. `None`
    /// until a round trip has been run — absent rather than assumed flat, because a flat default
    /// would silently claim a measurement nobody took.
    #[serde(default)]
    pub response_db: Option<Vec<f32>>,
}

/// Why a recording could not be used as a noise floor.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Unusable {
    TooShort,
    /// So quiet that the shape would describe the converter's dither rather than the chain.
    TooQuiet,
    /// Something happened during it — speech, a keystroke, a door.
    NotQuiet(&'static str),
}

impl std::fmt::Display for Unusable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unusable::TooShort => write!(f, "too short to measure a noise floor"),
            Unusable::TooQuiet => write!(
                f,
                "too quiet to characterise — at this level the shape describes the converter's own \
                 dither rather than a microphone. Check the input is connected and the gain is up; \
                 `bsc ear levels` says which devices hear anything at all"
            ),
            Unusable::NotQuiet(why) => write!(
                f,
                "that was not silence — {why}. A floor taken over a sound is a signature of the \
                 sound, not of the chain, and it would then be wrong about every recording made \
                 through it"
            ),
        }
    }
}

/// Seconds of audio needed before a floor means anything.
pub const MIN_SECONDS: f32 = 2.0;
/// Below this level the shape is quantisation noise, not a chain.
///
/// MEASURED across three real inputs: the Scarlett with an AT2020 sits at rms 0.0038, the onboard
/// jack at 0.0014, and an unplugged headset at 0.0000. The last has no signature to take — its
/// "shape" would describe the dither of a dead converter — so it is refused as unmeasurable rather
/// than characterised.
pub const MIN_CHARACTERISABLE_RMS: f32 = 0.0005;

/// A crest this high is a genuine bang, not a floor.
///
/// DELIBERATELY LOOSE, because crest turned out to be a bad discriminator and I had it as the
/// primary guard. MEASURED: real silence spans crest 4.9-6.9 and real speech spans 5.7-9.5 — they
/// OVERLAP, so no threshold between them exists. Worse, crest is peak over rms, so a near-silent
/// input where one dither bit lands reads enormous: an unplugged headset measured 27.0. It is kept
/// only to catch an unmistakable transient, and `flux` does the real work.
pub const MAX_QUIET_CREST: f32 = 15.0;
/// Above this spectral flux the spectrum is moving, so something is going on.
///
/// THE GUARD THAT ACTUALLY WORKS, and the only one that cleanly separates the classes. MEASURED:
/// real silence spans flux 0.54-0.69 across three different inputs, real speech spans 0.99-1.02.
/// No overlap, so a boundary between them means something — unlike crest, which overlaps.
///
/// My first guess here was 0.35 and it was badly wrong: noise inherently has a spectrum that
/// jitters frame to frame, so genuine room tone was rejected as "not quiet".
pub const MAX_QUIET_FLUX: f32 = 0.85;

/// Measure a chain from a recording of nothing.
///
/// REFUSES a recording that is not actually quiet, and that guard is the whole reliability of this:
/// a floor taken while someone was talking is a signature of the talking, and every feature later
/// normalised against it would be wrong in the same direction without anything saying so.
pub fn signature(device: &str, samples: &[f32], sample_rate: u32) -> Result<Signature, Unusable> {
    let seconds = samples.len() as f32 / sample_rate.max(1) as f32;
    if seconds < MIN_SECONDS || samples.len() < crate::liveness::WINDOW * 2 {
        return Err(Unusable::TooShort);
    }
    if crate::audio::rms(samples) < MIN_CHARACTERISABLE_RMS {
        return Err(Unusable::TooQuiet);
    }
    if crate::classify::crest_factor(samples) > MAX_QUIET_CREST {
        return Err(Unusable::NotQuiet("something struck the microphone"));
    }
    if crate::classify::spectral_flux(samples, sample_rate) > MAX_QUIET_FLUX {
        return Err(Unusable::NotQuiet("the spectrum kept changing, so a sound was present"));
    }

    let mut acc = vec![0.0f32; BANDS.len()];
    let mut frames = 0usize;
    let mut at = 0usize;
    while at + crate::liveness::WINDOW <= samples.len() {
        let mag = crate::liveness::magnitudes(&samples[at..at + crate::liveness::WINDOW]);
        for (i, (lo, hi)) in BANDS.iter().enumerate() {
            let n = crate::liveness::WINDOW as f32;
            let a = (*lo * n / sample_rate as f32) as usize;
            let b = ((*hi * n / sample_rate as f32) as usize).min(mag.len());
            acc[i] += (a..b).map(|k| mag[k] * mag[k]).sum::<f32>();
        }
        frames += 1;
        at += crate::liveness::WINDOW;
    }
    if frames == 0 {
        return Err(Unusable::TooShort);
    }
    let total: f32 = acc.iter().sum();
    if !total.is_finite() || total <= 0.0 {
        return Err(Unusable::NotQuiet("no measurable signal at all — the input may be dead"));
    }
    Ok(Signature {
        device: device.to_string(),
        level: crate::audio::rms(samples),
        shape: acc.iter().map(|a| a / total).collect(),
        seconds,
        response_db: None,
    })
}

/// How different two chains are, ignoring gain.
///
/// Compares SHAPE only, in log space, because a difference between 0.001 and 0.002 matters as much
/// as one between 0.1 and 0.2 — a linear distance would notice only the loud bands and call two
/// chains identical because they agree about where most of the energy is.
pub fn distance(a: &Signature, b: &Signature) -> f32 {
    if a.shape.len() != b.shape.len() || a.shape.is_empty() {
        return f32::INFINITY;
    }
    let d: f32 = a
        .shape
        .iter()
        .zip(&b.shape)
        .map(|(x, y)| ((x.max(1e-9)).log10() - (y.max(1e-9)).log10()).abs())
        .sum();
    d / a.shape.len() as f32
}

/// Below this distance two recordings are the same chain; above it they are not.
///
/// A PLACEHOLDER until it is measured across real chains — stated as a constant so that when it is
/// measured, there is one place to put the answer, and so nobody mistakes it for a finding.
pub const SAME_CHAIN: f32 = 0.15;

// ── Round trip ────────────────────────────────────────────────────────────────────────────────────
//
// The noise floor characterises the chain at rest. This characterises what it DOES to a sound: play
// a known signal, record it, and the ratio per band is the response of speaker x room x microphone.
//
// That the three are entangled sounds like a confound and is not. It is exactly the path every real
// sound takes to reach the ear, so it is the thing worth knowing — and it is what lets audio
// recorded somewhere else be normalised into this room, which is the whole reason to measure it.

/// A logarithmic sine sweep — the standard excitation, because it spends equal time per OCTAVE and
/// so measures the low bands as well as the high ones. A linear sweep would rush through everything
/// below 1 kHz and leave the bands that distinguish chains barely excited.
pub fn sweep(seconds: f32, sample_rate: u32, from_hz: f32, to_hz: f32) -> Vec<f32> {
    let n = (seconds * sample_rate as f32) as usize;
    if n == 0 || from_hz <= 0.0 || to_hz <= from_hz {
        return vec![];
    }
    let t_end = seconds;
    let k = (to_hz / from_hz).ln();
    (0..n)
        .map(|i| {
            let t = i as f32 / sample_rate as f32;
            // Instantaneous phase of an exponential chirp.
            let phase = 2.0 * std::f32::consts::PI * from_hz * t_end / k * ((k * t / t_end).exp() - 1.0);
            // Fade the ends: a sweep that starts and stops abruptly rings the speaker and smears
            // the very bands being measured.
            let fade = (i as f32 / (sample_rate as f32 * 0.05)).min(1.0)
                * (((n - i) as f32) / (sample_rate as f32 * 0.05)).min(1.0);
            0.5 * fade * phase.sin()
        })
        .collect()
}

/// Energy per band of a whole recording, unnormalised.
pub fn band_energy(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let mut acc = vec![0.0f32; BANDS.len()];
    let mut at = 0usize;
    while at + crate::liveness::WINDOW <= samples.len() {
        let mag = crate::liveness::magnitudes(&samples[at..at + crate::liveness::WINDOW]);
        for (i, (lo, hi)) in BANDS.iter().enumerate() {
            let n = crate::liveness::WINDOW as f32;
            let a = (*lo * n / sample_rate as f32) as usize;
            let b = ((*hi * n / sample_rate as f32) as usize).min(mag.len());
            acc[i] += (a..b).map(|k| mag[k] * mag[k]).sum::<f32>();
        }
        at += crate::liveness::WINDOW;
    }
    acc
}

/// What the chain did to each band, in dB, relative to its own average.
///
/// RELATIVE, not absolute, and that is deliberate: absolute gain depends on the speaker's volume and
/// the microphone's, neither of which is knowable and both of which a person changes. What survives
/// those is the SHAPE — which bands the chain favours — and that is what normalisation needs.
pub fn response_db(source: &[f32], recorded: &[f32]) -> Result<Vec<f32>, String> {
    if source.len() != recorded.len() || source.is_empty() {
        return Err("source and recording were not analysed into the same bands".into());
    }
    let raw: Vec<f32> = source
        .iter()
        .zip(recorded)
        .map(|(s, r)| {
            if *s <= 0.0 || *r <= 0.0 {
                f32::NEG_INFINITY
            } else {
                10.0 * (r / s).log10()
            }
        })
        .collect();
    let usable: Vec<f32> = raw.iter().copied().filter(|d| d.is_finite()).collect();
    if usable.is_empty() {
        return Err("nothing came back — the sweep did not reach the microphone".into());
    }
    let mean = usable.iter().sum::<f32>() / usable.len() as f32;
    // A band the sweep never reached stays at the floor rather than being invented.
    Ok(raw.iter().map(|d| if d.is_finite() { d - mean } else { f32::NEG_INFINITY }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 16_000;

    fn noise(secs: f32, amp: f32, tilt: f32) -> Vec<f32> {
        // `tilt` shapes the noise: a one-pole lowpass, so higher tilt means a darker chain.
        let n = (SR as f32 * secs) as usize;
        let mut st = 0x2545_F491_4F6C_DD1Du64;
        let mut y = 0.0f32;
        (0..n)
            .map(|_| {
                st ^= st << 13;
                st ^= st >> 7;
                st ^= st << 17;
                let white = ((st >> 40) as f32 / 8_388_608.0) - 1.0;
                y = y * tilt + white * (1.0 - tilt);
                y * amp
            })
            .collect()
    }

    /// THE POINT OF SPLITTING SHAPE FROM LEVEL. Turning a gain knob must not look like changing the
    /// microphone — and the AT2020-on-a-Scarlett case is exactly a knob the system cannot see.
    #[test]
    fn gain_moves_the_level_and_leaves_the_identity_alone() {
        let quiet = signature("mic", &noise(3.0, 0.002, 0.5), SR).unwrap();
        let loud = signature("mic", &noise(3.0, 0.02, 0.5), SR).unwrap();
        assert!(loud.level > quiet.level * 5.0, "the level must follow the knob");
        assert!(
            distance(&quiet, &loud) < 0.02,
            "but the chain must read as the SAME one: distance {}",
            distance(&quiet, &loud)
        );
    }

    #[test]
    fn differently_shaped_chains_are_distinguishable() {
        let bright = signature("a", &noise(3.0, 0.005, 0.1), SR).unwrap();
        let dark = signature("b", &noise(3.0, 0.005, 0.9), SR).unwrap();
        assert!(
            distance(&bright, &dark) > SAME_CHAIN,
            "a bright and a dark chain must not read as one: {}",
            distance(&bright, &dark)
        );
    }

    /// A floor taken over a SOUND is a signature of the sound. Everything later normalised against
    /// it would be wrong in the same direction, and nothing would say so — so it is refused.
    #[test]
    fn a_recording_that_is_not_silence_is_refused_with_the_reason() {
        // Impulses: a keystroke, a knock.
        let mut clicky = noise(3.0, 0.002, 0.5);
        for i in (0..clicky.len()).step_by(4000) {
            clicky[i] = 0.9;
        }
        match signature("mic", &clicky, SR) {
            Err(Unusable::NotQuiet(_)) => {}
            other => panic!("impulses must be refused, got {other:?}"),
        }

        // A spectrum that keeps moving — many changes, not one. A SINGLE change in three seconds is
        // correctly IGNORED: averaging over the recording should not let one event disqualify a
        // floor, and an earlier version of this test wrongly expected it to.
        //
        // The content alternates between widely separated tones, because that is what genuinely
        // maximises frame-to-frame spectral change. Alternating two shades of NOISE does not reach
        // it — noise already jitters, so swapping its tilt barely moves the average, which is why
        // an earlier version of this test failed against a threshold real speech clears easily.
        let mut moving = Vec::new();
        for i in 0..20 {
            let hz = if i % 2 == 0 { 200.0 } else { 3500.0 };
            let n = (SR as f32 * 0.15) as usize;
            moving.extend((0..n).map(|k| {
                0.2 * (2.0 * std::f32::consts::PI * hz * k as f32 / SR as f32).sin()
            }));
        }
        assert!(
            matches!(signature("mic", &moving, SR), Err(Unusable::NotQuiet(_))),
            "a continuously changing spectrum is not a noise floor"
        );
    }

    #[test]
    fn too_little_audio_is_refused_rather_than_guessed_at() {
        assert_eq!(signature("mic", &noise(0.5, 0.002, 0.5), SR), Err(Unusable::TooShort));
        assert_eq!(signature("mic", &[], SR), Err(Unusable::TooShort));
    }

    /// A dead input has no shape at all — its "signature" would describe converter dither. It is
    /// refused as UNMEASURABLE, which is a different thing from "not silent" and gets its own
    /// message: an unplugged headset measured rms 0.0000 and crest 27.0, and telling its owner that
    /// something impulsive happened would send them looking for a noise that is not there.
    #[test]
    fn a_dead_input_is_too_quiet_to_characterise_rather_than_noisy() {
        assert_eq!(signature("mic", &vec![0.0f32; SR as usize * 3], SR), Err(Unusable::TooQuiet));
        // The real measurement from an unplugged headset: essentially zero with occasional dither.
        let mut dither = vec![0.0f32; SR as usize * 3];
        dither[1000] = 0.0004;
        assert_eq!(signature("mic", &dither, SR), Err(Unusable::TooQuiet));
    }

    #[test]
    fn the_shape_is_a_distribution_and_the_distance_is_symmetric() {
        let a = signature("a", &noise(3.0, 0.004, 0.3), SR).unwrap();
        let b = signature("b", &noise(3.0, 0.004, 0.7), SR).unwrap();
        assert_eq!(a.shape.len(), BANDS.len());
        assert!((a.shape.iter().sum::<f32>() - 1.0).abs() < 1e-4, "shape must sum to one");
        assert!((distance(&a, &b) - distance(&b, &a)).abs() < 1e-6, "distance must be symmetric");
        assert_eq!(distance(&a, &a), 0.0, "a chain is identical to itself");
    }

    #[test]
    fn mismatched_signatures_are_infinitely_far_apart_rather_than_wrong() {
        let a = signature("a", &noise(3.0, 0.004, 0.3), SR).unwrap();
        let mut b = a.clone();
        b.shape.truncate(3);
        assert_eq!(distance(&a, &b), f32::INFINITY);
    }
}

#[cfg(test)]
mod sweep_tests {
    use super::*;

    const SR: u32 = 16_000;

    #[test]
    fn a_log_sweep_reaches_every_band_it_claims_to() {
        let s = sweep(4.0, SR, 30.0, 7000.0);
        assert_eq!(s.len(), 4 * SR as usize);
        let e = band_energy(&s, SR);
        // Equal time per octave is the point: every band must be genuinely excited, or the bands it
        // skipped would come back as "the chain does not pass them".
        let total: f32 = e.iter().sum();
        for (i, ((lo, hi), v)) in BANDS.iter().zip(&e).enumerate() {
            if *hi <= 7000.0 && *lo >= 30.0 {
                assert!(*v / total > 0.01, "band {i} ({lo}-{hi}Hz) got only {:.4}", v / total);
            }
        }
    }

    #[test]
    fn a_sweep_starts_and_ends_softly() {
        let s = sweep(2.0, SR, 50.0, 5000.0);
        assert!(s[0].abs() < 0.02, "an abrupt start rings the speaker: {}", s[0]);
        assert!(s[s.len() - 1].abs() < 0.02, "and so does an abrupt stop");
        assert!(s.iter().any(|x| x.abs() > 0.3), "but the middle must be at level");
    }

    #[test]
    fn degenerate_sweeps_are_empty_rather_than_wrong() {
        assert!(sweep(0.0, SR, 50.0, 5000.0).is_empty());
        assert!(sweep(1.0, SR, 5000.0, 50.0).is_empty(), "a descending range is not a sweep");
        assert!(sweep(1.0, SR, 0.0, 5000.0).is_empty());
    }

    /// The response is RELATIVE to its own mean, so a louder speaker or a hotter preamp shifts every
    /// band equally and changes nothing. Absolute gain is not knowable and a person changes it.
    #[test]
    fn overall_gain_does_not_change_the_measured_shape() {
        let src = vec![1.0, 1.0, 1.0, 1.0];
        let quiet = response_db(&src, &[0.5, 1.0, 2.0, 4.0]).unwrap();
        let loud = response_db(&src, &[5.0, 10.0, 20.0, 40.0]).unwrap();
        for (a, b) in quiet.iter().zip(&loud) {
            assert!((a - b).abs() < 1e-4, "gain moved the shape: {a} vs {b}");
        }
    }

    #[test]
    fn a_chain_that_favours_a_band_reports_it_above_the_mean() {
        let r = response_db(&[1.0, 1.0, 1.0], &[1.0, 10.0, 1.0]).unwrap();
        assert!(r[1] > r[0] && r[1] > r[2], "the boosted band must read highest: {r:?}");
        assert!(r[0] < 0.0 && r[2] < 0.0, "and the others below the mean");
    }

    /// A band the sweep never reached must stay at the floor rather than be invented as flat —
    /// claiming a measurement nobody took is the failure this whole module exists to avoid.
    #[test]
    fn a_band_with_nothing_in_it_is_not_given_a_number() {
        let r = response_db(&[1.0, 1.0, 0.0], &[1.0, 1.0, 0.0]).unwrap();
        assert!(r[2].is_infinite() && r[2] < 0.0, "an unmeasured band stays unmeasured: {r:?}");
        assert!(r[0].is_finite() && r[1].is_finite());
    }

    #[test]
    fn a_recording_with_nothing_in_it_is_refused() {
        assert!(response_db(&[1.0, 1.0], &[0.0, 0.0]).unwrap_err().contains("did not reach"));
        assert!(response_db(&[], &[]).is_err());
        assert!(response_db(&[1.0], &[1.0, 1.0]).is_err(), "mismatched band counts");
    }
}
