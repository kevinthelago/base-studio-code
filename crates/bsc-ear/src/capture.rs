//! The microphone, the wav files, and the loop between them.
//!
//! Everything that DECIDES anything lives in [`crate::segment`] and [`crate::retention`]; this is
//! the plumbing that feeds them. Kept deliberately thin for that reason — the parts of an always-on
//! ear that can be wrong in an interesting way should not need a room to be quiet in to observe.

use crate::audio::{self, PreRoll, TARGET_HZ};
use crate::retention::{self, Budget, HeldSegment};
use crate::segment::{Segmenter, VadConfig, VadEvent};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Silences file descriptor 2 for as long as it is alive, and restores it on drop.
///
/// ALSA writes its own diagnostics straight to stderr through a handler this process does not own —
/// enumerating capture devices on this machine produces 24 lines of `pcm_dmix.c: The dmix plugin
/// supports only playback stream` before a single device is printed. They are true, they are not
/// ours, and they are not actionable: they say that some of the nodes ALSA offers cannot capture,
/// which is precisely what enumeration is for finding out.
///
/// Restoring in `Drop` matters more than the silence does. An early return or a panic between the
/// redirect and the restore would leave the whole process with stderr pointed at /dev/null, so
/// every later error message would vanish — a far worse failure than the noise being fixed.
struct HushStderr {
    saved: Option<libc::c_int>,
}

impl HushStderr {
    fn new() -> Self {
        // SAFETY: dup/open/dup2 on fd 2 with a null-terminated literal path. The original fd is
        // kept and restored in Drop; on any failure we simply do not redirect.
        unsafe {
            let saved = libc::dup(libc::STDERR_FILENO);
            if saved < 0 {
                return HushStderr { saved: None };
            }
            let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
            if devnull < 0 {
                libc::close(saved);
                return HushStderr { saved: None };
            }
            libc::dup2(devnull, libc::STDERR_FILENO);
            libc::close(devnull);
            HushStderr { saved: Some(saved) }
        }
    }
}

impl Drop for HushStderr {
    fn drop(&mut self) {
        if let Some(saved) = self.saved.take() {
            // SAFETY: `saved` is a live descriptor this type dup'd and has not closed.
            unsafe {
                libc::dup2(saved, libc::STDERR_FILENO);
                libc::close(saved);
            }
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct DeviceInfo {
    pub name: String,
    pub default: bool,
    pub channels: u16,
    pub sample_rate: u32,
}

/// Every capture device, with the default marked.
pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    let _hush = HushStderr::new();
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let devices = host.input_devices().map_err(|e| format!("could not enumerate capture devices: {e}"))?;
    let mut out = Vec::new();
    for d in devices {
        let Ok(name) = d.name() else { continue };
        // A device that cannot report a config is listed anyway, with zeroes, rather than dropped:
        // an input missing from the list looks like an input that is not plugged in.
        let (channels, sample_rate) = match d.default_input_config() {
            Ok(c) => (c.channels(), c.sample_rate().0),
            Err(_) => (0, 0),
        };
        out.push(DeviceInfo { default: Some(&name) == default_name.as_ref(), name, channels, sample_rate });
    }
    Ok(out)
}

/// How the ear is set up for one run.
#[derive(Clone, Debug)]
pub struct CaptureConfig {
    /// A device name; `None` takes the system default.
    pub device: Option<String>,
    pub vad: VadConfig,
    pub budget: Budget,
    /// Where segments are written.
    pub dir: PathBuf,
    /// Touched periodically so `bsc ear status` can tell a live daemon from a stale pid file.
    pub heartbeat: Option<PathBuf>,
    /// Where the daemon publishes what it is actually hearing, so `status` can report a dead input
    /// rather than a confident LISTENING about a microphone that is delivering silence.
    pub state: Option<PathBuf>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize)]
pub struct Progress {
    pub kept: u64,
    pub discarded: u64,
    pub evicted: u64,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Recover a segment's start time from its name: `seg-<unix_ms>-<seq>.wav`.
///
/// Split at the FIRST `-` after the prefix, never parsed whole — the sequence suffix is part of the
/// name and parsing it as digits of the timestamp yields an epoch a thousand years wide. Returns
/// `None` for anything that does not match, so the caller can fall back rather than invent a date.
pub fn parse_started_ms(name: &str) -> Option<i64> {
    let rest = name.strip_prefix("seg-")?.strip_suffix(".wav")?;
    let stamp = rest.split('-').next()?;
    stamp.parse::<i64>().ok()
}

/// Segments currently on disk, for the retention pass.
pub fn held_segments(dir: &Path) -> Vec<HeldSegment> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    rd.filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            if !name.ends_with(".wav") {
                return None;
            }
            let md = e.metadata().ok()?;
            // The name carries the start time; the mtime is when writing FINISHED, which for a long
            // segment is a different number and the wrong one to age it by.
            let started = parse_started_ms(&name)
                .unwrap_or_else(|| {
                    md.modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0)
                });
            Some(HeldSegment { name, bytes: md.len(), started_unix_ms: started })
        })
        .collect()
}

