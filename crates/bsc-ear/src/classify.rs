//! What KIND of sound this is — the features, measured before any classifier is chosen.
//!
//! `liveness` answers one question (a voice in the room, or one played at a microphone) from two
//! bands, and it works because the claim is small and the separation was measured. This is the same
//! method widened: a handful of features, each chosen because a specific class moves it, and each
//! checkable against real recordings rather than a benchmark.
//!
//! **The load-bearing one is modulation.** Speech amplitude rises and falls at the syllable rate,
//! roughly 2-8 Hz with a peak near 4. A fan has no envelope at all, a keyboard is all transient and
//! no envelope, and music modulates on a beat rather than a syllable. That single number separates
//! "someone is talking" from "the room is making noise" far better than loudness does — and
//! loudness is what the ear currently decides on.
//!
//! No model here, deliberately, and the same reasoning as liveness: a curated set of measured
//! features whose failures are inspectable beats a 527-class network whose label nobody can argue
//! with. YAMNet remains the fallback for classes these cannot reach.

use crate::liveness::{self, WINDOW};
use serde::{Deserialize, Serialize};

/// Envelope frames per second — 50, i.e. one per 20 ms, which resolves modulation to 25 Hz and
/// comfortably covers the syllable band.
pub const ENVELOPE_HZ: f32 = 50.0;
/// The band a speaking voice modulates in.
pub const SYLLABLE_BAND: (f32, f32) = (2.0, 8.0);

/// The measurements. Each is here because some class moves it, and none is a verdict on its own.
#[derive(Clone, Copy, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct Features {
    /// Overall level. Separates silence from everything.
    pub rms: f32,
    /// Fraction of envelope energy in the syllable band. HIGH for speech, low for steady noise.
    pub modulation: f32,
    /// Peak over RMS. High for impulsive sounds — a keystroke, a door — low for sustained ones.
    pub crest: f32,
    /// Mean absolute change between successive spectra. LOW for a fan, high for speech or music.
    pub flux: f32,
    /// Centre of spectral mass, Hz. Low for rumble, high for hiss and consonants.
    pub centroid: f32,
    /// The liveness ratio: voice fundamental over rumble. Distinguishes a room voice from a speaker.
    pub fundamental_ratio: f32,
    pub seconds: f32,
}

/// Amplitude envelope: RMS per 20 ms hop.
fn envelope(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let hop = (sample_rate as f32 / ENVELOPE_HZ) as usize;
    if hop == 0 {
        return vec![];
    }
    samples.chunks(hop).map(crate::audio::rms).collect()
}

/// How much of the envelope's variation sits at the syllable rate.
///
/// The envelope is itself a signal, sampled at 50 Hz, so this is a transform of a transform — the
/// modulation spectrum. Speech peaks near 4 Hz because that is how fast a mouth opens and closes.
pub fn modulation_index(samples: &[f32], sample_rate: u32) -> f32 {
    let env = envelope(samples, sample_rate);
    // Need enough envelope to resolve 2 Hz: at 50 Hz that is 64 frames, ~1.3 s of audio.
    if env.len() < 64 {
        return 0.0;
    }
    let n = env.len().next_power_of_two().clamp(64, 512);
    let mean = env.iter().sum::<f32>() / env.len() as f32;
    if mean <= f32::EPSILON {
        return 0.0;
    }
    // Mean-removed, so this measures VARIATION rather than level — a loud steady fan must not
    // score like speech simply for being loud.
    let mut re: Vec<f32> = (0..n).map(|i| env.get(i).copied().unwrap_or(mean) - mean).collect();
    let mut im = vec![0.0f32; n];
    liveness::fft_public(&mut re, &mut im);
    let bin = |hz: f32| ((hz * n as f32 / ENVELOPE_HZ) as usize).min(n / 2);
    let power = |a: usize, b: usize| -> f32 {
        (a..b.max(a + 1)).map(|k| re[k] * re[k] + im[k] * im[k]).sum()
    };
    let total = power(1, n / 2);
    if total <= f32::EPSILON {
        return 0.0;
    }
    power(bin(SYLLABLE_BAND.0), bin(SYLLABLE_BAND.1)) / total
}

/// Peak over RMS — how impulsive the sound is.
pub fn crest_factor(samples: &[f32]) -> f32 {
    let r = crate::audio::rms(samples);
    if r <= f32::EPSILON {
        return 0.0;
    }
    samples.iter().fold(0.0f32, |m, s| m.max(s.abs())) / r
}

/// Mean spectral change between successive windows — low for stationary noise.
pub fn spectral_flux(samples: &[f32], sample_rate: u32) -> f32 {
    let mut prev: Option<Vec<f32>> = None;
    let mut acc = 0.0f32;
    let mut n = 0usize;
    let mut at = 0usize;
    while at + WINDOW <= samples.len() {
        let mag = liveness::magnitudes(&samples[at..at + WINDOW]);
        let total: f32 = mag.iter().sum::<f32>().max(f32::EPSILON);
        let norm: Vec<f32> = mag.iter().map(|m| m / total).collect();
        if let Some(p) = &prev {
            acc += p.iter().zip(&norm).map(|(a, b)| (a - b).abs()).sum::<f32>();
            n += 1;
        }
        prev = Some(norm);
        at += WINDOW;
    }
    let _ = sample_rate;
    if n == 0 {
        0.0
    } else {
        acc / n as f32
    }
}

