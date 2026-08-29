//! Durable PTY output — the raw byte stream on disk, with offsets that are SAFE to replay from.
//!
//! ## Why this exists
//!
//! Terminal history has been defended in RAM by two lossy mechanisms, and both cost more than they
//! save. [`PendingPtyData`](../../../../src/app/console/lib/pendingPtyData.ts) drops the OLDEST chunks
//! once a hidden pane exceeds 256 KB, and `scrollbackForPaneCount` truncates a pane's buffer from
//! 10,000 lines to 500 as panes multiply. The first is not merely lossy but CORRUPTING — see below —
//! and the second discards exactly the history a fleet operator wants.
//!
//! Writing the bytes down removes the reason for both. Output is ~3-13 KB per 2s across every pane, so
//! an SSD does not notice, and a session's history stops competing with its own renderer for memory.
//!
//! ## Why an arbitrary offset is not replayable
//!
//! A PTY stream is not lines. It is text INTERLEAVED WITH ESCAPE SEQUENCES, and a `read()` splits it
//! wherever the kernel happened to stop. Start replaying in the middle of one and the terminal
//! misparses the remainder; worse, the sequences that establish STATE — auto-wrap, scroll regions,
//! alt-screen, attributes — are the ones whose loss corrupts everything drawn afterwards. That is
//! precisely the bug this exists to end, and re-introducing it from the read side would be the same
//! defect wearing a different hat.
//!
//! So [`AnsiScan`] tracks whether the stream is currently BETWEEN sequences, and only an offset
//! observed in the ground state is ever recorded as a replay point.
//!
//! ## Discipline
//!
//! Modelled on the opt-in `$BSC_PTY_DUMP` tap in [`super::pump`], which already writes raw bytes
//! verbatim before UTF-8 splitting: fail-safe throughout. A missing directory, a permission error or a
//! full disk must never disturb the session being recorded — recording is a convenience, the session
//! is the product.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Record a replay point at most this often. Small enough that a reader never has to skip far to find
/// a boundary, large enough that the index stays a rounding error beside the stream itself.
const MARK_EVERY_BYTES: u64 = 64 * 1024;

/// Where a pane's recording lives.
pub fn scrollback_dir() -> PathBuf {
    crate::platform::paths::bsc_base_dir().join("scrollback")
}

/// A pane id reduced to something safe to use as a filename, matching what the `$BSC_PTY_DUMP` tap
/// already does so the two produce the same name for the same pane.
pub fn safe_stem(pane_id: &str) -> String {
    pane_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Where the stream is, mid-parse.
///
/// Only [`AnsiState::Ground`] is a legal place to start replaying. Everything else means a sequence is
/// in flight and its remaining bytes are still to come.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnsiState {
    /// Between sequences — ordinary text. The only safe boundary.
    Ground,
    /// Saw ESC; the next byte decides what kind of sequence this is.
    Esc,
    /// An intermediate byte after ESC (`0x20..=0x2F`), awaiting a final.
    EscInter,
    /// Inside a CSI (`ESC [`) — parameter bytes until a final `0x40..=0x7E`.
    Csi,
    /// Intermediate bytes inside a CSI, awaiting its final.
    CsiInter,
    /// Inside a string sequence — OSC / DCS / SOS / PM / APC — until BEL or ST.
    Str,
    /// Saw ESC inside a string sequence; a following `\` closes it (ST).
    StrEsc,
}

/// Tracks whether a byte stream is currently between escape sequences.
///
/// Deliberately a boundary detector and NOT a terminal emulator: it never interprets what a sequence
/// MEANS, only where one ends. That is the whole question a replay point has to answer, and keeping the
/// scope there is what makes it exhaustively testable.
///
/// It is fed every byte in order and carries its state ACROSS reads, because the split between reads is
/// exactly where a naive scanner would be fooled — a `read()` routinely lands mid-sequence.
#[derive(Debug, Clone)]
pub struct AnsiScan {
    state: AnsiState,
}

impl Default for AnsiScan {
    fn default() -> Self {
        Self { state: AnsiState::Ground }
    }
}

impl AnsiScan {
    pub fn new() -> Self {
        Self::default()
    }

    /// Is the stream between sequences right now — i.e. is this a legal replay point?
    pub fn at_boundary(&self) -> bool {
        self.state == AnsiState::Ground
    }

    /// Advance over `bytes`.
    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.state = next(self.state, b);
        }
    }
}