/// Apply the retention plan. Returns how many files went.
pub fn sweep(dir: &Path, budget: &Budget, protect: Option<&str>) -> u64 {
    let plan = retention::plan_eviction(now_ms(), &held_segments(dir), budget, protect);
    let mut gone = 0;
    for e in &plan.delete {
        if std::fs::remove_file(dir.join(&e.name)).is_ok() {
            gone += 1;
        }
    }
    gone
}

/// What the daemon is hearing, for `bsc ear status`.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct LiveState {
    pub device: String,
    pub noise_floor: f32,
    /// The input is delivering digital silence — muted, unplugged, or routed to nothing.
    pub input_dead: bool,
    pub warming: bool,
    pub kept: u64,
    pub discarded: u64,
}

fn publish_state(cfg: &CaptureConfig, seg: &Segmenter, device: &str, p: &Progress) {
    let Some(path) = &cfg.state else { return };
    let st = LiveState {
        device: device.to_string(),
        noise_floor: seg.noise_floor(),
        input_dead: seg.input_looks_dead(),
        warming: seg.is_warming(),
        kept: p.kept,
        discarded: p.discarded,
    };
    if let Ok(json) = serde_json::to_string(&st) {
        let _ = std::fs::write(path, json);
    }
}

/// Listen to one device briefly and report its RMS.
///
/// The verb that uses this exists because of a measured surprise on this machine: the SYSTEM DEFAULT
/// capture device delivers silence, as do the USB interface and the headset, while only the onboard
/// input is live. Nothing in an enumeration says which of those is true, so an always-on ear pointed
/// at the default would report LISTENING and hear nothing, forever.
/// `cpal::SampleFormat` is non_exhaustive with nine variants, all handled identically here — by
/// refusing, and naming the format refused. The crate denies `wildcard_enum_match_arm` on purpose;
/// enumerating nine variants to reach one outcome, and still needing a catch-all, is the case the
/// deny is not for.
pub fn probe_level(name: Option<&str>, ms: u64) -> Result<(String, f32), String> {
    let _hush = HushStderr::new();
    let host = cpal::default_host();
    let device = match name {
        Some(want) => host
            .input_devices()
            .map_err(|e| format!("{e}"))?
            .find(|d| d.name().map(|n| n == *want).unwrap_or(false))
            .ok_or_else(|| format!("no capture device named '{want}'"))?,
        None => host.default_input_device().ok_or("no default capture device")?,
    };
    probe_device(&device, ms)
}

/// `cpal::SampleFormat` is non_exhaustive with nine variants, all handled identically here — by
/// refusing, and naming the format refused. The crate denies `wildcard_enum_match_arm` on purpose;
/// enumerating nine variants to reach one outcome, and still needing a catch-all, is the case the
/// deny is not for.
#[allow(clippy::wildcard_enum_match_arm)]
fn probe_device(device: &cpal::Device, ms: u64) -> Result<(String, f32), String> {
    let dname = device.name().unwrap_or_else(|_| "<unnamed>".into());
    let supported = device.default_input_config().map_err(|e| format!("{e}"))?;
    let channels = supported.channels();
    let fmt = supported.sample_format();
    let stream_cfg: cpal::StreamConfig = supported.into();
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let quiet = |_| {};
    let stream = match fmt {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_cfg,
            move |d: &[f32], _: &_| { let _ = tx.send(d.to_vec()); },
            quiet,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_cfg,
            move |d: &[i16], _: &_| { let _ = tx.send(d.iter().map(|s| *s as f32 / i16::MAX as f32).collect()); },
            quiet,
            None,
        ),
        other => return Err(format!("{dname} captures as {other:?}, which this build does not convert")),
    }
    .map_err(|e| format!("could not open {dname}: {e}"))?;
    stream.play().map_err(|e| format!("could not start {dname}: {e}"))?;
    let deadline = std::time::Instant::now() + Duration::from_millis(ms);
    let mut all: Vec<f32> = Vec::new();
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(c) => all.extend(audio::to_mono(&c, channels)),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(stream);
    Ok((dname, audio::rms(&all)))
}

