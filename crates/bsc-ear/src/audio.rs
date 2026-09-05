//! Turning whatever the sound card gives us into what the rest of the ear expects — pure.
//!
//! A capture device offers its own rate and channel count, not ours. This machine's four inputs
//! disagree with each other, and the eventual consumer (Whisper, next slice) wants exactly one
//! shape: 16 kHz mono. The conversion is arithmetic over slices, so it is tested as arithmetic.

/// What every stage downstream assumes, and what Whisper requires.
pub const TARGET_HZ: u32 = 16_000;

/// Average interleaved channels down to mono.
///
/// AVERAGED, not "take the first channel". A stereo input with the microphone wired to the right
/// channel — which is what a mono source on a two-channel interface usually looks like — yields
/// pure silence if you take the left, and an ear that hears nothing is indistinguishable from a
/// quiet room.
pub fn to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    if ch == 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(ch)
        .map(|f| f.iter().sum::<f32>() / ch as f32)
        .collect()
}

/// Resample by linear interpolation.
///
/// Linear, not a windowed sinc: the consumer is a speech model, the direction is almost always
/// downward (48 kHz → 16 kHz), and the aliasing this admits sits above the band speech occupies.
/// A better resampler is a change behind this signature if a transcript ever justifies one.
pub fn resample_linear(input: &[f32], from_hz: u32, to_hz: u32) -> Vec<f32> {
    if from_hz == to_hz || from_hz == 0 || to_hz == 0 || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from_hz as f64 / to_hz as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let a = pos.floor() as usize;
            let frac = (pos - a as f64) as f32;
            let x0 = input[a.min(input.len() - 1)];
            let x1 = input[(a + 1).min(input.len() - 1)];
            x0 + (x1 - x0) * frac
        })
        .collect()
}

/// Root-mean-square of a frame — the one number the segmenter consumes.
///
/// Non-finite samples are treated as zero rather than allowed through. A single NaN from a driver
/// glitch would otherwise make the RMS NaN, and every comparison against a NaN is false, so the
/// detector would silently stop triggering rather than fail.
pub fn rms(frames: &[f32]) -> f32 {
    if frames.is_empty() {
        return 0.0;
    }
    let sum: f32 = frames.iter().map(|s| if s.is_finite() { s * s } else { 0.0 }).sum();
    (sum / frames.len() as f32).sqrt()
}

/// Samples in one frame of `frame_ms` at [`TARGET_HZ`].
pub fn frame_len(frame_ms: u32) -> usize {
    (TARGET_HZ as usize * frame_ms as usize) / 1000
}

/// A fixed-length ring of recent samples, holding the pre-roll.
///
/// Speech crosses the detection threshold partway into its first syllable, so the audio that makes
/// the first word intelligible has already gone past by the time anyone decides to record. This is
/// where it waits.
pub struct PreRoll {
    buf: Vec<f32>,
    cap: usize,
}

impl PreRoll {
    pub fn new(ms: u32) -> Self {
        PreRoll { buf: Vec::new(), cap: (TARGET_HZ as usize * ms as usize) / 1000 }
    }

    pub fn push(&mut self, samples: &[f32]) {
        self.buf.extend_from_slice(samples);
        if self.buf.len() > self.cap {
            let drop = self.buf.len() - self.cap;
            self.buf.drain(..drop);
        }
    }

