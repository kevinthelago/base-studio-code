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

/// How much of one pane's stream to keep on disk before trimming the front.
///
/// 8 MB is roughly 100k lines of dense output — far past what anyone scrolls back through, and two
/// orders of magnitude past the 500-line in-memory budget this replaces. Across 32 fleet panes it caps
/// the store at ~256 MB of SSD, which is the trade this whole design makes: disk is the cheap resource.
const MAX_RECORDING_BYTES: u64 = 8 * 1024 * 1024;

/// Only trim once there is a worthwhile amount to reclaim, so a pane sitting at the cap does not
/// rewrite its file on every write. One mark's worth of slack is the natural granularity — below that
/// there may be no boundary to trim to anyway.
const TRIM_SLACK_BYTES: u64 = MARK_EVERY_BYTES;

/// How many bytes have been trimmed off the front of `stem`'s recording — the absolute offset of the
/// file's first byte. Absent or unreadable means nothing has been trimmed.
fn read_base(dir: &Path, stem: &str) -> u64 {
    std::fs::read_to_string(dir.join(format!("{stem}.base")))
        .ok()
        .and_then(|t| t.trim().parse().ok())
        .unwrap_or(0)
}

/// The recorded safe-boundary offsets for `stem`, ascending. Absolute, like every offset here.
fn read_marks(dir: &Path, stem: &str) -> Vec<u64> {
    std::fs::read_to_string(dir.join(format!("{stem}.idx")))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect()
}

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
/// ## Offsets are ABSOLUTE stream positions, not file positions
///
/// The recording is trimmed from the front once it passes [`MAX_RECORDING_BYTES`], and if offsets
/// addressed the file they would all shift when that happened — silently invalidating every cursor
/// published to the frontend, which is the one number the seamless handoff depends on.
///
/// So an offset always counts bytes since the session began, and a sidecar records how many were
/// discarded (the `base`). A trim moves the base and rewrites the window; no offset anyone is holding
/// ever changes meaning. Reads map absolute → file by subtracting the base.
///
/// Every method is best-effort. A recorder that cannot write simply stops recording; it never
/// propagates an error into the session.
pub struct ScrollbackRecorder {
    dir: PathBuf,
    stem: String,
    stream: File,
    index: File,
    scan: AnsiScan,
    /// Absolute offset of byte 0 of the retained window — how much has been trimmed away.
    base: u64,
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
        let base = read_base(dir, &stem);
        let written = base + stream.metadata().map(|m| m.len()).unwrap_or(0);
        Some(Self {
            dir: dir.to_path_buf(),
            stem,
            stream,
            index,
            scan: AnsiScan::new(),
            base,
            written,
            last_mark: written,
        })
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
        self.maybe_trim();
    }

    /// Drop the oldest part of the recording once it exceeds the cap, cutting AT A RECORDED BOUNDARY.
    ///
    /// This is the same rule the whole module turns on, applied to the one operation that could
    /// quietly break it: trimming at an arbitrary offset would leave the file starting mid-sequence,
    /// which is exactly the corruption `PendingPtyData` causes and this replaces. So the cut is only
    /// ever made at a mark, and if no mark is far enough in, nothing is trimmed this time — the file
    /// runs over the cap until one is.
    ///
    /// Best-effort throughout: any failure leaves the recording exactly as it was.
    fn maybe_trim(&mut self) {
        if self.written.saturating_sub(self.base) <= MAX_RECORDING_BYTES + TRIM_SLACK_BYTES {
            return;
        }
        let marks = read_marks(&self.dir, &self.stem);
        // The oldest mark that leaves us within the cap. `>` not `>=` so a cut that reclaims nothing
        // is never attempted.
        let Some(&cut) = marks.iter().find(|&&m| m > self.base && self.written - m <= MAX_RECORDING_BYTES)
        else {
            return; // no boundary far enough in yet — carry the overage rather than cut blind
        };
        if self.rewrite_from(cut, &marks).is_none() {
            log::warn!("pty scrollback: trim of {} failed; the recording keeps growing", self.stem);
        }
    }

    /// Rewrite the window to start at absolute offset `cut`, and move the base to match.
    fn rewrite_from(&mut self, cut: u64, marks: &[u64]) -> Option<()> {
        use std::io::{Seek, SeekFrom};
        let bin = self.dir.join(format!("{}.bin", self.stem));
        let tmp = self.dir.join(format!("{}.bin.trim", self.stem));
        {
            let mut src = File::open(&bin).ok()?;
            src.seek(SeekFrom::Start(cut - self.base)).ok()?;
            let mut dst = File::create(&tmp).ok()?;
            std::io::copy(&mut src, &mut dst).ok()?;
            dst.flush().ok()?;
        }
        std::fs::rename(&tmp, &bin).ok()?;
        // Reopen for append: the old handle still points at the replaced inode.
        self.stream = OpenOptions::new().create(true).append(true).open(&bin).ok()?;
        // Marks before the cut now address bytes that are gone.
        let kept: Vec<String> = marks.iter().filter(|&&m| m >= cut).map(|m| m.to_string()).collect();
        std::fs::write(self.dir.join(format!("{}.idx", self.stem)), kept.join("\n") + "\n").ok()?;
        self.index = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(format!("{}.idx", self.stem)))
            .ok()?;
        std::fs::write(self.dir.join(format!("{}.base", self.stem)), cut.to_string()).ok()?;
        self.base = cut;
        Some(())
    }

    /// Bytes recorded so far, counting whatever the file already held. This is the offset the reader
    /// hands to the emitter, so it addresses the FILE rather than this recorder's own run.
    pub fn len(&self) -> u64 {
        self.written
    }
}