/// The frame → segment → wav path, with no microphone anywhere in it.
///
/// Extracted from [`run`] deliberately. The interesting half of capture is what happens between a
/// frame arriving and a file existing, and tying that to a live device makes it testable only on a
/// machine with a working microphone — which, measured on this one, is not a safe assumption: three
/// of its four inputs deliver digital silence. A caller pushes frames; this decides and writes.
pub struct Recorder {
    seg: Segmenter,
    preroll: PreRoll,
    writer: Option<(hound::WavWriter<std::io::BufWriter<std::fs::File>>, String)>,
    /// Samples written into the open file. The segmenter's span and the file's length are NOT the
    /// same number: the file also carries the pre-roll at the front and the hangover at the tail,
    /// which is deliberate — a model transcribes a phrase better with its run-up and run-out — but
    /// it means reporting the segmenter's span would describe a file that does not exist. Measured
    /// on a 1.5s utterance: span 1.5s, file 2.4s.
    written: u64,
    dir: PathBuf,
    budget: Budget,
    progress: Progress,
    seq: u64,
}

/// What one pushed frame caused.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Recorded {
    Opened(String),
    Kept { name: String, ms: u64 },
    Discarded { ms: u64 },
}

impl Recorder {
    pub fn new(dir: PathBuf, vad: VadConfig, budget: Budget) -> Result<Self, String> {
        vad.validate()?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let preroll = PreRoll::new(vad.preroll_ms);
        Ok(Recorder {
            seg: Segmenter::new(vad)?,
            preroll,
            writer: None,
            written: 0,
            dir,
            budget,
            progress: Progress::default(),
            seq: 0,
        })
    }

    pub fn segmenter(&self) -> &Segmenter {
        &self.seg
    }

    pub fn progress(&self) -> Progress {
        self.progress
    }

    /// Milliseconds of audio actually written into the open file.
    fn written_ms(&self) -> u64 {
        (self.written * 1000) / u64::from(TARGET_HZ)
    }

    /// A name that sorts and ages correctly even when two segments open inside the same
    /// millisecond — which a synthetic stream does constantly and a real one does eventually.
    ///
    /// THE SEPARATOR IS LOAD-BEARING. Without it the sequence is CONCATENATED onto the timestamp:
    /// `seg-1788616309803` + `001` parses back as 1788616309803001, a thousand times the real
    /// epoch, and every age computed from it comes out as -29,780,461,557 minutes. Measured on the
    /// first live capture — and the collision test passed throughout, because it only asserted that
    /// two names differ.
    fn next_name(&mut self) -> String {
        self.seq += 1;
        format!("seg-{}-{:03}.wav", now_ms(), self.seq % 1000)
    }