    /// Everything held, oldest first.
    pub fn drain(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.buf)
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

/// Clamp to the i16 range and convert, for writing a wav.
pub fn to_i16(s: f32) -> i16 {
    if !s.is_finite() {
        return 0;
    }
    (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mono source wired to one channel of a stereo interface is the ordinary case on this
    /// machine's Scarlett. Taking the first channel would return silence, and an ear that hears
    /// nothing looks exactly like a quiet room.
    #[test]
    fn a_source_on_only_the_right_channel_survives_the_downmix() {
        let interleaved = vec![0.0, 0.8, 0.0, 0.6, 0.0, 0.4];
        let mono = to_mono(&interleaved, 2);
        assert_eq!(mono, vec![0.4, 0.3, 0.2]);
        assert!(rms(&mono) > 0.0, "it must not come out silent");
    }

    #[test]
    fn mono_input_passes_through_untouched() {
        let x = vec![0.1, -0.2, 0.3];
        assert_eq!(to_mono(&x, 1), x);
        assert_eq!(to_mono(&x, 0), x, "a zero channel count is treated as mono, not divided by zero");
    }

    #[test]
    fn downsampling_preserves_duration_and_level() {
        // 48 kHz → 16 kHz is the common case on this hardware.
        let input: Vec<f32> = (0..48_000).map(|i| ((i as f32) * 0.01).sin() * 0.5).collect();
        let out = resample_linear(&input, 48_000, TARGET_HZ);
        assert_eq!(out.len(), 16_000, "one second in, one second out");
        let before = rms(&input);
        let after = rms(&out);
        assert!((before - after).abs() < 0.05, "level roughly preserved: {before} vs {after}");
    }

    #[test]
    fn resampling_to_the_same_rate_is_a_pass_through_and_never_panics_on_edges() {
        let x = vec![0.1, 0.2, 0.3];
        assert_eq!(resample_linear(&x, 16_000, 16_000), x);
        assert!(resample_linear(&[], 48_000, 16_000).is_empty());
        assert_eq!(resample_linear(&x, 0, 16_000), x, "a zero rate must not divide by zero");
        // Upsampling reads index+1 at the very end; it must clamp rather than run off.
        let up = resample_linear(&x, 16_000, 48_000);
        assert!(up.len() >= x.len());
    }

    /// A single NaN from a driver glitch would make the RMS NaN, and every comparison against NaN
    /// is false — so the detector would stop triggering silently rather than fail loudly.
    #[test]
    fn a_glitched_sample_cannot_make_the_level_unusable() {
        let r = rms(&[0.5, f32::NAN, 0.5, f32::INFINITY]);
        assert!(r.is_finite(), "got {r}");
        assert!(r > 0.0, "and the real samples still count");
        assert_eq!(rms(&[]), 0.0);
    }

    #[test]
    fn the_preroll_holds_a_bounded_tail_of_the_most_recent_audio() {
        let mut p = PreRoll::new(100); // 1600 samples at 16 kHz
        assert!(p.is_empty());
        for i in 0..50 {
            p.push(&vec![i as f32; 100]);
        }
        assert_eq!(p.len(), 1600, "bounded regardless of how much went in");
        let held = p.drain();
        assert_eq!(held.len(), 1600);
        assert_eq!(*held.last().unwrap(), 49.0, "the most RECENT audio is what is kept");
        assert!(p.is_empty(), "draining empties it");
    }

    #[test]
    fn a_frame_is_the_expected_number_of_samples() {
        assert_eq!(frame_len(20), 320);
        assert_eq!(frame_len(1000), TARGET_HZ as usize);
    }

    #[test]
    fn conversion_to_i16_clamps_instead_of_wrapping() {
        assert_eq!(to_i16(0.0), 0);
        assert!(to_i16(2.0) > 32_000, "over-range clamps to the top, not around to the bottom");
        assert!(to_i16(-2.0) < -32_000);
        assert_eq!(to_i16(f32::NAN), 0);
    }
}

// ── Which capture devices are worth showing ───────────────────────────────────────────────────────

/// Whether a device name is one a person would actually pick.
///
/// ALSA presents the same hardware many times over. Measured on this machine: **27 capture devices
/// for four physical inputs** — every card appears as `hw:`, `plughw:`, `front:`, `surround40:`,
/// `surround51:`, `iec958:`, `dsnoop:` and `sysdefault:CARD=`, which are routing variants, not
/// things to choose between. A list where the answer is one row in seven is a list nobody reads.
///
/// Kept: the routed defaults (`default`, `pipewire`, `sysdefault`) and one `plughw:` per card.
/// `plughw` rather than `hw` deliberately — it converts rate and format in the driver, so a device
/// that only captures at 48 kHz stereo still opens, where the raw `hw:` node would simply refuse.
pub fn is_primary_device(name: &str) -> bool {
    matches!(name, "default" | "pipewire" | "sysdefault" | "pulse") || name.starts_with("plughw:")
}

/// Probe order: hardware nodes BEFORE routed ones.
///
/// Measured, and the reason this function exists: probing `sysdefault`/`pipewire`/`default` takes
/// the interface through the sound server, and the hardware node then disappears from enumeration
/// for the rest of the sweep — so the Scarlett, the one device the user actually wanted measured,
/// was reported as missing. Hardware first means each real input is measured while it is free, and
/// the routed nodes (which the sound server is happy to share) come after.
pub fn probe_order(a: &str, b: &str) -> std::cmp::Ordering {
    let rank = |n: &str| if n.starts_with("plughw:") || n.starts_with("hw:") { 0 } else { 1 };
    rank(a).cmp(&rank(b)).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod device_tests {
    use super::*;

    /// Probing a routed node takes the hardware with it and hides the hardware node from the rest
    /// of the sweep — measured, and it lost the one device that mattered.
    #[test]
    fn hardware_is_probed_before_anything_routed() {
        let mut v = vec!["default", "plughw:CARD=USB,DEV=0", "pipewire", "plughw:CARD=X,DEV=0", "sysdefault"];
        v.sort_by(|a, b| probe_order(a, b));
        assert_eq!(v[0], "plughw:CARD=USB,DEV=0", "the interface is measured while it is free");
        assert_eq!(v[1], "plughw:CARD=X,DEV=0");
        assert!(v[2..].iter().all(|n| !n.starts_with("plughw:")), "routed nodes come last: {v:?}");
    }

    #[test]
    fn the_routed_defaults_and_one_node_per_card_survive_the_filter() {
        for keep in ["default", "pipewire", "sysdefault", "pulse", "plughw:CARD=X,DEV=0"] {
            assert!(is_primary_device(keep), "{keep} should be offered");
        }
    }

    #[test]
    fn the_routing_variants_are_hidden_because_they_are_the_same_hardware() {
        for hide in [
            "hw:CARD=X,DEV=0",
            "front:CARD=X,DEV=0",
            "surround40:CARD=Generic,DEV=0",
            "surround51:CARD=Generic,DEV=0",
            "iec958:CARD=X,DEV=0",
            "dsnoop:CARD=X,DEV=0",
            "sysdefault:CARD=USB",
        ] {
            assert!(!is_primary_device(hide), "{hide} is a routing variant, not a choice");
        }
    }

    /// The measured shape of this machine: 27 rows in, a handful out. If a future ALSA names things
    /// differently the filter could quietly keep nothing, and an empty device list reads as "no
    /// microphone" — so the count is asserted, not just the membership.
    #[test]
    fn the_filter_keeps_a_useful_few_rather_than_none_or_everything() {
        let real = [
            "sysdefault", "pipewire", "default",
            "hw:CARD=USB,DEV=0", "plughw:CARD=USB,DEV=0", "sysdefault:CARD=USB",
            "front:CARD=USB,DEV=0", "surround40:CARD=USB,DEV=0", "dsnoop:CARD=USB,DEV=0",
            "hw:CARD=Generic,DEV=0", "plughw:CARD=Generic,DEV=0", "hw:CARD=Generic,DEV=2",
            "plughw:CARD=Generic,DEV=2", "sysdefault:CARD=Generic", "front:CARD=Generic,DEV=0",
            "hw:CARD=X,DEV=0", "plughw:CARD=X,DEV=0", "sysdefault:CARD=X",
            "front:CARD=X,DEV=0", "iec958:CARD=X,DEV=0", "dsnoop:CARD=X,DEV=0",
        ];
        let kept: Vec<&str> = real.iter().copied().filter(|n| is_primary_device(n)).collect();
        assert_eq!(kept.len(), 7, "expected the defaults plus one per card, got {kept:?}");
        assert!(kept.contains(&"default"));
        assert!(kept.contains(&"plughw:CARD=X,DEV=0"), "the headset must be reachable");
    }
}
