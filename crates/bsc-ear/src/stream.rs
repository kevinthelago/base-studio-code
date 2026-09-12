//! Turning a sequence of streamed audio frames back into samples — and admitting what was lost.
//!
//! **A DROPPED FRAME MUST NOT BECOME A SILENT SPLICE.** The tunnel this feeds drops frames on a slow
//! client by design (`"tunnel: dropped N output chunk(s)"`), which is right for terminal output and
//! wrong for audio: concatenating across a hole does not merely lose a moment, it shortens the
//! timeline. Speech rate, pause structure and segment boundaries are all measured from elapsed
//! samples, so a silent splice makes every one of them read a value that never happened — and it
//! reads as *confident* data rather than as missing data. That is the failure this module exists to
//! prevent.
//!
//! **NOR IS THE ANSWER TO FILL THE HOLE WITH SILENCE.** Silence is not neutral here: to the
//! segmenter it is a pause, so a lost frame would turn into a phantom gap between words and change
//! exactly the measures it corrupted before. The gap is *surfaced* instead, and the consumer closes
//! whatever segment is open across it — the same thing capture already does when the app starts
//! speaking and the microphone is no longer trustworthy.
//!
//! **THE WIRE FORMAT STAYS OUT OF HERE.** Frames arrive as raw little-endian PCM16 bytes; base64,
//! JSON and the tunnel envelope are the transport's business and are decoded at its edge. This
//! module is pure, needs no network, and is tested by handing it sequence numbers.

use crate::audio;

/// Bytes per PCM16 sample. The wire format is 16-bit mono little-endian.
pub const BYTES_PER_SAMPLE: usize = 2;

/// What one frame contributed to the stream.
#[derive(Clone, PartialEq, Debug)]
pub enum Received {
    /// Samples that follow the previous frame with nothing missing between them.
    Samples(Vec<f32>),
    /// `lost` frames never arrived before these samples did.
    ///
    /// The consumer owes an action, not just a log line: close any open segment, because the audio
    /// either side of this is not continuous and must not be written as one utterance.
    Gap { lost: u64, samples: Vec<f32> },
    /// A frame from the past — reordered or duplicated. DROPPED, never applied.
    ///
    /// Splicing it in late would put audio out of order, which is worse than losing it: the result
    /// is a recording that sounds plausible and is wrong.
    Stale { seq: u64 },
}

/// Reassembles a streamed channel, reporting loss rather than hiding it.
#[derive(Clone, Debug, Default)]
pub struct FrameAssembler {
    /// The sequence number expected next. `None` until the first frame decides where we are.
    next_seq: Option<u64>,
    lost: u64,
}

impl FrameAssembler {
    pub fn new() -> FrameAssembler {
        FrameAssembler::default()
    }

    /// Total frames known to have been lost so far.
    ///
    /// A running count rather than a boolean, so "the connection is degrading" is answerable.
    pub fn lost(&self) -> u64 {
        self.lost
    }

    /// Accept one frame: its sequence number and its raw little-endian PCM16 bytes.
    pub fn accept(&mut self, seq: u64, pcm: &[u8]) -> Received {
        let Some(expected) = self.next_seq else {
            // THE FIRST FRAME DEFINES THE ORIGIN. A stream that happens to start at 400 has not
            // lost 400 frames, and reporting that would make every fresh connection look broken.
            self.next_seq = Some(seq.wrapping_add(1));
            return Received::Samples(decode(pcm));
        };
        if seq < expected {
            return Received::Stale { seq };
        }
        self.next_seq = Some(seq.wrapping_add(1));
        let samples = decode(pcm);
        let lost = seq - expected;
        if lost == 0 {
            Received::Samples(samples)
        } else {
            self.lost += lost;
            Received::Gap { lost, samples }
        }
    }
}

