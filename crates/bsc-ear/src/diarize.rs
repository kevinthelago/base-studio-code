//! Who spoke WHEN — cluster a recording's speech turns into distinct voices.
//!
//! This is the tractable half of telling voices apart: speakers take turns, so the job is to give
//! each turn a cheap acoustic fingerprint and group the turns whose fingerprints match. It does NOT
//! separate two people talking over each other (that is source separation, a different and harder
//! problem), and it does NOT put names to the clusters (that is enrolment against a known voice).
//! It answers "how many distinct voices, and which turn belongs to which" — nothing more.
//!
//! **Why a hand-built fingerprint rather than a neural speaker embedding, for now.** The eventual
//! best answer is an embedding model (ECAPA-TDNN or similar), and this is deliberately the coarse
//! first pass whose accuracy tells us whether that model is worth its weight. The reason it can work
//! at all is that a single recording has ONE capture chain: the microphone and room are constant
//! across every turn, so the timbre differences between turns are the SPEAKERS, not the equipment.
//! That is exactly the confound `chain.rs` fights across devices, turned into an ally within one
//! recording — and it is why this module refuses to compare fingerprints from two different files.
//!
//! **What a voiceprint is made of**, cheapest-and-strongest first:
//! - **pitch** (median voiced f0): the single best cheap speaker cue — it tracks vocal-fold size, so
//!   it separates most people, and separates the sexes almost always. Useless on a turn with no
//!   voiced speech, which is why a print carries how much of it was voiced at all.
//! - **a spectral envelope** (log energy in log-spaced bands, levelled to its own mean): the SHAPE of
//!   the spectrum stands in for timbre — where a voice puts its energy. Levelled to its own mean so
//!   it describes colour, not loudness; loudness is distance from the mic, which is not the speaker.
//! - **zero-crossing rate**: a near-free proxy for spectral tilt, so a breathy voice and a bright one
//!   separate even at the same pitch.
//!
//! Everything here is pure: samples in, labels out, no microphone and no model.

use serde::{Deserialize, Serialize};

/// The spectral envelope resolution — energy summed into this many log-spaced bands from
/// [`ENVELOPE_LO_HZ`] to [`ENVELOPE_HI_HZ`]. Eight is enough to describe the coarse colour of a
/// voice without turning the print into a per-phoneme spectrum that changes with every word.
pub const ENVELOPE_BANDS: usize = 8;
const ENVELOPE_LO_HZ: f32 = 100.0;
const ENVELOPE_HI_HZ: f32 = 6000.0;
/// The FFT window for the envelope. Reuses the same size the liveness probe uses so there is one
/// analysis window in the crate, not two that can drift.
const FFT_WINDOW: usize = crate::liveness::WINDOW;

/// A turn's acoustic fingerprint. Everything a cluster is decided from, kept inspectable rather than
/// folded into one opaque vector — the same discipline `prosody::Prosody` keeps, and for the same
/// reason: a number nobody can take apart is a black box.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Voiceprint {
    /// Median voiced pitch in Hz, or `None` when the turn had too little voiced speech to trust.
    pub f0: Option<f32>,
    /// Spread of voiced pitch (interquartile range, Hz) — a monotone and an animated speaker differ
    /// here even at the same median.
    pub f0_spread: f32,
    /// Log spectral envelope, levelled to its own mean, length [`ENVELOPE_BANDS`]. The shape, not
    /// the level.
    pub envelope: Vec<f32>,
    /// Mean zero-crossing rate — a cheap stand-in for how bright the voice is.
    pub zcr: f32,
    /// Fraction of frames that were voiced. A low value means the pitch is barely evidenced and the
    /// print should be leaned on lightly — carried so a caller can say "too unvoiced to place".
    pub voiced_fraction: f32,
    /// How long the turn was. A very short turn makes a noisy print.
    pub seconds: f32,
}

