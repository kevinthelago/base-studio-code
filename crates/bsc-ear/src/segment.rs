//! Deciding what is speech — the pure half, over frame energies alone.
//!
//! No microphone, no audio format, no clock: a caller pushes one RMS value per frame and gets back
//! segment boundaries. Everything interesting about an always-on ear is decided here, so everything
//! interesting about it is testable without a room to be quiet in.

use serde::Serialize;

/// A slow-moving estimate of the room's noise floor.
///
/// ABSOLUTE thresholds do not survive contact with a second microphone. Measured on this machine
/// alone there are four capture devices — a USB audio interface, two onboard analog inputs and a
/// headset — whose idle levels differ by more than the gap between "silence" and "speech" on any one
/// of them. So the thresholds are RELATIVE to a floor that is learned continuously.
///
/// It falls fast and rises slowly, which is the whole trick: a room getting quieter is information
/// to adopt immediately, while a rise is usually somebody talking, and a floor that chased speech
/// upward would deafen itself mid-sentence.
#[derive(Clone, Debug)]
pub struct NoiseFloor {
    est: f32,
    fall: f32,
    rise: f32,
    min: f32,
}

impl NoiseFloor {
    /// `min` is the floor's own floor. Without it a digitally-silent input (a muted or unplugged
    /// device, which reads as exact zeros) drives the estimate to 0, and every threshold derived
    /// from it collapses to 0 — at which point the very first non-zero sample is "speech" and the
    /// ear records the room forever.
    pub fn new(min: f32) -> Self {
        NoiseFloor { est: min.max(f32::MIN_POSITIVE), fall: 0.3, rise: 0.01, min: min.max(f32::MIN_POSITIVE) }
    }

    /// Adapt FAST in both directions, for the warm-up window only.
    ///
    /// The ordinary asymmetry cannot bootstrap. The estimate starts at `min`, which is far below any
    /// real room, and the slow rise is deliberately too slow to climb there — so on a cold start
    /// every quiet frame reads as speech, a segment opens, [`Segmenter`] freezes the floor because
    /// it is recording, and the floor never learns the room at all. The ear would record silence
    /// forever, having been told the room was silent.
    pub fn warm(&mut self, rms: f32) -> f32 {
        let rms = if rms.is_finite() { rms.max(0.0) } else { self.est };
        self.est = (self.est + self.fall * (rms - self.est)).max(self.min);
        self.est
    }

    pub fn level(&self) -> f32 {
        self.est
    }

    /// Fold one frame in and return the updated floor.
    pub fn update(&mut self, rms: f32) -> f32 {
        let rms = if rms.is_finite() { rms.max(0.0) } else { self.est };
        let a = if rms < self.est { self.fall } else { self.rise };
        self.est = (self.est + a * (rms - self.est)).max(self.min);
        self.est
    }
}

/// How the segmenter decides. Times are milliseconds; ratios multiply the learned noise floor.
#[derive(Clone, Debug, Serialize)]
pub struct VadConfig {
    pub frame_ms: u32,
    /// Open when a frame exceeds `floor * open_ratio`.
    pub open_ratio: f32,
    /// Close when it falls under `floor * close_ratio`. STRICTLY BELOW `open_ratio` — the gap is
    /// hysteresis, and without it a frame sitting exactly at the threshold chatters the state
    /// machine open and shut once per frame.
    pub close_ratio: f32,
    /// Continuous speech required before a segment actually opens — debounces a cough or a door.
    pub open_ms: u32,
    /// Continuous silence required to close one. A pause between words is not the end of a
    /// sentence, and without hangover every natural gap becomes a segment boundary.
    pub hangover_ms: u32,
    /// Audio kept from BEFORE the trigger. Speech crosses the threshold partway into its first
    /// syllable, so a segment that begins exactly at the trigger reliably loses the first word —
    /// and a transcript missing its first word is worse than no transcript, because it reads as
    /// though the speaker said the rest.
    pub preroll_ms: u32,
    /// Shorter than this and it is discarded as a blip rather than written.
    pub min_segment_ms: u32,
    /// Force-closed here, so a vacuum cleaner cannot produce one unbounded file.
    pub max_segment_ms: u32,
    /// The floor's own floor — see [`NoiseFloor::new`].
    pub floor_min: f32,
    /// How long the ear listens WITHOUT being able to open a segment, learning the room first.
    /// A cold start has no idea how loud the room is, and a detector that can trigger before it
    /// knows will trigger on the room itself. Deaf for a moment, rather than wrong for an hour.
    pub warmup_ms: u32,
}