/// How far into a pane's recording the frontend has actually been SENT.
///
/// This is the whole reason the handoff can be seamless, and why it lives in Rust rather than being
/// negotiated over IPC. The emitter holds this lock across the emit, so at any instant the value is
/// exactly "the last byte the frontend has been given". A reveal takes the same lock, reads the
/// recording up to that offset, and releases — so the replay ends precisely where the live stream
/// resumes. No gap to lose bytes in, no overlap to duplicate.
///
/// `None` while the pane has no recording (the recorder could not open), which a reveal reads as "no
/// history to replay" rather than as an error.
pub type Cursor = std::sync::Arc<std::sync::Mutex<Option<u64>>>;

/// Every live pane's cursor, keyed by pane id. Tauri-managed so a command can find one.
#[derive(Default)]
pub struct Cursors(pub std::sync::Mutex<std::collections::HashMap<String, Cursor>>);

impl Cursors {
    /// Register a fresh cursor for `pane_id`, replacing any stale one from a previous session with
    /// the same id — a relaunched pane starts its recording again and must not inherit an offset
    /// that addressed the old stream.
    pub fn register(&self, pane_id: &str) -> Cursor {
        let cur: Cursor = std::sync::Arc::new(std::sync::Mutex::new(None));
        if let Ok(mut m) = self.0.lock() {
            m.insert(pane_id.to_string(), cur.clone());
        }
        cur
    }

    pub fn get(&self, pane_id: &str) -> Option<Cursor> {
        self.0.lock().ok()?.get(pane_id).cloned()
    }

    pub fn remove(&self, pane_id: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(pane_id);
        }
    }
}

/// What a reveal hands back: the replay text, and the offset it ends at.
///
/// `upto` is returned rather than kept private because the frontend needs it to reconcile: once the
/// event payload carries offsets too, any live event at or before `upto` is already in `text` and can
/// be dropped. Until then it is the value that makes the handoff auditable.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reveal {
    pub text: String,
    pub upto: u64,
}