/// One byte of the VT parser, as a pure transition so every arm is testable without a stream.
///
/// Unknown bytes fall back to `Ground` rather than sticking: a scanner wedged in a non-ground state by
/// one malformed byte would silently stop recording replay points forever, which fails much worse than
/// occasionally marking a boundary a byte early.
fn next(state: AnsiState, b: u8) -> AnsiState {
    use AnsiState::*;
    const ESC: u8 = 0x1B;
    const BEL: u8 = 0x07;
    match state {
        Ground => if b == ESC { Esc } else { Ground },
        Esc => match b {
            b'[' => Csi,
            // OSC, DCS, SOS, PM, APC — all string sequences terminated by BEL or ST.
            b']' | b'P' | b'X' | b'^' | b'_' => Str,
            0x20..=0x2F => EscInter,
            0x30..=0x7E => Ground, // a complete two-byte escape
            _ => Ground,
        },
        EscInter => match b {
            0x20..=0x2F => EscInter,
            0x30..=0x7E => Ground,
            _ => Ground,
        },
        Csi => match b {
            0x30..=0x3F => Csi,      // parameter bytes
            0x20..=0x2F => CsiInter, // intermediates
            0x40..=0x7E => Ground,   // final
            _ => Ground,
        },
        CsiInter => match b {
            0x20..=0x2F => CsiInter,
            0x40..=0x7E => Ground,
            _ => Ground,
        },
        Str => match b {
            BEL => Ground,
            ESC => StrEsc,
            _ => Str,
        },
        StrEsc => match b {
            b'\\' => Ground, // ST
            ESC => StrEsc,
            _ => Str, // ESC inside the payload that was not ST — still in the string
        },
    }
}

/// Appends one pane's raw output to disk and records the offsets that are safe to replay from.
///
/// Every method is best-effort. A recorder that cannot write simply stops recording; it never
/// propagates an error into the session.
pub struct ScrollbackRecorder {
    stream: File,
    index: File,
    scan: AnsiScan,
    /// Bytes appended by THIS recorder plus whatever the file already held, so offsets in the index
    /// address the file rather than this run.
    written: u64,
    /// Offset of the last recorded replay point.
    last_mark: u64,
}

impl ScrollbackRecorder {
    /// Open (or resume) the recording for `pane_id` under `dir`.
    ///
    /// Returns `None` on any failure, which the caller must treat as "do not record" — never as an
    /// error worth surfacing. Appends rather than truncates so a pane that survives a renderer reload
    /// keeps its history.
    pub fn open(dir: &Path, pane_id: &str) -> Option<Self> {
        let stem = safe_stem(pane_id);
        std::fs::create_dir_all(dir).ok()?;
        let stream = OpenOptions::new().create(true).append(true).open(dir.join(format!("{stem}.bin"))).ok()?;
        let index = OpenOptions::new().create(true).append(true).open(dir.join(format!("{stem}.idx"))).ok()?;
        // Resume from the real end of the file: a fresh recorder appending to an existing recording
        // must not hand out offsets that address its own run.
        let written = stream.metadata().map(|m| m.len()).unwrap_or(0);
        Some(Self { stream, index, scan: AnsiScan::new(), written, last_mark: written })
    }