impl Default for VadConfig {
    fn default() -> Self {
        VadConfig {
            frame_ms: 20,
            open_ratio: 3.0,
            close_ratio: 1.8,
            open_ms: 120,
            hangover_ms: 700,
            preroll_ms: 300,
            min_segment_ms: 400,
            max_segment_ms: 30_000,
            floor_min: 1e-4,
            warmup_ms: 1_000,
        }
    }
}

impl VadConfig {
    /// Refuse a configuration that cannot behave, rather than behaving strangely.
    pub fn validate(&self) -> Result<(), String> {
        if self.frame_ms == 0 {
            return Err("frame_ms must be greater than zero".into());
        }
        if self.close_ratio >= self.open_ratio {
            return Err(format!(
                "close_ratio ({}) must be BELOW open_ratio ({}) — without that gap the detector \
                 chatters open and shut on a frame sitting at the threshold",
                self.close_ratio, self.open_ratio
            ));
        }
        if self.max_segment_ms <= self.min_segment_ms {
            return Err("max_segment_ms must exceed min_segment_ms".into());
        }
        Ok(())
    }
}

/// What the segmenter announces. Times are milliseconds since the stream began.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub enum VadEvent {
    /// A segment opened. `at_ms` already has the pre-roll subtracted, so it is the time the caller
    /// should start writing from — never negative.
    Open { at_ms: u64 },
    /// A segment closed and is worth keeping.
    Close { start_ms: u64, end_ms: u64 },
    /// A segment closed and was discarded for being shorter than `min_segment_ms`. Reported rather
    /// than swallowed: a stream producing nothing but discards is a mis-tuned threshold, and
    /// silence about it is indistinguishable from a quiet room.
    Discard { start_ms: u64, end_ms: u64 },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Silent,
    /// Above the open threshold but not yet for long enough.
    Opening { since_ms: u64 },
    /// `start_ms` is where the FILE begins (pre-roll included); `speech_ms` is where speech
    /// actually crossed the threshold. Both are needed and they are not interchangeable — see
    /// [`Segmenter::close`].
    Speaking { start_ms: u64, speech_ms: u64 },
    /// Below the close threshold but inside the hangover — still recording.
    Closing { start_ms: u64, speech_ms: u64, quiet_since_ms: u64 },
}

/// The speech/silence state machine. Push one RMS per frame; take the events it returns.
#[derive(Clone, Debug)]
pub struct Segmenter {
    cfg: VadConfig,
    floor: NoiseFloor,
    state: State,
    elapsed_ms: u64,
}

impl Segmenter {
    pub fn new(cfg: VadConfig) -> Result<Self, String> {
        cfg.validate()?;
        let floor = NoiseFloor::new(cfg.floor_min);
        Ok(Segmenter { cfg, floor, state: State::Silent, elapsed_ms: 0 })
    }

    /// Milliseconds of stream consumed so far.
    pub fn elapsed_ms(&self) -> u64 {
        self.elapsed_ms
    }

    pub fn noise_floor(&self) -> f32 {
        self.floor.level()
    }

    /// Whether the input looks DEAD rather than quiet.
    ///
    /// A real microphone in a silent room still has a self-noise floor — measured on this machine's
    /// onboard input, 0.00235. A device that is muted, unplugged, or routed to nothing produces a
    /// floor pinned at its own clamp. The distinction matters more than it sounds: without it an
    /// always-on ear opened on the wrong device reports LISTENING forever and records nothing, which
    /// is exactly what a quiet room looks like. Measured here: the system default, the Scarlett and
    /// the headset were all silent while only the onboard input was live.
    pub fn input_looks_dead(&self) -> bool {
        !self.is_warming() && self.floor.level() <= self.cfg.floor_min * 1.5
    }

    /// Still learning the room, and unable to open a segment yet.
    pub fn is_warming(&self) -> bool {
        self.elapsed_ms < u64::from(self.cfg.warmup_ms)
    }