/// Below this voiced fraction a turn has no usable pitch, so its print rests on timbre alone.
pub const MIN_VOICED_FRACTION: f32 = 0.10;

/// A turn shorter than this makes a fingerprint too noisy to place, and is reported unplaced rather
/// than assigned to whichever cluster it happened to land nearest.
pub const MIN_TURN_SECONDS: f32 = 0.40;

/// Fingerprint one speech turn.
pub fn voiceprint(samples: &[f32], sample_rate: u32) -> Voiceprint {
    let seconds = samples.len() as f32 / sample_rate.max(1) as f32;
    let frames = crate::prosody::frames(samples, sample_rate);

    let voiced: Vec<f32> = frames.iter().filter_map(|f| f.f0).collect();
    let voiced_fraction =
        if frames.is_empty() { 0.0 } else { voiced.len() as f32 / frames.len() as f32 };
    let (f0, f0_spread) = if voiced_fraction >= MIN_VOICED_FRACTION {
        let mut v = voiced.clone();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let q = |p: f32| v[((v.len() - 1) as f32 * p).round() as usize];
        (Some(q(0.5)), q(0.75) - q(0.25))
    } else {
        (None, 0.0)
    };

    let zcr = if frames.is_empty() {
        0.0
    } else {
        frames.iter().map(|f| f.zcr).sum::<f32>() / frames.len() as f32
    };

    Voiceprint { f0, f0_spread, envelope: envelope(samples, sample_rate), zcr, voiced_fraction, seconds }
}

/// The log spectral envelope, levelled to its own mean.
///
/// Log-spaced bands because hearing and vocal timbre are roughly logarithmic in frequency, and
/// log-scaled energy because a linear scale would let the one loudest band dominate the shape.
/// Subtracting the mean is what turns an absolute spectrum into a SHAPE: two utterances of the same
/// voice at different distances from the mic share a shape but not a level.
fn envelope(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let mut acc = [0.0f32; ENVELOPE_BANDS];
    let mut windows = 0u32;
    let mut at = 0usize;
    // Band i covers [lo * r^i, lo * r^(i+1)) — geometric, so each band is the same musical width.
    let ratio = (ENVELOPE_HI_HZ / ENVELOPE_LO_HZ).powf(1.0 / ENVELOPE_BANDS as f32);
    let edges: Vec<f32> = (0..=ENVELOPE_BANDS).map(|i| ENVELOPE_LO_HZ * ratio.powi(i as i32)).collect();
    while at + FFT_WINDOW <= samples.len() {
        let frame = &samples[at..at + FFT_WINDOW];
        for i in 0..ENVELOPE_BANDS {
            acc[i] += crate::liveness::band_energy(frame, sample_rate, (edges[i], edges[i + 1]));
        }
        windows += 1;
        at += FFT_WINDOW;
    }
    if windows == 0 {
        return vec![0.0; ENVELOPE_BANDS];
    }
    // Log power, then level to the mean so what remains is the shape.
    let logged: Vec<f32> = acc.iter().map(|e| (e / windows as f32 + 1e-9).log10()).collect();
    let mean = logged.iter().sum::<f32>() / ENVELOPE_BANDS as f32;
    logged.iter().map(|l| l - mean).collect()
}

