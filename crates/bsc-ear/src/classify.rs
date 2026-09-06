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

// ── The classifier ────────────────────────────────────────────────────────────────────────────────
//
// Nearest-centroid over robustly-scaled features, learned from labelled examples rather than
// written down. The rule that fell out of the ESC-50 measurements — flux > 0.90 and crest < 12,
// which found 12/12 speech at 1.6% false positives over 319 clips — is a good rule, and hardcoding
// it would have meant editing this file to add a class. Learning it means adding recordings.
//
// **It answers `Unknown` freely.** A sound unlike anything it was shown must not be forced into the
// nearest bucket: the whole reason to classify is to decide what to keep, and a confident wrong
// label is worse for that than an admitted gap.

/// The features, as a vector, in a fixed order. Ordered so the model file is readable and so a
/// reordering cannot silently change what a stored model means.
pub const FEATURE_NAMES: [&str; 5] = ["log_rms", "modulation", "log_crest", "flux", "log_centroid"];

/// Features as the classifier sees them.
///
/// Three are LOGGED because they span orders of magnitude — rms runs 0.001 to 0.2, crest 4 to 28,
/// centroid 1300 to 2800. On a linear scale the distance between two quiet sounds would round to
/// nothing while two loud ones looked far apart, and the classifier would be measuring loudness.
pub fn vector(f: &Features) -> [f32; 5] {
    let lg = |x: f32| (x.max(1e-6)).log10();
    [lg(f.rms), f.modulation, lg(f.crest.max(1.0)), f.flux, lg(f.centroid.max(1.0))]
}

/// One class, as learned.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Profile {
    pub class: String,
    /// Median of each feature — robust to the one clip in forty that is mislabelled or clipped.
    pub centre: Vec<f32>,
    pub examples: usize,
}

/// What was learned from a labelled set.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Model {
    pub profiles: Vec<Profile>,
    /// Per-feature spread across ALL classes, used to scale distances. Without it the classifier
    /// would be dominated by whichever feature happens to have the largest raw range.
    pub scale: Vec<f32>,
    /// Beyond this scaled distance nothing is claimed.
    pub reject_beyond: f32,
}