    pub fn push_frame(&mut self, frame: &[f32]) -> Result<Option<Recorded>, String> {
        let level = audio::rms(frame);
        let event = self.seg.push(level);
        let out = match event {
            Some(VadEvent::Open { .. }) => {
                let fname = self.next_name();
                let mut w = hound::WavWriter::create(self.dir.join(&fname), spec())
                    .map_err(|e| format!("could not open {fname}: {e}"))?;
                let held = self.preroll.drain();
                self.written = held.len() as u64;
                for s in held {
                    w.write_sample(audio::to_i16(s)).map_err(|e| e.to_string())?;
                }
                self.writer = Some((w, fname.clone()));
                Some(Recorded::Opened(fname))
            }
            Some(VadEvent::Close { .. }) => match self.writer.take() {
                Some((w, fname)) => {
                    w.finalize().map_err(|e| format!("could not finalize {fname}: {e}"))?;
                    self.progress.kept += 1;
                    let ms = self.written_ms();
                    self.progress.evicted += sweep(&self.dir, &self.budget, Some(&fname));
                    Some(Recorded::Kept { name: fname, ms })
                }
                None => None,
            },
            Some(VadEvent::Discard { start_ms, end_ms }) => match self.writer.take() {
                Some((w, fname)) => {
                    let _ = w.finalize();
                    let _ = std::fs::remove_file(self.dir.join(&fname));
                    self.progress.discarded += 1;
                    Some(Recorded::Discarded { ms: end_ms.saturating_sub(start_ms) })
                }
                None => None,
            },
            None => None,
        };
        // AFTER the event, so a frame is either in the pre-roll or in the file — never both, never
        // neither. Getting this order wrong duplicates the pre-roll into every segment.
        match &mut self.writer {
            Some((w, _)) => {
                for s in frame {
                    w.write_sample(audio::to_i16(*s)).map_err(|e| e.to_string())?;
                }
                self.written += frame.len() as u64;
            }
            None => self.preroll.push(frame),
        }
        Ok(out)
    }

    /// End of stream: keep or drop whatever is open, so shutting down mid-sentence is not a silent
    /// loss.
    pub fn finish(&mut self) -> Result<Option<Recorded>, String> {
        let event = self.seg.finish();
        let Some((w, fname)) = self.writer.take() else { return Ok(None) };
        match event {
            Some(VadEvent::Close { .. }) => {
                w.finalize().map_err(|e| format!("could not finalize {fname}: {e}"))?;
                self.progress.kept += 1;
                Ok(Some(Recorded::Kept { name: fname, ms: self.written_ms() }))
            }
            Some(VadEvent::Discard { start_ms, end_ms }) => {
                let _ = w.finalize();
                let _ = std::fs::remove_file(self.dir.join(&fname));
                self.progress.discarded += 1;
                Ok(Some(Recorded::Discarded { ms: end_ms.saturating_sub(start_ms) }))
            }
            // A file open with no closing event means the segmenter and the writer disagree about
            // whether anything was being recorded. Drop it: a truncated wav that nothing can
            // account for is worse than no wav.
            Some(VadEvent::Open { .. }) | None => {
                let _ = w.finalize();
                let _ = std::fs::remove_file(self.dir.join(&fname));
                self.progress.discarded += 1;
                Ok(Some(Recorded::Discarded { ms: 0 }))
            }
        }
    }
}

fn spec() -> hound::WavSpec {
    hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_HZ,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    }
}

