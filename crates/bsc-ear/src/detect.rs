//! What the ear heard, as an INCIDENT — the safety half.
//!
//! This is the ear's `detection_from`: the same shape `src-tauri/src/lan/subscribe.rs` uses for the
//! network sensors, so an audio event joins the ledger that already coalesces, tracks severity,
//! honours silences and decides ONCE whether to notify. An incident is an incident whatever sensed
//! it, and that discipline — a burst is one alarm, not sixty — is exactly what a fall detector
//! needs to stay trusted.
//!
//! ## It does NOT sit downstream of the speech gate
//!
//! MEASURED 2026-09-06: 724 of 785 captured segments were discarded as voiceless, because the
//! segmenter hunts SPEECH. A fall is a thud and perhaps a quiet moan — precisely what that filter
//! throws away. So this reads acoustic features directly and can raise an [`Kind::Impact`] from a
//! segment with no voice in it at all.
//!
//! ## The thresholds here are PROVISIONAL and the item says so
//!
//! Every constant below is named, with its reason beside it, and pinned by a test at its boundary.
//! None of them is calibrated, because calibrating them needs a corpus of staged events that does
//! not exist yet. Until that corpus exists this detector is OBSERVE-ONLY: it says what it would
//! have raised and notifies nothing. An alarm tuned on no corpus is worse than no alarm, because
//! somebody would be relying on it.
//!
//! ## What it refuses to claim
//!
//! The kind is [`Kind::Impact`], never `Fall`. The ear can hear an impact; it cannot know a body
//! made it. A kind that claims more than the sensor measured would put that claim on a lock screen
//! at 3am, and a false "fall detected" is how a system stops being believed.

use crate::classify::{Features, Verdict};
use crate::prosody::Arousal;
use bsc_incident::{Detection, Evidence, Kind, Severity};

/// Peak-over-RMS above which a sound is impulsive rather than sustained.
///
/// A fall, a slam and a collision put nearly all their energy in a few milliseconds; a fan, a
/// voice or a washing machine do not. A keystroke is impulsive too, which is why this is paired
/// with [`IMPACT_RMS`] — the discriminator is loud AND sharp, not either alone.
pub const IMPACT_CREST: f32 = 6.0;

/// Level above which an impulsive sound is worth raising at all.
///
/// Room tone in the measured profile sits near 0.001–0.01 RMS and ordinary speech near 0.02–0.05.
/// This sits above conversational level so a closing drawer or a keystroke does not qualify.
pub const IMPACT_RMS: f32 = 0.08;

/// Level at which an impact stops being "worth a look" and becomes "look now".
pub const IMPACT_RMS_CRITICAL: f32 = 0.25;

/// Longest an impact can be. An impulse is over quickly; a sustained loud noise is a vacuum
/// cleaner, a passing lorry or music, and those are not events.
pub const IMPACT_MAX_SECONDS: f32 = 2.0;

/// Arousal, in standard deviations above THIS speaker's own habit, at which a raised voice becomes
/// a distress signal.
///
/// Per-speaker on purpose: a quiet person's most alarmed voice may never reach a loud person's
/// resting level, and a per-speaker baseline is also the only thing immune to preamp gain.
pub const DISTRESS_AROUSAL_Z: f32 = 2.5;

/// Envelope modulation above which a segment is speech-shaped — energy fluctuating at syllable
/// rate. Used so a distress judgement is only made about something voice-like.
pub const SPEECH_MODULATION: f32 = 0.25;

/// Everything the ear measured about one segment, as the detector sees it.
///
/// Every optional field is optional because the ear may genuinely not know, and NOT KNOWING IS NOT
/// THE SAME AS FALSE. `live: None` means liveness is uncalibrated on this device — which it is
/// today, on every segment measured — and the rules below refuse to raise a stranger-in-the-house
/// alarm on that, because a detector that cannot tell a television from a person is the one that
/// gets switched off.
#[derive(Debug, Clone, Copy)]
pub struct Observed<'a> {
    pub features: &'a Features,
    /// What `classify` made of it. An UNKNOWN verdict (`class: None`) is a first-class input, not a
    /// fallback: the ten trained classes are car_horn, birds, clock_tick, engine, keyboard, rain,
    /// room_tone, speech, vacuum and washing machine, so the events worth alarming on are exactly
    /// the ones it cannot name.
    pub verdict: &'a Verdict,
    /// `None` when there is no usable baseline for this speaker yet.
    pub arousal: Option<&'a Arousal>,
    /// `Some(true)` when the imprint recognises the enrolled person, `Some(false)` when it is
    /// confidently someone else, `None` when no imprint is enrolled.
    pub known_speaker: Option<bool>,
    /// `Some(true)` for a live voice in the room, `Some(false)` for playback, `None` when liveness
    /// has not been calibrated on this device.
    pub live: Option<bool>,
    /// Which ear heard it — the coalescing scope.
    pub source: &'a str,
    pub at_ms: i64,
}