/// Choose where to start replaying so the result is at most `max_bytes` AND begins at a boundary.
///
/// `marks` are recorded replay points in ascending order; `len` is the recording's length.
///
/// OFFSET 0 IS ALWAYS LEGAL, and that is not a special case bolted on — a stream begins in the ground
/// state by definition, so the start of the file is the one boundary that needs no recording. It is
/// also the answer whenever the recording is small enough to replay whole, which is the common case
/// for a short-lived pane.
///
/// Otherwise this takes the SMALLEST mark that fits the budget, i.e. the most history the caller asked
/// to afford. When even the last mark does not fit — only possible when `max_bytes` is smaller than the
/// mark cadence — it returns that last mark anyway and OVERSHOOTS the budget. Overshooting is the right
/// failure: the alternative is starting mid-sequence, which is the corruption this whole mechanism
/// exists to prevent, and a caller's byte budget is a preference where a boundary is a correctness
/// requirement.
pub fn replay_start(marks: &[u64], len: u64, max_bytes: u64) -> u64 {
    if len <= max_bytes {
        return 0; // the whole recording fits; its start is inherently safe
    }
    // Marks at or past `len` are meaningless (a truncated or rewritten file) — ignore them rather
    // than hand back an offset past the end.
    let usable: Vec<u64> = marks.iter().copied().filter(|&m| m < len).collect();
    match usable.iter().copied().find(|&m| len - m <= max_bytes) {
        Some(m) => m,
        // Nothing fits: prefer the newest boundary we have over the file start, so a caller with a
        // tiny budget still gets a bounded (if over-budget) replay rather than the entire history.
        None => usable.last().copied().unwrap_or(0),
    }
}