    /// Append `bytes` and record a replay point if the stream is at a boundary and far enough past the
    /// last one.
    ///
    /// NOT flushed per write. The reader thread calls this on every `read()`, and a flush there would
    /// turn a 3-13 KB/s stream into a syscall per chunk for no benefit — the OS page cache is exactly
    /// the right place for this, and a recording lost to a hard kill costs a few seconds of scrollback,
    /// not correctness.
    pub fn write(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if self.stream.write_all(bytes).is_err() {
            return; // a broken recording must not break the session
        }
        self.written += bytes.len() as u64;
        self.scan.feed(bytes);
        // The offset AFTER the chunk is a replay point only when nothing is mid-flight there.
        if self.scan.at_boundary()
            && self.written.saturating_sub(self.last_mark) >= MARK_EVERY_BYTES
            && writeln!(self.index, "{}", self.written).is_ok()
        {
            self.last_mark = self.written;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_all(chunks: &[&[u8]]) -> AnsiScan {
        let mut s = AnsiScan::new();
        for c in chunks {
            s.feed(c);
        }
        s
    }

    #[test]
    fn plain_text_is_always_a_boundary() {
        assert!(scan_all(&[b"hello world\n"]).at_boundary());
    }

    #[test]
    fn a_complete_csi_ends_at_a_boundary() {
        // Colour, cursor move, erase — the everyday ones.
        for seq in [&b"\x1b[0m"[..], b"\x1b[1;32m", b"\x1b[2J", b"\x1b[10;20H", b"\x1b[?25l"] {
            assert!(scan_all(&[seq]).at_boundary(), "{:?} should end at a boundary", seq);
        }
    }

    #[test]
    fn an_unfinished_csi_is_not_a_boundary() {
        // THE CASE THAT MATTERS: a read that stops mid-sequence. Marking here would hand a reader an
        // offset that starts inside `\x1b[1;32m`, and the replay would render the tail as text.
        for partial in [&b"\x1b"[..], b"\x1b[", b"\x1b[1", b"\x1b[1;", b"\x1b[1;32"] {
            assert!(!scan_all(&[partial]).at_boundary(), "{:?} must NOT be a boundary", partial);
        }
    }

    #[test]
    fn a_sequence_split_across_reads_is_tracked() {
        // The scanner carries state across chunks, which is the only reason it is right at all — a
        // `read()` lands mid-sequence routinely.
        assert!(!scan_all(&[b"abc\x1b[", b"1;3"]).at_boundary());
        assert!(scan_all(&[b"abc\x1b[", b"1;3", b"2mdef"]).at_boundary());
    }

    #[test]
    fn osc_closes_on_bel_or_st() {
        // Window title is the everyday OSC, and both terminators are in the wild.
        assert!(scan_all(&[b"\x1b]0;a title\x07"]).at_boundary());
        assert!(scan_all(&[b"\x1b]0;a title\x1b\\"]).at_boundary());
        assert!(!scan_all(&[b"\x1b]0;a title"]).at_boundary());
        // A `;` or an ESC that is not ST keeps the string open rather than closing it early.
        assert!(!scan_all(&[b"\x1b]8;;https://example.com"]).at_boundary());
    }

    #[test]
    fn dcs_and_friends_are_string_sequences_too() {
        for intro in [&b"\x1bP"[..], b"\x1bX", b"\x1b^", b"\x1b_"] {
            let mut open = intro.to_vec();
            open.extend_from_slice(b"payload");
            assert!(!scan_all(&[&open]).at_boundary(), "{:?} should still be open", intro);
            open.extend_from_slice(b"\x1b\\");
            assert!(scan_all(&[&open]).at_boundary(), "{:?} should close on ST", intro);
        }
    }

    #[test]
    fn two_byte_escapes_complete_immediately() {
        // `ESC c` (reset), `ESC 7` / `ESC 8` (save/restore cursor), `ESC =` — no final byte to wait for.
        for seq in [&b"\x1bc"[..], b"\x1b7", b"\x1b8", b"\x1b="] {
            assert!(scan_all(&[seq]).at_boundary(), "{:?} completes on its second byte", seq);
        }
        // …and a charset designation, which carries an intermediate first.
        assert!(scan_all(&[b"\x1b(B"]).at_boundary());
        assert!(!scan_all(&[b"\x1b("]).at_boundary());
    }

    #[test]
    fn a_stray_byte_does_not_wedge_the_scanner_forever() {
        // Fail OPEN. A scanner stuck out of ground would stop recording replay points for the life of
        // the session and nothing would say why — far worse than marking a boundary one byte early.
        assert!(scan_all(&[b"\x1b\x00", b"ordinary text"]).at_boundary());
    }

    #[test]
    fn the_recorder_appends_and_marks_only_at_boundaries() {
        let dir = std::env::temp_dir().join(format!("sb-test-{}-{}", std::process::id(), now_nanos()));
        let mut r = ScrollbackRecorder::open(&dir, "pane:one/two").expect("opens");
        // Below the mark cadence, so no replay point is recorded yet…
        r.write(b"hello");
        // …then well past it, but ending mid-sequence, so STILL no mark.
        let mut big = vec![b'x'; MARK_EVERY_BYTES as usize];
        big.extend_from_slice(b"\x1b[1;3");
        r.write(&big);
        drop(r);
        let stem = safe_stem("pane:one/two");
        assert_eq!(stem, "pane_one_two", "the filename must be safe and match the $BSC_PTY_DUMP tap");
        let idx = std::fs::read_to_string(dir.join(format!("{stem}.idx"))).unwrap_or_default();
        assert_eq!(idx.trim(), "", "an offset inside an escape sequence must never be recorded");

        // Close the sequence and write past the cadence again — now a mark is legal.
        let mut r = ScrollbackRecorder::open(&dir, "pane:one/two").expect("reopens");
        r.write(b"m");
        r.write(&vec![b'y'; MARK_EVERY_BYTES as usize]);
        drop(r);
        let idx = std::fs::read_to_string(dir.join(format!("{stem}.idx"))).unwrap_or_default();
        let marks: Vec<u64> = idx.lines().filter_map(|l| l.trim().parse().ok()).collect();
        assert_eq!(marks.len(), 1, "exactly one replay point, at the boundary");
        let bin = std::fs::metadata(dir.join(format!("{stem}.bin"))).unwrap().len();
        assert_eq!(marks[0], bin, "the offset addresses the FILE, not this recorder's own run");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn now_nanos() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }
}