/// How far apart two voiceprints are, scaled so no one cue dominates by its raw units.
///
/// Pitch is compared in the log domain (an octave is an octave whether at 100 or 200 Hz) and only
/// when BOTH turns are voiced — a comparison against a turn with no pitch would be a comparison
/// against zero, which is a fabricated distance. When either is unvoiced the score rests on the
/// envelope and ZCR alone, and says so by weighting what remains up to full.
pub fn distance(a: &Voiceprint, b: &Voiceprint) -> f32 {
    // Envelope: RMS difference across the levelled bands.
    let env: f32 = a
        .envelope
        .iter()
        .zip(&b.envelope)
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f32>()
        .sqrt()
        / ENV_SCALE;
    let zcr = ((a.zcr - b.zcr).abs()) / ZCR_SCALE;

    match (a.f0, b.f0) {
        (Some(fa), Some(fb)) => {
            let pitch = (fa.max(1.0).log2() - fb.max(1.0).log2()).abs() / PITCH_OCTAVE_SCALE;
            // Weighted so pitch and timbre both carry real weight; a big gap on either is enough.
            W_PITCH * pitch + W_ENV * env + W_ZCR * zcr
        }
        // No shared pitch: spend pitch's weight on the cues that ARE measurable, rather than
        // pretending the turns match on a dimension neither could report.
        _ => (W_ENV + W_PITCH * 0.5) * env + (W_ZCR + W_PITCH * 0.5) * zcr,
    }
}

// Per-cue scales (roughly one "typical between-speaker step" each) and weights. Placeholders tuned
// against real recordings, not first principles — the threshold below is where the real tuning
// lives, and these only set the shape of the space it measures in.
const PITCH_OCTAVE_SCALE: f32 = 0.5; // half an octave is a large pitch gap between speakers
const ENV_SCALE: f32 = 2.0;
const ZCR_SCALE: f32 = 0.05;
const W_PITCH: f32 = 1.0;
const W_ENV: f32 = 1.0;
const W_ZCR: f32 = 0.3;

/// Turns closer than this scaled distance are the same speaker. Explicit placeholder: it is the one
/// knob that decides how readily two turns are called one voice, and the honest way to set it is to
/// measure it against labelled recordings, not to reason it out. Named so the tuning has a home.
pub const SAME_SPEAKER: f32 = 1.0;

/// Cluster turns into speakers, with the number of speakers UNKNOWN.
///
/// Agglomerative, average-linkage: every turn starts as its own speaker, the two nearest clusters
/// merge, and merging stops the moment the nearest two are further apart than `threshold`. Average
/// linkage (the mean distance between all cross-cluster pairs) rather than nearest or farthest,
/// because nearest-linkage chains distinct speakers together through one ambiguous turn and
/// farthest-linkage shatters one speaker who happened to say one word oddly.
///
/// Returns a speaker id per input turn, numbered by first appearance so the labels read in the
/// order the recording introduces its voices. Turns given as `None` (too short or too unvoiced to
/// place) are passed through as `None` and take part in no cluster.
pub fn cluster(prints: &[Option<Voiceprint>], threshold: f32) -> Vec<Option<usize>> {
    // Indices of the turns we will actually cluster.
    let placeable: Vec<usize> = prints
        .iter()
        .enumerate()
        .filter_map(|(i, p)| p.as_ref().map(|_| i))
        .collect();
    if placeable.is_empty() {
        return vec![None; prints.len()];
    }

    // Each cluster is a set of placeable-turn indices. Start one per turn.
    let mut clusters: Vec<Vec<usize>> = placeable.iter().map(|&i| vec![i]).collect();
    let dist = |i: usize, j: usize| distance(prints[i].as_ref().unwrap(), prints[j].as_ref().unwrap());

    loop {
        if clusters.len() < 2 {
            break;
        }
        // Find the closest pair of clusters by average linkage.
        let mut best = (f32::INFINITY, 0usize, 0usize);
        for a in 0..clusters.len() {
            for b in a + 1..clusters.len() {
                let mut sum = 0.0f32;
                for &i in &clusters[a] {
                    for &j in &clusters[b] {
                        sum += dist(i, j);
                    }
                }
                let avg = sum / (clusters[a].len() * clusters[b].len()) as f32;
                if avg < best.0 {
                    best = (avg, a, b);
                }
            }
        }
        if best.0 > threshold {
            break;
        }
        // Merge b into a, drop b.
        let (_, a, b) = best;
        let moved = std::mem::take(&mut clusters[b]);
        clusters[a].extend(moved);
        clusters.remove(b);
    }

    // Assign ids by first appearance in the original turn order.
    let mut speaker_of = vec![None; prints.len()];
    let mut order: Vec<(usize, usize)> = Vec::new(); // (earliest turn index, cluster index)
    for (ci, members) in clusters.iter().enumerate() {
        let earliest = *members.iter().min().unwrap();
        order.push((earliest, ci));
    }
    order.sort();
    for (label, (_, ci)) in order.into_iter().enumerate() {
        for &turn in &clusters[ci] {
            speaker_of[turn] = Some(label);
        }
    }
    speaker_of
}