/// Centre of spectral mass, in Hz.
pub fn spectral_centroid(samples: &[f32], sample_rate: u32) -> f32 {
    if samples.len() < WINDOW {
        return 0.0;
    }
    let mag = liveness::magnitudes(&samples[..WINDOW]);
    let total: f32 = mag.iter().sum();
    if total <= f32::EPSILON {
        return 0.0;
    }
    let weighted: f32 = mag
        .iter()
        .enumerate()
        .map(|(k, m)| m * (k as f32 * sample_rate as f32 / WINDOW as f32))
        .sum();
    weighted / total
}

/// Measure everything about one recording.
pub fn measure(samples: &[f32], sample_rate: u32) -> Features {
    Features {
        rms: crate::audio::rms(samples),
        modulation: modulation_index(samples, sample_rate),
        crest: crest_factor(samples),
        flux: spectral_flux(samples, sample_rate),
        centroid: spectral_centroid(samples, sample_rate),
        fundamental_ratio: liveness::liveness_ratio(samples, sample_rate).unwrap_or(0.0),
        seconds: samples.len() as f32 / sample_rate.max(1) as f32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 16_000;

    /// A carrier whose amplitude rises and falls at `mod_hz` — the shape of a talking mouth.
    fn modulated(carrier_hz: f32, mod_hz: f32, secs: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let env = 0.5 + 0.5 * (2.0 * std::f32::consts::PI * mod_hz * t).sin();
                env * (2.0 * std::f32::consts::PI * carrier_hz * t).sin() * 0.4
            })
            .collect()
    }
    fn steady(hz: f32, secs: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        (0..n).map(|i| 0.4 * (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin()).collect()
    }
    fn clicks(secs: f32, per_sec: f32) -> Vec<f32> {
        let n = (SR as f32 * secs) as usize;
        let period = (SR as f32 / per_sec) as usize;
        (0..n).map(|i| if i % period < 40 { 0.9 } else { 0.0 }).collect()
    }

    /// THE FEATURE THE WHOLE MODULE RESTS ON. A talking voice modulates at the syllable rate; a fan
    /// does not modulate at all. Loudness cannot tell those apart and it is what the ear currently
    /// decides on.
    #[test]
    fn syllable_rate_modulation_separates_speech_from_steady_noise() {
        let speechlike = modulation_index(&modulated(200.0, 4.0, 3.0), SR);
        let fanlike = modulation_index(&steady(200.0, 3.0), SR);
        assert!(
            speechlike > fanlike * 5.0,
            "4Hz-modulated {speechlike:.3} must dwarf steady {fanlike:.3}"
        );
        assert!(speechlike > 0.3, "most envelope energy should sit in the syllable band: {speechlike:.3}");
    }

    /// Modulation OUTSIDE the syllable band must not count. A tremolo at 15Hz is not speech, and a
    /// feature that scored it as such would be measuring "varies" rather than "is spoken".
    #[test]
    fn modulation_outside_the_syllable_band_does_not_count_as_speech() {
        let too_fast = modulation_index(&modulated(200.0, 15.0, 3.0), SR);
        let just_right = modulation_index(&modulated(200.0, 4.0, 3.0), SR);
        assert!(just_right > too_fast * 3.0, "4Hz {just_right:.3} vs 15Hz {too_fast:.3}");
    }

    /// A LOUD steady sound must not score like speech merely for being loud — the envelope is
    /// mean-removed precisely so level cannot masquerade as variation.
    #[test]
    fn loudness_alone_never_looks_like_speech() {
        let quiet = modulation_index(&steady(200.0, 3.0), SR);
        let loud: Vec<f32> = steady(200.0, 3.0).iter().map(|s| s * 8.0).collect();
        assert!((modulation_index(&loud, SR) - quiet).abs() < 0.05, "level must not move it");
    }

    #[test]
    fn impulsive_sounds_have_a_high_crest_factor_and_sustained_ones_do_not() {
        assert!(crest_factor(&clicks(2.0, 6.0)) > 4.0, "keystrokes are peaky");
        assert!(crest_factor(&steady(200.0, 2.0)) < 2.0, "a tone is not");
        assert_eq!(crest_factor(&[]), 0.0);
        assert_eq!(crest_factor(&vec![0.0; 1000]), 0.0, "silence has no crest, and no divide by zero");
    }

    /// A fan is the same spectrum second after second; a voice is not. This is what tells a
    /// stationary machine from something making meaning.
    #[test]
    fn spectral_flux_is_low_for_stationary_sound_and_high_for_changing_sound() {
        let fan = spectral_flux(&steady(300.0, 3.0), SR);
        let mut varying = steady(200.0, 1.0);
        varying.extend(steady(1200.0, 1.0));
        varying.extend(steady(400.0, 1.0));
        assert!(varying_flux_beats(varying, fan), "a changing spectrum must flux more than a fixed one");
    }
    fn varying_flux_beats(v: Vec<f32>, fan: f32) -> bool {
        spectral_flux(&v, SR) > fan * 2.0
    }

    #[test]
    fn the_centroid_follows_where_the_energy_actually_is() {
        let low = spectral_centroid(&steady(150.0, 1.0), SR);
        let high = spectral_centroid(&steady(4000.0, 1.0), SR);
        assert!(high > low * 5.0, "low {low:.0}Hz vs high {high:.0}Hz");
        assert_eq!(spectral_centroid(&[], SR), 0.0);
    }

    #[test]
    fn degenerate_input_yields_zeros_rather_than_panics() {
        for s in [vec![], vec![0.0; 100], vec![0.0; SR as usize]] {
            let f = measure(&s, SR);
            assert!(f.rms.is_finite() && f.modulation.is_finite() && f.crest.is_finite());
            assert!(f.flux.is_finite() && f.centroid.is_finite());
        }
        let f = measure(&steady(200.0, 1.0), 0);
        assert!(f.seconds.is_finite(), "a zero sample rate must not divide by zero");
    }
}