fn median(v: &mut [f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[v.len() / 2]
}

/// Fewer examples than this and a class centre is an accident of which clips were picked.
pub const MIN_EXAMPLES: usize = 5;

/// Learn from labelled examples: `(class, features)`.
pub fn train(labelled: &[(String, Features)], reject_beyond: f32) -> Result<Model, String> {
    if labelled.is_empty() {
        return Err("nothing to learn from".into());
    }
    let mut by_class: std::collections::BTreeMap<String, Vec<[f32; 5]>> = Default::default();
    for (c, f) in labelled {
        by_class.entry(c.clone()).or_default().push(vector(f));
    }
    let thin: Vec<&String> =
        by_class.iter().filter(|(_, v)| v.len() < MIN_EXAMPLES).map(|(k, _)| k).collect();
    if !thin.is_empty() {
        return Err(format!(
            "these classes have fewer than {MIN_EXAMPLES} examples, so their centre would be an \
             accident of which clips were picked: {}",
            thin.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    // Scale from the spread ACROSS everything, so no feature dominates by having big numbers.
    let mut scale = vec![0.0f32; FEATURE_NAMES.len()];
    for (i, slot) in scale.iter_mut().enumerate() {
        let mut col: Vec<f32> = labelled.iter().map(|(_, f)| vector(f)[i]).collect();
        col.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let q = |p: f32| col[((col.len() - 1) as f32 * p) as usize];
        // Interquartile range, not standard deviation: one clipped outlier must not widen the
        // scale and squash every real difference along that axis.
        //
        // A feature can be FLAT across the whole corpus — few examples, or a genuinely constant
        // measurement. Scaling by that near-zero spread turns any unseen value on that axis into an
        // enormous distance and every verdict into "unknown", which reads as a cautious classifier
        // rather than the arithmetic accident it is. So fall back to the full range, and then to
        // one unit: a feature that does not vary cannot discriminate and must not dominate either.
        let iqr = q(0.75) - q(0.25);
        let range = col[col.len() - 1] - col[0];
        *slot = if iqr > 1e-3 {
            iqr
        } else if range > 1e-3 {
            range
        } else {
            1.0
        };
    }
    let profiles = by_class
        .into_iter()
        .map(|(class, rows)| {
            let centre = (0..FEATURE_NAMES.len())
                .map(|i| median(&mut rows.iter().map(|r| r[i]).collect::<Vec<_>>()))
                .collect();
            Profile { class, centre, examples: rows.len() }
        })
        .collect();
    Ok(Model { profiles, scale, reject_beyond })
}

/// What the classifier decided, and how sure it is.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Verdict {
    /// `None` when nothing was close enough to claim.
    pub class: Option<String>,
    /// Scaled distance to the nearest class centre.
    pub distance: f32,
    /// The runner-up, and its distance — an answer that only just beat another is worth seeing.
    pub runner_up: Option<(String, f32)>,
}

/// Classify one measurement.
pub fn classify(f: &Features, m: &Model) -> Verdict {
    let v = vector(f);
    let mut scored: Vec<(f32, &Profile)> = m
        .profiles
        .iter()
        .map(|p| {
            let d: f32 = v
                .iter()
                .zip(&p.centre)
                .zip(&m.scale)
                .map(|((x, c), s)| ((x - c) / s.max(1e-6)).powi(2))
                .sum::<f32>()
                .sqrt();
            (d, p)
        })
        .collect();
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let (best_d, best) = match scored.first() {
        Some(x) => *x,
        None => return Verdict { class: None, distance: f32::INFINITY, runner_up: None },
    };
    Verdict {
        class: (best_d <= m.reject_beyond).then(|| best.class.clone()),
        distance: best_d,
        runner_up: scored.get(1).map(|(d, p)| (p.class.clone(), *d)),
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

    /// Build a measurement with only the features the classifier reads set.
    fn feat(rms: f32, modulation: f32, crest: f32, flux: f32, centroid: f32) -> Features {
        Features { rms, modulation, crest, flux, centroid, fundamental_ratio: 0.0, seconds: 5.0 }
    }

    /// A class of `n` examples scattered around a centre. Every feature is jittered, because a
    /// corpus where one feature is the only thing that varies gives that feature a near-zero
    /// spread — and the scaling then hands it the entire verdict.
    fn corpus(class: &str, n: usize, rms: f32, flux: f32) -> Vec<(String, Features)> {
        (0..n)
            .map(|i| {
                let t = i as f32 / (n.max(2) - 1) as f32 - 0.5; // -0.5 ..= 0.5
                (
                    class.to_string(),
                    feat(
                        rms * (1.0 + t),
                        (0.35 + t * 0.2).clamp(0.05, 0.95),
                        8.0 + t * 5.0,
                        (flux + t * 0.1).clamp(0.0, 1.2),
                        1500.0 * (1.0 + t),
                    ),
                )
            })
            .collect()
    }

    /// A class learned from two clips has a centre that says more about which two were picked than
    /// about the sound. Refusing NAMES the thin classes, because "training failed" is unactionable.
    #[test]
    fn a_class_with_too_few_examples_is_refused_and_named() {
        let mut set = corpus("speech", MIN_EXAMPLES, 0.05, 0.99);
        set.extend(corpus("car_horn", 2, 0.1, 0.53));
        let err = train(&set, 3.0).expect_err("two examples is not a class");
        assert!(err.contains("car_horn"), "the thin class must be named: {err}");
        assert!(!err.contains("speech"), "a class with enough examples is not blamed: {err}");
        assert!(train(&[], 3.0).is_err(), "nothing to learn from is an error, not an empty model");
    }

    /// The whole point of a reject radius: the ear meets sounds nobody labelled, and answering
    /// "the nearest of the nine things I know" would be a confident lie. Proven by turning the
    /// radius up until the SAME sound is claimed — so the test cannot pass for another reason.
    #[test]
    fn an_unfamiliar_sound_is_unknown_rather_than_the_nearest_bucket() {
        let mut set = corpus("speech", 6, 0.05, 0.99);
        set.extend(corpus("rain", 6, 0.06, 0.60));
        let strict = train(&set, 3.0).unwrap();
        let alien = feat(0.0001, 0.95, 40.0, 0.05, 60.0);
        let v = classify(&alien, &strict);
        assert_eq!(v.class, None, "nothing was close enough to claim (d={})", v.distance);
        assert!(v.distance > 3.0);

        let loose = Model { reject_beyond: f32::INFINITY, ..strict };
        assert!(
            classify(&alien, &loose).class.is_some(),
            "with no radius the same sound IS claimed — so the radius is what refused it"
        );
    }

    /// Distances are scaled by each feature's spread ACROSS the corpus, so a feature that wanders
    /// widely WITHIN every class counts for less than one that separates them. Without that, the
    /// feature with the biggest raw numbers decides — and here it decides WRONGLY, which is what
    /// makes this a guard rather than a restatement.
    #[test]
    fn the_scale_stops_a_wide_wandering_feature_from_deciding() {
        // Two classes separated narrowly by flux; centroid wanders over two decades inside BOTH.
        let spread_a = [100.0, 500.0, 1000.0, 5000.0, 20000.0];
        let spread_b = [200.0, 800.0, 2000.0, 8000.0, 30000.0];
        let mut set: Vec<(String, Features)> =
            spread_a.iter().map(|c| ("quiet_hum".to_string(), feat(0.05, 0.3, 8.0, 0.50, *c))).collect();
        set.extend(spread_b.iter().map(|c| ("busy_hum".to_string(), feat(0.05, 0.3, 8.0, 0.62, *c))));
        let m = train(&set, 10.0).unwrap();

        // A probe whose FLUX says busy_hum and whose CENTROID sits low, near quiet_hum's centre.
        let probe = feat(0.05, 0.3, 8.0, 0.61, 300.0);
        assert_eq!(
            classify(&probe, &m).class.as_deref(),
            Some("busy_hum"),
            "the feature that SEPARATES the classes must decide"
        );

        // The same nearest-centroid arithmetic with the scaling removed picks the other class.
        let v = vector(&probe);
        let raw = |name: &str| -> f32 {
            let p = m.profiles.iter().find(|p| p.class == name).unwrap();
            v.iter().zip(&p.centre).map(|(x, c)| (x - c).powi(2)).sum::<f32>().sqrt()
        };
        assert!(
            raw("quiet_hum") < raw("busy_hum"),
            "unscaled, the wandering feature wins and the answer is wrong ({} vs {}) — that is what \
             the scale exists to prevent",
            raw("quiet_hum"),
            raw("busy_hum")
        );
    }

    /// A centre is a MEDIAN, so the one clip in forty that is clipped, mislabelled or silent moves
    /// it by nothing. A mean would drag the whole class toward the outlier.
    #[test]
    fn one_wild_clip_cannot_move_a_class_centre() {
        let honest = corpus("speech", 25, 0.05, 0.99);
        let clean = train(&honest, 3.0).unwrap();
        let mut poisoned = honest.clone();
        poisoned.push(("speech".to_string(), feat(0.000001, 0.99, 200.0, 0.01, 20.0)));
        let dirty = train(&poisoned, 3.0).unwrap();
        let a = &clean.profiles[0].centre;
        let b = &dirty.profiles[0].centre;
        for (i, name) in FEATURE_NAMES.iter().enumerate() {
            // A median is an OBSERVED value, so adding one clip can at worst step it one position
            // along the honest column — however wild that clip is. A mean has no such bound.
            let mut col: Vec<f32> = honest.iter().map(|(_, f)| vector(f)[i]).collect();
            col.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let at = |v: f32| col.iter().position(|c| (c - v).abs() < 1e-6);
            let (ia, ib) = (at(a[i]).expect("clean centre is an observed value"), at(b[i]));
            let ib = ib.unwrap_or_else(|| panic!("{name}: poisoned centre {} is not a value any honest clip has", b[i]));
            assert!(
                ia.abs_diff(ib) <= 1,
                "{name}: the centre jumped {} positions ({} → {}) — one outlier moved it further \
                 than one clip",
                ia.abs_diff(ib),
                a[i],
                b[i]
            );
        }
    }

    /// A feature can be FLAT across a whole corpus — few examples, or a genuinely constant
    /// measurement. Scaling by that near-zero spread turns any unseen value on that axis into an
    /// enormous distance and EVERY verdict into "unknown", which reads as a cautious classifier
    /// rather than the arithmetic accident it is.
    #[test]
    fn a_feature_that_never_varies_does_not_swallow_every_verdict() {
        // Modulation is identical in every clip of both classes; flux is what separates them.
        let flat = |class: &str, flux: f32| -> Vec<(String, Features)> {
            (0..6)
                .map(|i| {
                    let t = i as f32 * 0.1;
                    (class.to_string(), feat(0.05 + t * 0.01, 0.400, 8.0 + t, flux + t * 0.01, 1500.0 + t * 100.0))
                })
                .collect()
        };
        let mut set = flat("speech", 0.98);
        set.extend(flat("rain", 0.60));
        let m = train(&set, 3.0).unwrap();
        let i = FEATURE_NAMES.iter().position(|n| *n == "modulation").unwrap();
        assert!(m.scale[i] >= 1.0, "a flat feature falls back to one unit, not to 1e-6");

        // A clip that is plainly speech, differing from the corpus ONLY in the flat feature.
        let v = classify(&feat(0.052, 0.55, 8.3, 0.98, 1540.0), &m);
        assert_eq!(
            v.class.as_deref(),
            Some("speech"),
            "a difference on a feature that never varies must not put the clip out of reach (d={})",
            v.distance
        );
    }

    /// An answer that only just beat another is worth seeing — it is the difference between a
    /// verdict to act on and one to collect more examples for.
    #[test]
    fn the_runner_up_and_its_distance_are_reported() {
        let mut set = corpus("speech", 6, 0.05, 0.99);
        set.extend(corpus("rain", 6, 0.06, 0.60));
        let m = train(&set, 10.0).unwrap();
        let v = classify(&feat(0.05, 0.3, 8.0, 0.99, 1500.0), &m);
        assert_eq!(v.class.as_deref(), Some("speech"));
        let (name, d) = v.runner_up.expect("the loser is named");
        assert_eq!(name, "rain");
        assert!(d >= v.distance, "the runner-up is never nearer than the winner");
    }

    /// The corpus this was built against is real, and so is its trap: six of the twenty-three
    /// segments captured during a speaking session held no voice at all, and were labelled
    /// "speech" because of where they came from. Room tone is a CLASS, not a bad speech example.
    #[test]
    fn room_tone_is_its_own_class_not_a_quiet_kind_of_speech() {
        let mut set = corpus("speech", 6, 0.05, 0.99);
        // Measured from the six silent segments: rms ~0.002, flux ~0.60, no voicing.
        set.extend(corpus("room_tone", 6, 0.002, 0.60));
        let m = train(&set, 3.0).unwrap();
        let silence = feat(0.0018, 0.65, 4.9, 0.574, 1068.0);
        assert_eq!(
            classify(&silence, &m).class.as_deref(),
            Some("room_tone"),
            "labelling silence as speech is what made the first evaluation read 0/7"
        );
    }

}