/// How confidently a turn was placed: the margin between its own cluster's distance and the nearest
/// OTHER cluster. A large margin is a turn that clearly belongs where it landed; a small one is a
/// turn that could have gone either way, which is exactly what a reviewer should see rather than a
/// bare label. Returns `None` for an unplaced turn or when there is only one speaker to compare to.
pub fn placement_margin(
    turn: usize,
    prints: &[Option<Voiceprint>],
    labels: &[Option<usize>],
) -> Option<f32> {
    let me = labels.get(turn).copied().flatten()?;
    let mine = prints[turn].as_ref()?;
    let mut own = f32::INFINITY;
    let mut other = f32::INFINITY;
    for (i, (p, l)) in prints.iter().zip(labels).enumerate() {
        if i == turn {
            continue;
        }
        let (Some(p), Some(l)) = (p.as_ref(), *l) else { continue };
        let d = distance(mine, p);
        if l == me {
            own = own.min(d);
        } else {
            other = other.min(d);
        }
    }
    if other.is_infinite() {
        return None; // only one speaker
    }
    // Positive margin = nearer to own cluster than to any other, which is the healthy case.
    Some(other - if own.is_infinite() { 0.0 } else { own })
}

/// One transcribed phrase, attributed to a speaker.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct AttributedPhrase {
    pub start_ms: u64,
    pub end_ms: u64,
    /// The speaker whose turn this phrase overlaps most, or `None` when it overlaps no turn — a
    /// phrase whisper found in a stretch the voice detector called silence, which happens and is
    /// worth showing as unattributed rather than pinned to whoever spoke nearest.
    pub speaker: Option<usize>,
    pub text: String,
}