/// Little-endian PCM16 bytes to samples.
///
/// A TRAILING ODD BYTE IS DISCARDED rather than padded into a sample: half a sample is not a quiet
/// sample, it is a truncated frame, and inventing the missing byte would put a value into the
/// signal that nothing transmitted.
fn decode(pcm: &[u8]) -> Vec<f32> {
    // `rest` is the trailing odd byte, named rather than implied — and dropped on purpose.
    let (pairs, _rest) = pcm.as_chunks::<BYTES_PER_SAMPLE>();
    pairs.iter().map(|b| audio::from_i16(i16::from_le_bytes(*b))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode samples the way a sender would, so the tests exercise the real round trip.
    fn pcm(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| audio::to_i16(*s).to_le_bytes()).collect()
    }

    #[test]
    fn frames_in_order_decode_to_the_samples_that_were_sent() {
        let mut a = FrameAssembler::new();
        let sent = [0.0f32, 0.5, -0.5, 1.0];
        match a.accept(0, &pcm(&sent)) {
            Received::Samples(got) => {
                assert_eq!(got.len(), sent.len());
                for (g, s) in got.iter().zip(sent) {
                    assert!((g - s).abs() < 1e-4, "{s} arrived as {g}");
                }
            }
            other @ (Received::Gap { .. } | Received::Stale { .. }) => {
                panic!("expected samples, got {other:?}")
            }
        }
        assert_eq!(a.lost(), 0);
    }

    /// THE CRITERION: a hole is REPORTED, never concatenated across in silence.
    #[test]
    fn a_hole_in_the_sequence_is_reported_as_a_gap_not_silently_concatenated() {
        let mut a = FrameAssembler::new();
        assert!(matches!(a.accept(0, &pcm(&[0.1; 4])), Received::Samples(_)));
        assert!(matches!(a.accept(1, &pcm(&[0.2; 4])), Received::Samples(_)));

        // 2 and 3 never arrive.
        match a.accept(4, &pcm(&[0.3; 4])) {
            Received::Gap { lost, samples } => {
                assert_eq!(lost, 2, "two frames went missing and the count must say so");
                assert_eq!(samples.len(), 4, "the frame that DID arrive is still delivered");
            }
            other @ (Received::Samples(_) | Received::Stale { .. }) => {
                panic!("a hole must surface as a gap, got {other:?}")
            }
        }
        assert_eq!(a.lost(), 2, "loss accumulates so a degrading link is answerable");

        // And the stream carries on cleanly afterwards.
        assert!(matches!(a.accept(5, &pcm(&[0.4; 4])), Received::Samples(_)));
        assert_eq!(a.lost(), 2, "a clean frame adds no loss");
    }

    #[test]
    fn a_stale_frame_is_dropped_rather_than_spliced_in_late() {
        let mut a = FrameAssembler::new();
        a.accept(10, &pcm(&[0.1; 2]));
        a.accept(11, &pcm(&[0.2; 2]));
        assert_eq!(a.accept(10, &pcm(&[0.9; 2])), Received::Stale { seq: 10 });
        // A duplicate must not advance the stream either.
        assert!(matches!(a.accept(12, &pcm(&[0.3; 2])), Received::Samples(_)));
    }

    /// A stream starting at 400 has not lost 400 frames.
    #[test]
    fn the_first_frame_sets_the_origin_rather_than_reporting_a_gap() {
        let mut a = FrameAssembler::new();
        assert!(matches!(a.accept(400, &pcm(&[0.1; 2])), Received::Samples(_)));
        assert_eq!(a.lost(), 0, "a fresh connection must not look broken");
    }

    #[test]
    fn a_trailing_odd_byte_is_discarded_rather_than_becoming_a_bogus_sample() {
        let mut a = FrameAssembler::new();
        let mut bytes = pcm(&[0.5, -0.5]);
        bytes.push(0x7f); // half a sample
        match a.accept(0, &bytes) {
            Received::Samples(got) => assert_eq!(got.len(), 2, "two whole samples, not three"),
            other @ (Received::Gap { .. } | Received::Stale { .. }) => {
                panic!("expected samples, got {other:?}")
            }
        }
    }

    #[test]
    fn an_empty_frame_yields_nothing_and_still_advances_the_sequence() {
        let mut a = FrameAssembler::new();
        assert_eq!(a.accept(0, &[]), Received::Samples(vec![]));
        // The empty frame counted: 1 is next, so no gap is reported.
        assert!(matches!(a.accept(1, &pcm(&[0.1; 2])), Received::Samples(_)));
        assert_eq!(a.lost(), 0);
    }
}