/// Listen until `stop` returns true.
///
/// `on_event` receives one human line per boundary, so the foreground form is legible and the
/// daemon's log says what it heard.
/// `cpal::SampleFormat` is non_exhaustive with nine variants, all handled identically here — by
/// refusing, and naming the format refused. The crate denies `wildcard_enum_match_arm` on purpose;
/// enumerating nine variants to reach one outcome, and still needing a catch-all, is the case the
/// deny is not for.
#[allow(clippy::wildcard_enum_match_arm)]
pub fn run(
    cfg: &CaptureConfig,
    stop: &dyn Fn() -> bool,
    on_event: &mut dyn FnMut(String),
) -> Result<Progress, String> {
    cfg.vad.validate()?;
    std::fs::create_dir_all(&cfg.dir).map_err(|e| format!("could not create {}: {e}", cfg.dir.display()))?;

    let host = cpal::default_host();
    let device = match &cfg.device {
        Some(want) => host
            .input_devices()
            .map_err(|e| format!("could not enumerate capture devices: {e}"))?
            .find(|d| d.name().map(|n| n == *want).unwrap_or(false))
            .ok_or_else(|| format!("no capture device named '{want}' — `bsc ear devices` lists them"))?,
        None => host
            .default_input_device()
            .ok_or("this machine reports no default capture device")?,
    };
    let name = device.name().unwrap_or_else(|_| "<unnamed>".into());
    let supported = device
        .default_input_config()
        .map_err(|e| format!("could not read the config for '{name}': {e}"))?;
    let channels = supported.channels();
    let in_hz = supported.sample_rate().0;
    let fmt = supported.sample_format();
    let stream_cfg: cpal::StreamConfig = supported.into();

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let err_fn = |e| eprintln!("bsc ear: capture stream error: {e}");
    // The callback must not block or allocate much: it runs on the audio thread, and stalling it
    // drops samples with no error anywhere. It converts to f32 and hands off, nothing more.
    let stream = match fmt {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_cfg,
            move |data: &[f32], _: &_| {
                let _ = tx.send(data.to_vec());
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_cfg,
            move |data: &[i16], _: &_| {
                let _ = tx.send(data.iter().map(|s| *s as f32 / i16::MAX as f32).collect());
            },
            err_fn,
            None,
        ),
        other => {
            return Err(format!(
                "'{name}' captures as {other:?}, which this build does not convert — f32 and i16 are \
                 handled. Pick another device with --device (`bsc ear devices`)."
            ))
        }
    }
    .map_err(|e| format!("could not open '{name}': {e}"))?;
    stream.play().map_err(|e| format!("could not start '{name}': {e}"))?;
    on_event(format!("listening on '{name}' ({channels}ch @ {in_hz}Hz → mono @ {TARGET_HZ}Hz)"));

    let mut rec = Recorder::new(cfg.dir.clone(), cfg.vad.clone(), cfg.budget)?;
    let mut pending: Vec<f32> = Vec::new();
    let flen = audio::frame_len(cfg.vad.frame_ms);
    let mut last_beat = std::time::Instant::now();
    let mut warned_warm = false;
    if let Some(beat) = &cfg.heartbeat {
        let _ = std::fs::write(beat, now_ms().to_string());
    }
    publish_state(cfg, rec.segmenter(), &name, &rec.progress());

    while !stop() {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => {
                let mono = audio::to_mono(&chunk, channels);
                pending.extend(audio::resample_linear(&mono, in_hz, TARGET_HZ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("the capture stream ended unexpectedly".into())
            }
        }
        while pending.len() >= flen {
            let frame: Vec<f32> = pending.drain(..flen).collect();
            if let Some(r) = rec.push_frame(&frame)? {
                match r {
                    Recorded::Opened(_) => on_event("speech".to_string()),
                    Recorded::Kept { name, ms } => on_event(format!("kept {name} ({ms}ms)")),
                    Recorded::Discarded { ms } => on_event(format!("discarded a {ms}ms blip")),
                }
            }
            if !warned_warm && !rec.segmenter().is_warming() {
                warned_warm = true;
                let floor = rec.segmenter().noise_floor();
                on_event(format!("warm — noise floor {floor:.5}"));
                if rec.segmenter().input_looks_dead() {
                    on_event(
                        "WARNING: this input is delivering digital silence. It is not a quiet room — \
                         `bsc ear levels` shows which device actually hears."
                            .to_string(),
                    );
                }
            }
        }
        if let Some(beat) = &cfg.heartbeat {
            if last_beat.elapsed() >= Duration::from_secs(5) {
                let _ = std::fs::write(beat, now_ms().to_string());
                publish_state(cfg, rec.segmenter(), &name, &rec.progress());
                last_beat = std::time::Instant::now();
            }
        }
    }

    if let Some(Recorded::Kept { name, .. }) = rec.finish()? {
        on_event(format!("kept {name} (closed at shutdown)"));
    }
    let mut progress = rec.progress();
    drop(stream);
    progress.evicted += sweep(&cfg.dir, &cfg.budget, None);
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUIET: f32 = 0.004;
    const LOUD: f32 = 0.15;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tmp(tag: &str) -> Tmp {
        let p = std::env::temp_dir()
            .join(format!("bsc-ear-cap-{tag}-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&p);
        Tmp(p)
    }

    fn rec_in(dir: &Path) -> Recorder {
        Recorder::new(dir.to_path_buf(), VadConfig::default(), Budget::default()).unwrap()
    }

    /// Push `ms` of a constant level, returning everything it caused.
    fn feed(r: &mut Recorder, level: f32, ms: u32) -> Vec<Recorded> {
        let flen = audio::frame_len(20);
        let frame = vec![level; flen];
        (0..ms / 20).filter_map(|_| r.push_frame(&frame).expect("writing must not fail")).collect()
    }

    fn wavs(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|n| n.ends_with(".wav"))
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    /// THE WHOLE PATH, with no microphone in it: frames in, a real wav out, at the right spec and a
    /// plausible length. This machine has no working capture device — three of its four inputs
    /// deliver digital silence — so an acoustic test would have been a test of the room, not of this.
    #[test]
    fn one_utterance_becomes_exactly_one_readable_wav() {
        let t = tmp("one");
        let mut r = rec_in(&t.0);
        feed(&mut r, QUIET, 4_000); // warm up and learn the room
        assert!(wavs(&t.0).is_empty(), "silence writes nothing");

        feed(&mut r, LOUD, 2_000);
        let events = feed(&mut r, QUIET, 2_000);

        let files = wavs(&t.0);
        assert_eq!(files.len(), 1, "one utterance, one file: {files:?}");
        assert!(
            events.iter().any(|e| matches!(e, Recorded::Kept { .. })),
            "and it was reported as kept: {events:?}"
        );
        assert_eq!(r.progress().kept, 1);

        let reader = hound::WavReader::open(t.0.join(&files[0])).expect("a real, readable wav");
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, TARGET_HZ, "16 kHz, as the next slice's model requires");
        assert_eq!(spec.channels, 1, "mono");
        let secs = reader.duration() as f32 / spec.sample_rate as f32;
        assert!(secs > 1.5 && secs < 3.5, "about the length of the utterance, got {secs}s");
    }

    /// The pre-roll must appear ONCE, at the front. Pushing the frame before the event instead of
    /// after would write it into the file and leave it in the ring, duplicating it into the next
    /// segment too — audible as a stutter and invisible to any test that only counts files.
    #[test]
    fn the_preroll_lands_in_the_first_segment_and_is_not_reused_by_the_second() {
        let t = tmp("preroll");
        let mut r = rec_in(&t.0);
        feed(&mut r, QUIET, 4_000);
        feed(&mut r, LOUD, 1_500);
        feed(&mut r, QUIET, 2_000);
        feed(&mut r, LOUD, 1_500);
        feed(&mut r, QUIET, 2_000);

        let files = wavs(&t.0);
        assert_eq!(files.len(), 2, "{files:?}");
        for f in &files {
            let reader = hound::WavReader::open(t.0.join(f)).unwrap();
            let secs = reader.duration() as f32 / TARGET_HZ as f32;
            // 1.5s speech + at most 0.3s pre-roll + the 0.7s hangover the file also carries.
            // A pre-roll duplicated into a later segment would push this over.
            assert!(secs < 2.6, "{f} is {secs}s — more than pre-roll + speech + hangover");
            assert!(secs > 1.5, "{f} is {secs}s — the speech itself is missing");
        }
    }

    /// The reported duration must describe the file that exists. They diverged: the segmenter's
    /// span excludes the pre-roll and the hangover, while the file carries both — measured 1.5s
    /// against 2.4s on the same segment. A consumer reading one and opening the other would
    /// disagree with itself.
    #[test]
    fn the_reported_duration_is_the_duration_of_the_file_on_disk() {
        let t = tmp("dur");
        let mut r = rec_in(&t.0);
        feed(&mut r, QUIET, 4_000);
        feed(&mut r, LOUD, 2_000);
        let events = feed(&mut r, QUIET, 2_000);
        let Some(Recorded::Kept { name, ms }) =
            events.into_iter().find(|e| matches!(e, Recorded::Kept { .. }))
        else {
            panic!("expected a kept segment");
        };
        let reader = hound::WavReader::open(t.0.join(&name)).unwrap();
        let file_ms = (reader.duration() as u64 * 1000) / TARGET_HZ as u64;
        assert!(
            ms.abs_diff(file_ms) <= 40,
            "reported {ms}ms but the file is {file_ms}ms"
        );
    }

    #[test]
    fn a_blip_leaves_no_file_behind() {
        let t = tmp("blip");
        let mut r = rec_in(&t.0);
        feed(&mut r, QUIET, 4_000);
        let events = feed(&mut r, LOUD, 200);
        feed(&mut r, QUIET, 2_000);
        assert!(wavs(&t.0).is_empty(), "the partial file must be removed, not orphaned");
        assert_eq!(r.progress().discarded, 1);
        assert!(events.iter().any(|e| matches!(e, Recorded::Opened(_))), "it did open one: {events:?}");
    }

    #[test]
    fn shutting_down_mid_sentence_keeps_it() {
        let t = tmp("finish");
        let mut r = rec_in(&t.0);
        feed(&mut r, QUIET, 4_000);
        feed(&mut r, LOUD, 2_000);
        assert_eq!(wavs(&t.0).len(), 1, "the file exists while open");
        let out = r.finish().unwrap();
        assert!(matches!(out, Some(Recorded::Kept { .. })), "kept at shutdown: {out:?}");
        assert_eq!(wavs(&t.0).len(), 1);
        assert!(hound::WavReader::open(t.0.join(&wavs(&t.0)[0])).is_ok(), "and it was finalized");
    }

    /// The bound has to hold against the real filesystem, not only in the pure planner. A tiny
    /// budget with several utterances must leave the newest and delete the rest.
    #[test]
    fn the_retention_bound_is_enforced_against_real_files_on_disk() {
        let t = tmp("evict");
        let mut r = Recorder::new(
            t.0.clone(),
            VadConfig::default(),
            // Room for roughly one 2s segment (2s at 32,000 B/s = 64 kB).
            // Room for about two segments: each is pre-roll + 2s speech + hangover at 32 kB/s.
            Budget { max_bytes: 200_000, max_age_ms: 60 * 60 * 1000 },
        )
        .unwrap();
        feed(&mut r, QUIET, 4_000);
        for _ in 0..4 {
            feed(&mut r, LOUD, 2_000);
            feed(&mut r, QUIET, 2_000);
        }
        let held: u64 = held_segments(&t.0).iter().map(|s| s.bytes).sum();
        assert!(held <= 200_000, "the bound must hold on disk, {held} bytes remain");
        assert!(!wavs(&t.0).is_empty(), "but it must not delete everything");
        assert!(r.progress().evicted > 0, "and it must say it evicted something");
    }

    #[test]
    fn held_segments_ages_by_the_name_not_the_mtime() {
        let t = tmp("age");
        std::fs::create_dir_all(&t.0).unwrap();
        std::fs::write(t.0.join("seg-1700000000123-001.wav"), b"x").unwrap();
        std::fs::write(t.0.join("notes.txt"), b"x").unwrap();
        let held = held_segments(&t.0);
        assert_eq!(held.len(), 1, "only wavs count");
        assert_eq!(
            held[0].started_unix_ms, 1_700_000_000_123,
            "the name carries the START; the mtime is when writing FINISHED"
        );
    }

    #[test]
    fn two_segments_opening_in_the_same_millisecond_do_not_collide() {
        let t = tmp("collide");
        let mut r = rec_in(&t.0);
        let a = r.next_name();
        let b = r.next_name();
        assert_ne!(a, b, "a synthetic stream opens segments far faster than the clock ticks");
    }

    /// THE BUG THE COLLISION TEST DID NOT CATCH, because it only asserted that two names differ.
    /// The sequence was concatenated onto the timestamp, so `seg-1788616309803001.wav` parsed back
    /// as a thousand times the real epoch and `bsc ear status` reported "-29780461557 minutes back".
    /// A name has to survive the round trip, not merely be unique.
    #[test]
    fn a_segment_name_round_trips_to_the_time_it_actually_started() {
        let t = tmp("roundtrip");
        let mut r = rec_in(&t.0);
        let before = now_ms();
        let name = r.next_name();
        let after = now_ms();

        let parsed = parse_started_ms(&name).expect("the name must carry a readable start time");
        assert!(
            parsed >= before && parsed <= after,
            "{name} parsed to {parsed}, outside the {before}..{after} window it was made in"
        );
        // The symptom as the user saw it: an age in minutes that is neither negative nor absurd.
        let age_min = (now_ms() - parsed) / 60_000;
        assert!((0..2).contains(&age_min), "age came out as {age_min} minutes");

        assert_eq!(parse_started_ms("notes.txt"), None, "a non-segment yields no date");
        assert_eq!(parse_started_ms("seg-notanumber-001.wav"), None);
        assert_eq!(parse_started_ms("seg-1700000000123-004.wav"), Some(1_700_000_000_123));
    }
}