    /// Whether a segment is currently being recorded (open, or inside its hangover).
    pub fn is_recording(&self) -> bool {
        matches!(self.state, State::Speaking { .. } | State::Closing { .. })
    }

    /// Push one frame's RMS. Returns an event when a boundary is crossed.
    pub fn push(&mut self, rms: f32) -> Option<VadEvent> {
        let now = self.elapsed_ms;
        self.elapsed_ms += u64::from(self.cfg.frame_ms);

        // The floor only learns while NOT recording. Updating it through a long utterance drags it
        // up toward speech level, and the close threshold rises with it until the segment shuts
        // mid-sentence — the detector talking itself into believing the room got louder.
        // Warm-up: learn fast, and refuse to open anything until the room is known.
        if now < u64::from(self.cfg.warmup_ms) {
            self.floor.warm(rms);
            return None;
        }
        let floor = if self.is_recording() { self.floor.level() } else { self.floor.update(rms) };
        let rms = if rms.is_finite() { rms.max(0.0) } else { 0.0 };
        let open_at = floor * self.cfg.open_ratio;
        let close_at = floor * self.cfg.close_ratio;

        match self.state {
            State::Silent => {
                if rms >= open_at {
                    self.state = State::Opening { since_ms: now };
                }
                None
            }
            State::Opening { since_ms } => {
                if rms < close_at {
                    self.state = State::Silent;
                    return None;
                }
                if now.saturating_sub(since_ms) + u64::from(self.cfg.frame_ms) >= u64::from(self.cfg.open_ms) {
                    let start = since_ms.saturating_sub(u64::from(self.cfg.preroll_ms));
                    self.state = State::Speaking { start_ms: start, speech_ms: since_ms };
                    return Some(VadEvent::Open { at_ms: start });
                }
                None
            }
            State::Speaking { start_ms, speech_ms } => {
                if now.saturating_sub(start_ms) >= u64::from(self.cfg.max_segment_ms) {
                    return Some(self.close(start_ms, speech_ms, now));
                }
                if rms < close_at {
                    self.state = State::Closing { start_ms, speech_ms, quiet_since_ms: now };
                }
                None
            }
            State::Closing { start_ms, speech_ms, quiet_since_ms } => {
                if rms >= open_at {
                    // A pause, not an ending. Back to speaking with the SAME start.
                    self.state = State::Speaking { start_ms, speech_ms };
                    return None;
                }
                if now.saturating_sub(start_ms) >= u64::from(self.cfg.max_segment_ms)
                    || now.saturating_sub(quiet_since_ms) >= u64::from(self.cfg.hangover_ms)
                {
                    // End at the moment it went quiet, not at the end of the hangover — the
                    // hangover is how long we WAIT to be sure, not audio anyone wants to keep.
                    return Some(self.close(start_ms, speech_ms, quiet_since_ms));
                }
                None
            }
        }
    }

    /// End of stream: close whatever is open, so shutting the ear down does not silently drop the
    /// sentence in progress.
    pub fn finish(&mut self) -> Option<VadEvent> {
        match self.state {
            State::Speaking { start_ms, speech_ms } | State::Closing { start_ms, speech_ms, .. } => {
                let end = self.elapsed_ms;
                Some(self.close(start_ms, speech_ms, end))
            }
            State::Silent | State::Opening { .. } => {
                self.state = State::Silent;
                None
            }
        }
    }