/// Read a pane's recording between a safe start and `end`, at most `max_bytes` long.
///
/// `end` is what makes this different from [`read_tail`]: a reveal must stop exactly where the live
/// stream resumes, NOT at the current end of the file, or the bytes in between arrive twice.
pub fn read_upto(dir: &Path, pane_id: &str, end: u64, max_bytes: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let stem = safe_stem(pane_id);
    let mut f = File::open(dir.join(format!("{stem}.bin"))).ok()?;
    let base = read_base(dir, &stem);
    // Everything below is in ABSOLUTE stream offsets; only the seek converts to a file position.
    let end_abs = (base + f.metadata().ok()?.len()).min(end);
    if end_abs <= base {
        return Some(String::new()); // the whole window was trimmed past what the caller asked for
    }
    let start = replay_start(&read_marks(dir, &stem), end_abs, max_bytes).max(base);
    f.seek(SeekFrom::Start(start - base)).ok()?;
    let mut out = Vec::with_capacity((end_abs - start) as usize);
    f.take(end_abs - start).read_to_end(&mut out).ok()?;
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Read a pane's recorded tail, starting at a safe boundary, at most `max_bytes` long.
///
/// Returns the bytes as a lossy string: they are handed straight to a terminal, which is the one
/// consumer that wants them, and a partial UTF-8 character at either edge must not fail the read.
pub fn read_tail(dir: &Path, pane_id: &str, max_bytes: u64) -> Option<String> {
    let stem = safe_stem(pane_id);
    let end = read_base(dir, &stem) + File::open(dir.join(format!("{stem}.bin"))).ok()?.metadata().ok()?.len();
    // ONE mapping from absolute offsets to file positions, in `read_upto`. A second copy here is
    // exactly how the two would drift once trimming shifted a base.
    read_upto(dir, pane_id, end, max_bytes)
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

    #[test]
    fn a_recording_that_fits_replays_from_the_start() {
        // The start of a stream is a boundary by definition, so no mark is needed to use it.
        assert_eq!(replay_start(&[], 500, 1000), 0);
        assert_eq!(replay_start(&[100], 1000, 1000), 0, "exactly at budget still fits");
    }

    #[test]
    fn a_long_recording_takes_the_most_history_that_fits() {
        let marks = [100u64, 200, 300, 400];
        // len 1000, budget 650 → the smallest mark m with 1000-m <= 650 is 400.
        assert_eq!(replay_start(&marks, 1000, 650), 400);
        // A bigger budget reaches further back.
        assert_eq!(replay_start(&marks, 1000, 850), 200);
    }

    #[test]
    fn it_overshoots_the_budget_rather_than_starting_mid_sequence() {
        // THE PRIORITY, stated as a test: a byte budget is a preference, a boundary is correctness.
        // With no mark close enough, take the newest boundary and exceed the budget knowingly.
        assert_eq!(replay_start(&[100, 200], 1000, 10), 200);
        // With no marks at all there is only one boundary to have — the start.
        assert_eq!(replay_start(&[], 1_000_000, 10), 0);
    }

    #[test]
    fn marks_past_the_end_are_ignored() {
        // A truncated or rewritten recording must never yield an offset past its end.
        assert_eq!(replay_start(&[100, 5000], 1000, 500), 100);
        assert_eq!(replay_start(&[9999], 1000, 10), 0);
    }

    #[test]
    fn read_tail_round_trips_through_a_real_recording() {
        let dir = std::env::temp_dir().join(format!("sb-read-{}-{}", std::process::id(), now_nanos()));
        let mut r = ScrollbackRecorder::open(&dir, "p1").expect("opens");
        // Enough to force a mark, at a boundary, then a recognisable tail after it.
        r.write(&vec![b'a'; MARK_EVERY_BYTES as usize]);
        r.write(b"\x1b[32mTAIL\x1b[0m");
        drop(r);

        // A budget smaller than the tail-after-the-mark still starts at the mark, not mid-sequence.
        let small = read_tail(&dir, "p1", 4).expect("reads");
        assert!(small.starts_with("\x1b[32m"), "must begin at the boundary: {small:?}");
        assert!(small.contains("TAIL"));
        // A generous budget replays the whole thing.
        let all = read_tail(&dir, "p1", 10 * MARK_EVERY_BYTES).expect("reads");
        assert!(all.starts_with("aaa"), "the whole recording starts at its own beginning");
        assert!(all.ends_with("TAIL\x1b[0m"));
        // A pane that never recorded is absent, NOT an error — the caller shows a fresh terminal.
        assert!(read_tail(&dir, "never-ran", 1024).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reveal_stops_exactly_where_the_live_stream_resumes() {
        // THE SEAM, as a test. The recording runs ahead of what the frontend has been sent; a reveal
        // bounded by the cursor must return the sent part and NOTHING after it, or those bytes arrive
        // twice — once replayed, once live.
        let dir = std::env::temp_dir().join(format!("sb-seam-{}-{}", std::process::id(), now_nanos()));
        let mut r = ScrollbackRecorder::open(&dir, "p").expect("opens");
        r.write(b"SENT-");
        let sent = r.len(); // the cursor the emitter would publish
        r.write(b"NOT-YET");
        drop(r);

        let replay = read_upto(&dir, "p", sent, 1024).expect("reads");
        assert_eq!(replay, "SENT-", "a reveal must not include bytes still to arrive live");

        // …while an unbounded tail read DOES see them, so the bound is what is doing the work here
        // and not some accident of the recording.
        assert_eq!(read_tail(&dir, "p", 1024).as_deref(), Some("SENT-NOT-YET"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cursor_is_replaced_when_a_pane_id_is_reused() {
        // A relaunched pane records afresh; inheriting the old offset would bound its first reveal by
        // a number that addressed a different stream.
        let cs = Cursors::default();
        let first = cs.register("pane");
        *first.lock().unwrap() = Some(4096);
        let second = cs.register("pane");
        assert_eq!(*second.lock().unwrap(), None, "a re-registered pane starts with no cursor");
        assert_eq!(*cs.get("pane").unwrap().lock().unwrap(), None);
        cs.remove("pane");
        assert!(cs.get("pane").is_none(), "an exited pane leaves nothing in the map");
    }

    /// Drive a recorder past the cap and return its directory + the offsets it ends up holding.
    fn recorder_over_cap(tag: &str) -> (PathBuf, u64) {
        let dir = std::env::temp_dir().join(format!("sb-{tag}-{}-{}", std::process::id(), now_nanos()));
        let mut r = ScrollbackRecorder::open(&dir, "p").expect("opens");
        // Write in mark-sized, boundary-clean blocks so marks accrue, well past the cap.
        let block = vec![b'z'; MARK_EVERY_BYTES as usize];
        for _ in 0..(MAX_RECORDING_BYTES / MARK_EVERY_BYTES + 4) {
            r.write(&block);
        }
        let written = r.len();
        drop(r);
        (dir, written)
    }

    #[test]
    fn a_recording_is_trimmed_once_it_passes_the_cap() {
        let (dir, written) = recorder_over_cap("trim");
        let bin = std::fs::metadata(dir.join("p.bin")).unwrap().len();
        assert!(bin <= MAX_RECORDING_BYTES + TRIM_SLACK_BYTES, "window {bin} should be capped");
        assert!(bin > 0);
        // The stream position kept going even though the file shrank — that is the whole point.
        assert!(written > bin, "absolute offsets outrun the retained window");
        let base: u64 = std::fs::read_to_string(dir.join("p.base")).unwrap().trim().parse().unwrap();
        assert_eq!(base + bin, written, "base + window must account for every byte ever written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_offset_still_inside_the_window_names_the_same_bytes_after_a_trim() {
        // THE HAZARD this design exists to avoid. A cursor published to the frontend is an ABSOLUTE
        // offset. If a trim renumbered things, that number would silently start addressing different
        // bytes — a corruption nobody could see until they read the scrollback.
        //
        // Note what is NOT claimed: an offset the trim DISCARDED is gone, and must read as empty (its
        // own test below). The invariant is about offsets the window still covers.
        let dir = std::env::temp_dir().join(format!("sb-abs-{}-{}", std::process::id(), now_nanos()));
        let mut r = ScrollbackRecorder::open(&dir, "p").expect("opens");
        let block = vec![b'q'; MARK_EVERY_BYTES as usize];
        for _ in 0..(MAX_RECORDING_BYTES / MARK_EVERY_BYTES + 4) {
            r.write(&block);
        }
        let base_after_trim: u64 = std::fs::read_to_string(dir.join("p.base")).unwrap().trim().parse().unwrap();
        assert!(base_after_trim > 0, "the setup must actually have trimmed");

        // An offset taken AFTER the trim, i.e. one the window covers.
        r.write(b"MARKER");
        let at = r.len();
        let before = read_upto(&dir, "p", at, 32).expect("reads");
        assert!(before.ends_with("MARKER"), "reads through the base mapping: {before:?}");

        // More output, no further trim — the base is unchanged and `at` must still mean what it did.
        r.write(b"tail after the marker");
        drop(r);
        let after = read_upto(&dir, "p", at, 32).expect("still reads");
        assert_eq!(before, after, "the same absolute offset must still name the same bytes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_trim_only_ever_cuts_at_a_recorded_boundary() {
        // Cutting anywhere else would leave the window starting mid-sequence — the exact corruption
        // this module replaces, reintroduced by its own housekeeping.
        let (dir, _) = recorder_over_cap("cut");
        let base: u64 = std::fs::read_to_string(dir.join("p.base")).unwrap().trim().parse().unwrap();
        // Every retained mark is >= base, and base is itself one of the marks that WAS recorded.
        let marks = read_marks(&dir, "p");
        assert!(base > 0);
        assert!(marks.iter().all(|&m| m >= base), "marks before the cut are dropped");
        assert_eq!(base % MARK_EVERY_BYTES, 0, "the cut landed on a mark, not an arbitrary offset");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_offset_below_the_base_reads_as_empty_not_as_garbage() {
        // A cursor older than the retained window is history that is simply gone. Returning the wrong
        // bytes would be far worse than returning none.
        let (dir, _) = recorder_over_cap("old");
        let stale = 16u64; // long since trimmed away
        assert_eq!(read_upto(&dir, "p", stale, 1024).as_deref(), Some(""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn now_nanos() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }
}