/// Stitch a transcript onto diarized turns: give each phrase the speaker it overlaps most in time.
///
/// The two share one clock — milliseconds from the start of the file — so alignment is just
/// overlap. A phrase can straddle a speaker change; it is attributed to whichever turn it shares
/// the most time with, because a phrase belongs to whoever said most of it. Overlap of zero means
/// the phrase fell in a gap between turns (whisper heard something the segmenter did not open a turn
/// for), and that is reported as `None` rather than snapped to the nearest turn — a guessed speaker
/// on a phrase that matched no one is exactly the confident-but-wrong answer to avoid.
///
/// `turns` is `(start_ms, end_ms, speaker)`; an unplaced turn carries `None` and can still win the
/// overlap, marking the phrase unattributed for an honest reason rather than by a gap.
pub fn attribute(
    phrases: &[crate::transcribe::TimedPhrase],
    turns: &[(u64, u64, Option<usize>)],
) -> Vec<AttributedPhrase> {
    phrases
        .iter()
        .map(|(pf, pt, text)| {
            let mut best_overlap = 0u64;
            let mut speaker = None;
            for &(ts, te, spk) in turns {
                let overlap = (*pt).min(te).saturating_sub((*pf).max(ts));
                if overlap > best_overlap {
                    best_overlap = overlap;
                    speaker = spk;
                }
            }
            AttributedPhrase { start_ms: *pf, end_ms: *pt, speaker, text: text.clone() }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const SR: u32 = 16000;

    /// A synthetic voice: a buzz at a fundamental with a few harmonics, shaped so its energy sits in
    /// a chosen band — a crude but honest stand-in for pitch + timbre. `bright` tilts energy upward.
    fn voice(f0: f32, seconds: f32, bright: bool) -> Vec<f32> {
        let n = (SR as f32 * seconds) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let mut s = 0.0f32;
                // Harmonics; a bright voice keeps the high ones strong, a dark one rolls them off.
                for h in 1..=6 {
                    let amp = if bright { 1.0 / h as f32 } else { 1.0 / (h * h) as f32 };
                    s += amp * (2.0 * PI * f0 * h as f32 * t).sin();
                }
                s * 0.2
            })
            .collect()
    }

    fn print_of(f0: f32, seconds: f32, bright: bool) -> Option<Voiceprint> {
        Some(voiceprint(&voice(f0, seconds, bright), SR))
    }

    /// The core promise: two clearly different voices land in two clusters, the same voice in one —
    /// WITHOUT being told there are two. Three turns of a low voice and three of a high one.
    #[test]
    fn two_distinct_voices_become_two_speakers_and_one_voice_stays_one() {
        let low = [print_of(110.0, 1.5, false), print_of(112.0, 1.4, false), print_of(108.0, 1.6, false)];
        let high = [print_of(220.0, 1.5, true), print_of(224.0, 1.4, true), print_of(216.0, 1.6, true)];

        let one_voice = low.to_vec();
        let labels = cluster(&one_voice, SAME_SPEAKER);
        let distinct: std::collections::BTreeSet<_> = labels.iter().flatten().collect();
        assert_eq!(distinct.len(), 1, "three turns of one voice must be one speaker: {labels:?}");

        let mut two = low.to_vec();
        two.extend(high.iter().cloned());
        let labels = cluster(&two, SAME_SPEAKER);
        let distinct: std::collections::BTreeSet<_> = labels.iter().flatten().collect();
        assert_eq!(distinct.len(), 2, "two clearly different voices must be two speakers: {labels:?}");
        // The three low turns share a label, and it differs from the high turns'.
        assert_eq!(labels[0], labels[1]);
        assert_eq!(labels[1], labels[2]);
        assert_ne!(labels[0], labels[3]);
    }

    /// Speakers are numbered by when the recording first hears them, so the labels read in order.
    #[test]
    fn speakers_are_numbered_by_first_appearance() {
        let turns = vec![
            print_of(110.0, 1.5, false), // speaker 0 enters first
            print_of(230.0, 1.5, true),  // speaker 1 enters second
            print_of(112.0, 1.5, false), // speaker 0 again
        ];
        let labels = cluster(&turns, SAME_SPEAKER);
        assert_eq!(labels[0], Some(0));
        assert_eq!(labels[1], Some(1));
        assert_eq!(labels[2], Some(0), "the returning first voice keeps id 0");
    }

    /// The threshold is the whole policy, so it must be PROVEN to bite: the identical pair of voices
    /// collapses to one speaker when the threshold is loose enough, and splits every turn into its
    /// own when it is tight enough. A clustering that ignored the threshold would fail both ends.
    #[test]
    fn the_threshold_decides_and_is_proven_to() {
        let mut turns = vec![print_of(110.0, 1.5, false), print_of(112.0, 1.5, false)];
        turns.extend([print_of(220.0, 1.5, true), print_of(224.0, 1.5, true)]);

        let collapsed = cluster(&turns, 1000.0);
        assert_eq!(
            collapsed.iter().flatten().collect::<std::collections::BTreeSet<_>>().len(),
            1,
            "a loose enough threshold calls everything one speaker"
        );
        let shattered = cluster(&turns, 0.0);
        assert_eq!(
            shattered.iter().flatten().collect::<std::collections::BTreeSet<_>>().len(),
            4,
            "a tight enough threshold refuses to merge anything"
        );
    }

    /// A turn too short or too unvoiced to fingerprint is passed through unplaced, never forced into
    /// whichever speaker it landed nearest — a guessed label is worse than an honest gap.
    #[test]
    fn an_unplaceable_turn_is_not_forced_into_a_speaker() {
        let turns = vec![print_of(110.0, 1.5, false), None, print_of(114.0, 1.5, false)];
        let labels = cluster(&turns, SAME_SPEAKER);
        assert_eq!(labels[1], None, "the unplaced turn stays unplaced");
        assert_eq!(labels[0], labels[2], "the real turns still cluster past the gap");
        assert!(cluster(&[None, None], SAME_SPEAKER).iter().all(|l| l.is_none()));
    }

    /// A voiceprint with too little voiced speech reports no pitch rather than a pitch read off
    /// noise — the distance function then leans on timbre, which is the correct degradation.
    #[test]
    fn a_turn_without_voicing_has_no_pitch_and_still_compares() {
        let noise: Vec<f32> = (0..SR).map(|i| ((i * 7 % 13) as f32 / 13.0 - 0.5) * 0.02).collect();
        let vp = voiceprint(&noise, SR);
        assert!(vp.f0.is_none(), "unvoiced noise must not report a pitch: {:?}", vp.f0);
        // It still yields a finite distance to a real voice — timbre alone.
        let voiced = voiceprint(&voice(120.0, 1.0, false), SR);
        assert!(distance(&vp, &voiced).is_finite());
    }

    /// A confidently placed turn shows a positive margin to the nearest other speaker; the margin is
    /// what a reviewer reads instead of trusting a bare label.
    #[test]
    fn placement_margin_is_positive_for_a_clear_turn() {
        let mut turns = vec![print_of(110.0, 1.5, false), print_of(112.0, 1.5, false)];
        turns.extend([print_of(230.0, 1.5, true), print_of(226.0, 1.5, true)]);
        let labels = cluster(&turns, SAME_SPEAKER);
        let m = placement_margin(0, &turns, &labels).expect("two speakers, so a margin exists");
        assert!(m > 0.0, "a clear turn is nearer its own cluster than the other: margin {m}");
    }

    fn phrase(from: u64, to: u64, text: &str) -> crate::transcribe::TimedPhrase {
        (from, to, text.to_string())
    }

    /// The core of the feature: each phrase gets the speaker whose turn it sits inside.
    #[test]
    fn a_phrase_is_attributed_to_the_turn_it_sits_in() {
        let turns = vec![(0, 3000, Some(0)), (3000, 6000, Some(1))];
        let phrases = vec![phrase(200, 2500, "we're not taking kittens"), phrase(3200, 5800, "why can't you keep them")];
        let out = attribute(&phrases, &turns);
        assert_eq!(out[0].speaker, Some(0));
        assert_eq!(out[1].speaker, Some(1));
        assert_eq!(out[0].text, "we're not taking kittens");
    }

    /// A phrase that straddles a speaker change goes to whoever said MOST of it — a phrase belongs
    /// to the person who spoke the majority of its span, not to whichever turn started first.
    #[test]
    fn a_straddling_phrase_goes_to_the_dominant_speaker() {
        let turns = vec![(0, 1000, Some(0)), (1000, 5000, Some(1))];
        // 800ms in speaker 0, 3000ms in speaker 1.
        let out = attribute(&[phrase(200, 4000, "…")], &turns);
        assert_eq!(out[0].speaker, Some(1), "the majority speaker wins the straddle");
    }

    /// A phrase whisper found in a stretch the segmenter never opened a turn for overlaps nobody,
    /// and is reported unattributed rather than snapped to the nearest voice.
    #[test]
    fn a_phrase_in_a_turn_gap_is_unattributed_not_guessed() {
        let turns = vec![(0, 1000, Some(0)), (8000, 9000, Some(1))];
        let out = attribute(&[phrase(3000, 4000, "a cough between turns")], &turns);
        assert_eq!(out[0].speaker, None, "no overlap means no speaker, not the nearest one");
    }
}