/// Whether a segment looks like speech, from its own shape rather than from a transcript.
pub fn is_speech_shaped(o: &Observed) -> bool {
    o.verdict.class.as_deref() == Some("speech") || o.features.modulation >= SPEECH_MODULATION
}

/// Whether a segment is a loud, short, impulsive sound.
pub fn is_impact(o: &Observed) -> bool {
    o.features.crest >= IMPACT_CREST
        && o.features.rms >= IMPACT_RMS
        && o.features.seconds <= IMPACT_MAX_SECONDS
}

/// The one decision this module makes: does what the ear heard deserve an incident?
///
/// PURE — no clock, no I/O, no model. `at_ms` is an argument, which is what lets every rule below
/// be answered from constructed values with no microphone.
///
/// Precedence is by consequence, not by confidence: an impact outranks a raised voice, which
/// outranks an unfamiliar one. Somebody on the floor matters more than somebody shouting, and only
/// one incident is raised per segment so a single event cannot become three alarms.
pub fn detection_from(o: &Observed) -> Option<Detection> {
    if is_impact(o) {
        let sev = if o.features.rms >= IMPACT_RMS_CRITICAL { Severity::Critical } else { Severity::High };
        return Some(Detection {
            kind: Kind::Impact,
            // One place, one incident: a flurry of thuds coalesces rather than paging repeatedly.
            key: format!("impact:{}", o.source),
            severity: sev,
            source: o.source.to_string(),
            at_ms: o.at_ms,
            evidence: Evidence::line(format!(
                "impulsive sound — crest {:.1}, level {:.3}, {:.1}s{}",
                o.features.crest,
                o.features.rms,
                o.features.seconds,
                match o.verdict.class.as_deref() {
                    Some(c) => format!(", nearest known sound '{c}'"),
                    // Worth saying out loud: matching nothing the ear knows is a REASON to look.
                    None => ", matching nothing the ear knows".to_string(),
                }
            )),
        });
    }

    if is_speech_shaped(o) {
        // A score whose baseline is too thin is a number pretending to be a measurement, so an
        // unready arousal raises nothing rather than raising something uncertain.
        if let Some(a) = o.arousal.filter(|a| a.grounded && a.score >= DISTRESS_AROUSAL_Z) {
            return Some(Detection {
                kind: Kind::Distress,
                key: format!("distress:{}", o.source),
                severity: Severity::High,
                source: o.source.to_string(),
                at_ms: o.at_ms,
                evidence: Evidence::line(format!(
                    "voice raised {:.1} sd above this speaker's own habit (pitch {:+.1}, loudness {:+.1}, effort {:+.1})",
                    a.score, a.z_pitch, a.z_loudness, a.z_effort
                )),
            });
        }

        // A stranger's voice is only an event if it is IN THE ROOM. `live: None` — which is every
        // segment measured on this machine today, because liveness is uncalibrated — refuses,
        // rather than alarming on the television.
        if o.live == Some(true) && o.known_speaker == Some(false) {
            return Some(Detection {
                kind: Kind::UnknownVoice,
                key: format!("unknown-voice:{}", o.source),
                severity: Severity::Medium,
                source: o.source.to_string(),
                at_ms: o.at_ms,
                evidence: Evidence::line(
                    "live speech from a voice the imprint does not recognise".to_string(),
                ),
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feats(rms: f32, crest: f32, modulation: f32, seconds: f32) -> Features {
        Features { rms, modulation, crest, flux: 0.1, centroid: 1000.0, fundamental_ratio: 1.0, seconds }
    }
    fn known(class: &str) -> Verdict {
        Verdict { class: Some(class.into()), distance: 0.2, runner_up: None }
    }
    fn unknown() -> Verdict {
        Verdict { class: None, distance: 9.0, runner_up: None }
    }
    fn arousal(score: f32, grounded: bool) -> Arousal {
        Arousal { score, z_pitch: 1.0, z_pitch_range: 1.0, z_loudness: 1.0,
                  z_variability: 1.0, z_effort: 1.0, z_rate: 1.0, grounded }
    }
    fn obs<'a>(f: &'a Features, v: &'a Verdict) -> Observed<'a> {
        Observed { features: f, verdict: v, arousal: None, known_speaker: None, live: None,
                   source: "kitchen", at_ms: 1_000 }
    }

    // ── impact ────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn an_impact_is_raised_from_a_segment_with_no_voice_in_it() {
        // THE POINT OF THIS MODULE. 724 of 785 real segments were discarded as voiceless because
        // the segmenter hunts speech — and a fall is a thud. If this ever regresses to requiring
        // speech, the detector stops being able to hear the event it exists for.
        let f = feats(0.30, 9.0, 0.02, 0.4);   // loud, sharp, no syllable modulation at all
        let v = unknown();
        let d = detection_from(&obs(&f, &v)).expect("a loud impulsive sound must raise something");
        assert_eq!(d.kind, Kind::Impact);
        assert!(!is_speech_shaped(&obs(&f, &v)), "the fixture must genuinely not be speech-shaped");
    }

    #[test]
    fn each_impact_threshold_is_pinned_at_its_boundary() {
        let v = unknown();
        // crest: at the boundary fires, a hair under does not
        let at = feats(0.30, IMPACT_CREST, 0.02, 0.4);
        let under = feats(0.30, IMPACT_CREST - 0.01, 0.02, 0.4);
        assert!(detection_from(&obs(&at, &v)).is_some(), "crest at the boundary must fire");
        assert!(detection_from(&obs(&under, &v)).is_none(), "crest below the boundary must not");
        // level
        let at = feats(IMPACT_RMS, 9.0, 0.02, 0.4);
        let under = feats(IMPACT_RMS - 0.001, 9.0, 0.02, 0.4);
        assert!(detection_from(&obs(&at, &v)).is_some(), "level at the boundary must fire");
        assert!(detection_from(&obs(&under, &v)).is_none(), "level below the boundary must not");
        // duration: an impulse is short; a sustained loud noise is a vacuum, not an event
        let at = feats(0.30, 9.0, 0.02, IMPACT_MAX_SECONDS);
        let over = feats(0.30, 9.0, 0.02, IMPACT_MAX_SECONDS + 0.01);
        assert!(detection_from(&obs(&at, &v)).is_some(), "duration at the boundary must fire");
        assert!(detection_from(&obs(&over, &v)).is_none(), "a sustained loud sound is not an impact");
    }

    #[test]
    fn a_louder_impact_escalates_to_critical() {
        let v = unknown();
        let loud = feats(IMPACT_RMS_CRITICAL, 9.0, 0.02, 0.4);
        let quieter = feats(IMPACT_RMS_CRITICAL - 0.001, 9.0, 0.02, 0.4);
        assert_eq!(detection_from(&obs(&loud, &v)).unwrap().severity, Severity::Critical);
        assert_eq!(detection_from(&obs(&quieter, &v)).unwrap().severity, Severity::High);
    }

    #[test]
    fn an_unrecognised_sound_says_so_in_the_evidence() {
        // The ten trained classes name none of the events worth alarming on, so "matching nothing
        // the ear knows" is a REASON to look, not an absence to hide.
        let f = feats(0.30, 9.0, 0.02, 0.4);
        let d = detection_from(&obs(&f, &unknown())).unwrap();
        assert!(d.evidence.summary.contains("matching nothing"), "{}", d.evidence.summary);
        let d = detection_from(&obs(&f, &known("washing_machine"))).unwrap();
        assert!(d.evidence.summary.contains("washing_machine"), "{}", d.evidence.summary);
    }

    // ── distress ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn distress_needs_both_speech_and_arousal_above_this_speakers_own_habit() {
        let f = feats(0.04, 2.0, 0.6, 3.0);   // speech-shaped, ordinary level
        let v = known("speech");
        let hot = arousal(DISTRESS_AROUSAL_Z, true);
        let mild = arousal(DISTRESS_AROUSAL_Z - 0.01, true);
        let mut o = obs(&f, &v); o.arousal = Some(&hot);
        assert_eq!(detection_from(&o).unwrap().kind, Kind::Distress);
        o.arousal = Some(&mild);
        assert!(detection_from(&o).is_none(), "just below the threshold must raise nothing");
    }

    #[test]
    fn an_ungrounded_arousal_raises_nothing() {
        // A score without a baseline is a number pretending to be a measurement.
        let f = feats(0.04, 2.0, 0.6, 3.0);
        let v = known("speech");
        let hot_but_baseless = arousal(9.0, false);
        let mut o = obs(&f, &v); o.arousal = Some(&hot_but_baseless);
        assert!(detection_from(&o).is_none(), "no baseline means no claim, however large the score");
    }

    // ── unknown voice ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn an_unfamiliar_voice_is_refused_while_liveness_is_uncalibrated() {
        // THE MEASURED RISK. `live` is None on every segment recorded on this machine, because
        // liveness has never been calibrated. Firing on that would alarm at the television, and an
        // alarm that cannot tell a television from a person is one that gets switched off.
        let f = feats(0.04, 2.0, 0.6, 3.0);
        let v = known("speech");
        let mut o = obs(&f, &v);
        o.known_speaker = Some(false);
        o.live = None;
        assert!(detection_from(&o).is_none(), "uncalibrated liveness must refuse, not guess");
        o.live = Some(false);
        assert!(detection_from(&o).is_none(), "a television is not an intruder");
        o.live = Some(true);
        assert_eq!(detection_from(&o).unwrap().kind, Kind::UnknownVoice);
    }

    #[test]
    fn a_recognised_voice_raises_nothing() {
        let f = feats(0.04, 2.0, 0.6, 3.0);
        let v = known("speech");
        let mut o = obs(&f, &v);
        o.live = Some(true);
        o.known_speaker = Some(true);
        assert!(detection_from(&o).is_none());
        o.known_speaker = None;   // nobody enrolled — not the same as a stranger
        assert!(detection_from(&o).is_none(), "no imprint means no claim about who spoke");
    }

    // ── the ledger's contract ─────────────────────────────────────────────────────────────────

    #[test]
    fn precedence_is_by_consequence_and_one_segment_raises_at_most_one_incident() {
        // A loud impulsive shout is both. Somebody on the floor matters more than somebody
        // shouting, and three alarms for one event is how a ledger loses its meaning.
        let f = feats(0.30, 9.0, 0.6, 0.4);
        let v = known("speech");
        let hot = arousal(9.0, true);
        let mut o = obs(&f, &v);
        o.arousal = Some(&hot); o.live = Some(true); o.known_speaker = Some(false);
        let d = detection_from(&o).expect("must raise");
        assert_eq!(d.kind, Kind::Impact, "an impact outranks a raised voice and a stranger");
    }

    #[test]
    fn the_coalescing_key_is_the_place_so_a_flurry_is_one_incident() {
        let f = feats(0.30, 9.0, 0.02, 0.4);
        let v = unknown();
        let mut a = obs(&f, &v); a.source = "kitchen"; a.at_ms = 1_000;
        let mut b = obs(&f, &v); b.source = "kitchen"; b.at_ms = 4_000;
        let mut c = obs(&f, &v); c.source = "garage";  c.at_ms = 4_000;
        let (ka, kb, kc) = (detection_from(&a).unwrap().key, detection_from(&b).unwrap().key, detection_from(&c).unwrap().key);
        assert_eq!(ka, kb, "two thuds in one place are one incident");
        assert_ne!(ka, kc, "a different place opens its own");
    }

    #[test]
    fn silence_and_ordinary_room_noise_raise_nothing() {
        let v = known("room_tone");
        for (rms, crest, modu, secs) in [(0.001, 1.5, 0.02, 5.0), (0.02, 3.0, 0.5, 4.0), (0.15, 2.0, 0.1, 30.0)] {
            let f = feats(rms, crest, modu, secs);
            assert!(detection_from(&obs(&f, &v)).is_none(), "quiet/sustained audio must raise nothing: {rms} {crest}");
        }
    }
}