    /// Close a segment, judging it by its SPEECH and reporting it by its FILE.
    ///
    /// The two differ by the pre-roll, and conflating them makes `min_segment_ms` a lie: with a
    /// 300 ms pre-roll a 200 ms cough measures 500 ms and is kept as though someone had spoken for
    /// half a second. What decides whether this was a thought or a noise is how long the speech
    /// lasted; what gets written is the speech plus its run-up.
    fn close(&mut self, start_ms: u64, speech_ms: u64, end_ms: u64) -> VadEvent {
        self.state = State::Silent;
        let end_ms = end_ms.max(start_ms);
        let spoken = end_ms.saturating_sub(speech_ms.max(start_ms));
        if spoken < u64::from(self.cfg.min_segment_ms) {
            VadEvent::Discard { start_ms, end_ms }
        } else {
            VadEvent::Close { start_ms, end_ms }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A quiet room, in the units the floor learns: well above `floor_min` so the test exercises a
    /// learned floor rather than the clamp.
    const QUIET: f32 = 0.004;
    /// Comfortably over `QUIET * open_ratio`.
    const LOUD: f32 = 0.08;

    fn seg() -> Segmenter {
        Segmenter::new(VadConfig::default()).expect("the default config must be valid")
    }

    /// Push `ms` of one level, collecting whatever the machine says.
    fn push_ms(s: &mut Segmenter, level: f32, ms: u32) -> Vec<VadEvent> {
        let frames = ms / s.cfg.frame_ms;
        (0..frames).filter_map(|_| s.push(level)).collect()
    }

    /// Let the floor settle on the room before the interesting part, as it does in life.
    fn settle(s: &mut Segmenter) {
        push_ms(s, QUIET, 4_000);
    }

    #[test]
    fn the_default_config_is_valid_and_a_chattering_one_is_refused() {
        assert!(VadConfig::default().validate().is_ok());
        let mut c = VadConfig::default();
        c.close_ratio = c.open_ratio;
        let e = c.validate().unwrap_err();
        assert!(e.contains("chatters"), "the refusal should say what goes wrong: {e}");
        assert!(Segmenter::new(c).is_err(), "and the constructor must refuse it too");
    }

    #[test]
    fn a_silent_room_produces_nothing_at_all() {
        let mut s = seg();
        let events = push_ms(&mut s, QUIET, 60_000);
        assert!(events.is_empty(), "a quiet minute must not record: {events:?}");
        assert!(!s.is_recording());
    }

    #[test]
    fn one_utterance_is_one_segment() {
        let mut s = seg();
        settle(&mut s);
        let mut ev = push_ms(&mut s, LOUD, 3_000);
        ev.extend(push_ms(&mut s, QUIET, 3_000));
        let opens = ev.iter().filter(|e| matches!(e, VadEvent::Open { .. })).count();
        let closes = ev.iter().filter(|e| matches!(e, VadEvent::Close { .. })).count();
        assert_eq!((opens, closes), (1, 1), "exactly one segment: {ev:?}");
    }

    /// THE HANGOVER'S REASON FOR EXISTING. A pause between words must not end the sentence; without
    /// this the transcript arrives shredded into fragments too short to mean anything.
    #[test]
    fn a_pause_mid_utterance_does_not_split_the_segment() {
        let mut s = seg();
        settle(&mut s);
        let mut ev = push_ms(&mut s, LOUD, 1_500);
        ev.extend(push_ms(&mut s, QUIET, 300)); // a breath, well inside the 700ms hangover
        ev.extend(push_ms(&mut s, LOUD, 1_500));
        ev.extend(push_ms(&mut s, QUIET, 2_000));
        let opens = ev.iter().filter(|e| matches!(e, VadEvent::Open { .. })).count();
        assert_eq!(opens, 1, "the breath must not start a second segment: {ev:?}");
        let closes: Vec<_> = ev.iter().filter(|e| matches!(e, VadEvent::Close { .. })).collect();
        assert_eq!(closes.len(), 1, "nor end the first early: {ev:?}");
    }

    #[test]
    fn a_silence_longer_than_the_hangover_does_split_them() {
        let mut s = seg();
        settle(&mut s);
        let mut ev = push_ms(&mut s, LOUD, 1_500);
        ev.extend(push_ms(&mut s, QUIET, 2_000)); // well past 700ms
        ev.extend(push_ms(&mut s, LOUD, 1_500));
        ev.extend(push_ms(&mut s, QUIET, 2_000));
        let opens = ev.iter().filter(|e| matches!(e, VadEvent::Open { .. })).count();
        assert_eq!(opens, 2, "two utterances: {ev:?}");
    }

    /// A cough is not a thought. It must be reported as discarded rather than silently dropped —
    /// a stream of nothing but discards is a mis-tuned threshold, and silence about that is
    /// indistinguishable from a quiet room.
    #[test]
    fn a_blip_is_discarded_and_says_so() {
        let mut s = seg();
        settle(&mut s);
        let mut ev = push_ms(&mut s, LOUD, 200);
        ev.extend(push_ms(&mut s, QUIET, 2_000));
        assert!(
            ev.iter().any(|e| matches!(e, VadEvent::Discard { .. })),
            "a 200ms blip is under the 400ms minimum: {ev:?}"
        );
        assert!(!ev.iter().any(|e| matches!(e, VadEvent::Close { .. })), "and is not kept: {ev:?}");
    }

    /// Speech crosses the threshold partway into its first syllable, so a segment starting exactly
    /// at the trigger loses the first word — and a transcript missing its first word reads as
    /// though the speaker said the rest.
    #[test]
    fn the_segment_starts_before_the_trigger_so_the_first_word_survives() {
        let mut s = seg();
        settle(&mut s);
        let at_trigger = s.elapsed_ms();
        let ev = push_ms(&mut s, LOUD, 1_000);
        let VadEvent::Open { at_ms } = ev.first().expect("it opened") else {
            panic!("expected an Open, got {ev:?}");
        };
        assert!(
            *at_ms + u64::from(VadConfig::default().preroll_ms) <= at_trigger + 200,
            "start {at_ms} should precede the trigger {at_trigger} by the pre-roll"
        );
    }

    /// A pre-roll longer than the audio so far must clamp to the start of the stream. On unsigned
    /// milliseconds the failure is not a negative number, it is a wrap to ~1.8e19 — a start time
    /// beyond the heat death of the universe, which downstream reads as a segment that never began.
    #[test]
    fn a_preroll_longer_than_the_stream_clamps_to_its_beginning() {
        let mut cfg = VadConfig::default();
        cfg.warmup_ms = 200;
        cfg.preroll_ms = 10_000; // far longer than anything captured yet
        let mut s = Segmenter::new(cfg).unwrap();
        push_ms(&mut s, QUIET, 400);
        let ev = push_ms(&mut s, LOUD, 1_000);
        let VadEvent::Open { at_ms } = ev.first().expect("it opened") else {
            panic!("expected an Open, got {ev:?}");
        };
        assert_eq!(*at_ms, 0, "clamped to the start rather than wrapped");
    }

    #[test]
    fn a_continuous_noise_source_cannot_produce_one_unbounded_segment() {
        let mut cfg = VadConfig::default();
        cfg.max_segment_ms = 2_000;
        let mut s = Segmenter::new(cfg).unwrap();
        settle(&mut s);
        let ev = push_ms(&mut s, LOUD, 10_000);
        let closes = ev.iter().filter(|e| matches!(e, VadEvent::Close { .. })).count();
        assert!(closes >= 2, "10s of continuous noise at a 2s cap must break up: {ev:?}");
    }

    #[test]
    fn shutting_down_closes_the_sentence_in_progress() {
        let mut s = seg();
        settle(&mut s);
        push_ms(&mut s, LOUD, 2_000);
        assert!(s.is_recording(), "mid-utterance");
        let ev = s.finish().expect("finish must close what is open");
        assert!(matches!(ev, VadEvent::Close { .. }), "and keep it: {ev:?}");
        assert!(!s.is_recording());
        assert!(s.finish().is_none(), "and it closes exactly once");
    }

    /// THE BUG THIS GUARDS. If the floor keeps learning while recording, a long utterance drags it
    /// up toward speech level, the close threshold rises with it, and the segment shuts
    /// mid-sentence — the detector talking itself into believing the room got louder.
    #[test]
    fn the_noise_floor_does_not_learn_from_the_speech_it_is_recording() {
        let mut s = seg();
        settle(&mut s);
        push_ms(&mut s, LOUD, 400); // open it
        let floor_at_open = s.noise_floor();
        let ev = push_ms(&mut s, LOUD, 20_000);
        assert_eq!(s.noise_floor(), floor_at_open, "the floor must be frozen while recording");
        assert!(
            !ev.iter().any(|e| matches!(e, VadEvent::Close { .. })),
            "20s of steady speech must not close on its own: {ev:?}"
        );
    }

    /// The asymmetry, stated as the thing that actually matters: over the SAME number of frames the
    /// floor closes more of the gap going down than going up. A room getting quieter is information
    /// to adopt at once; a rise is usually somebody talking.
    #[test]
    fn the_floor_adopts_quiet_faster_than_it_adopts_loud() {
        // Short enough that the fast side has not saturated at 1.0, or the ratio is meaningless.
        const N: usize = 5;
        let mut down = NoiseFloor::new(1e-6);
        for _ in 0..300 {
            down.update(0.05);
        }
        let from_high = down.level();
        for _ in 0..N {
            down.update(0.001);
        }
        let fell = (from_high - down.level()) / (from_high - 0.001);

        let mut up = NoiseFloor::new(1e-6);
        for _ in 0..300 {
            up.update(0.001);
        }
        let from_low = up.level();
        for _ in 0..N {
            up.update(0.05);
        }
        let rose = (up.level() - from_low) / (0.05 - from_low);

        assert!(fell > rose * 5.0, "falling ({fell:.3}) must far outpace rising ({rose:.3})");
        assert!(rose > 0.0, "but it must still be able to learn a louder room at all");
    }

    /// THE COLD-START DEADLOCK, and the reason `warm` exists. The estimate begins at `floor_min`,
    /// far below any real room. Without a warm-up the first quiet frame clears a threshold derived
    /// from that estimate, a segment opens, the floor freezes because we are recording, and it never
    /// learns the room — an ear recording silence forever, having been told the room was silent.
    #[test]
    fn a_cold_start_learns_the_room_before_it_can_trigger_on_it() {
        let mut s = seg();
        assert!(s.is_warming(), "it starts deaf on purpose");
        let ev = push_ms(&mut s, QUIET, 30_000);
        assert!(ev.is_empty(), "a quiet room from a cold start must record nothing: {ev:?}");
        assert!(!s.is_warming(), "and warm-up must end");
        assert!(
            s.noise_floor() > QUIET * 0.5 && s.noise_floor() < QUIET * 2.0,
            "the floor should have learned the room, got {}",
            s.noise_floor()
        );
    }

    /// A dead input and a quiet room are the same silence to a threshold, and telling them apart is
    /// the difference between an ear that is working and one that only says it is.
    #[test]
    fn a_dead_input_is_distinguished_from_a_quiet_room() {
        let mut dead = seg();
        push_ms(&mut dead, 0.0, 5_000);
        assert!(dead.input_looks_dead(), "digital silence is a dead device");

        let mut quiet = seg();
        // The onboard input's measured self-noise in a silent room.
        push_ms(&mut quiet, 0.00235, 5_000);
        assert!(!quiet.input_looks_dead(), "a real mic in a quiet room is ALIVE, floor {}", quiet.noise_floor());

        let mut warming = seg();
        push_ms(&mut warming, 0.0, 200);
        assert!(!warming.input_looks_dead(), "it must not accuse the device before it has listened");
    }

    #[test]
    fn warmup_is_reported_so_a_deaf_moment_is_not_mistaken_for_a_quiet_one() {
        let mut s = seg();
        assert!(s.is_warming());
        push_ms(&mut s, QUIET, 2_000);
        assert!(!s.is_warming());
    }

    /// A muted or unplugged device reads as exact zeros. Without the clamp the floor goes to 0,
    /// every derived threshold goes to 0, and the first non-zero sample opens a segment that never
    /// closes — an ear that records the room forever because it was told the room was silent.
    #[test]
    fn a_digitally_silent_input_cannot_drive_the_floor_to_zero() {
        let mut f = NoiseFloor::new(1e-4);
        for _ in 0..10_000 {
            f.update(0.0);
        }
        assert!(f.level() >= 1e-4, "the floor has its own floor, got {}", f.level());

        let mut s = seg();
        let ev = push_ms(&mut s, 0.0, 30_000);
        assert!(ev.is_empty(), "and a dead input records nothing: {ev:?}");
    }

    #[test]
    fn a_non_finite_frame_is_absorbed_rather_than_poisoning_the_floor() {
        let mut s = seg();
        settle(&mut s);
        let before = s.noise_floor();
        s.push(f32::NAN);
        s.push(f32::INFINITY);
        assert!(s.noise_floor().is_finite(), "the floor stayed finite");
        assert!(s.noise_floor() >= before * 0.5, "and was not wrecked by it");
    }
}
