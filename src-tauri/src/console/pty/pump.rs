// The PTY IO pump: a reader thread decodes PTY bytes into complete UTF-8 chunks and
// an emitter thread coalesces them into ~one frontend event per 16ms frame (teeing to
// the mobile tunnel when paired). Split out of `mod.rs` (#1864); behavior is unchanged.

use crate::mobile::tunnel;
use crate::split_utf8_at_boundary;
use std::io::Read;
use tauri::{AppHandle, Emitter, Manager};

/// Reader thread: decode PTY bytes and forward complete UTF-8 chunks over `tx`. The `leftover` buffer
/// holds any trailing incomplete multi-byte sequence (e.g. ✓, →, box-drawing) so we never split a
/// character across reads. Exits on EOF/error or when the emitter is gone; flushes any tail first so
/// `tx` dropping signals the emitter (Disconnected) to finish.
pub(super) fn spawn_reader(
    pane_id: String,
    mut reader: Box<dyn Read + Send>,
    tx: std::sync::mpsc::Sender<String>,
) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => { log::info!("pty[{pane_id}] reader EOF"); break; }
                Err(e) => { log::warn!("pty[{pane_id}] reader error: {e}"); break; }
                Ok(n) => {
                    leftover.extend_from_slice(&buf[..n]);
                    let (text, keep) = split_utf8_at_boundary(&leftover);
                    leftover = keep;
                    if !text.is_empty() && tx.send(text).is_err() {
                        break; // emitter gone
                    }
                }
            }
        }
        if !leftover.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&leftover).into_owned());
        }
        // tx drops here → emitter sees Disconnected and finishes.
    });
}

/// Emitter thread: batch reader chunks and emit at most once per ~16ms frame to the frontend (and tee
/// to the mobile tunnel when paired). Coalescing collapses per-read emits — the dominant UI-lag source
/// when many sessions stream at once — into one event per frame per session. Emits `pty_exit_<pane>`
/// when the reader's `tx` disconnects.
pub(super) fn spawn_emitter(
    pane_id: String,
    app: AppHandle,
    rx: std::sync::mpsc::Receiver<String>,
) {
    std::thread::spawn(move || {
        use std::sync::mpsc::RecvTimeoutError;
        use std::time::{Duration, Instant};
        const FLUSH: Duration = Duration::from_millis(16);
        const MAX_PENDING: usize = 64 * 1024;
        let evt = format!("pty_data_{}", pane_id);
        // Tee PTY output to the mobile tunnel (#242) when a client is connected.
        // Looked up once; `broadcast_output` is a no-op while nobody is paired.
        let tunnel_state = app.try_state::<tunnel::TunnelState>();
        let mut pending = String::new();
        let mut last_emit = Instant::now();
        let mut total: u64 = 0;
        // Rolling window to flag sustained output floods.
        let mut win_start = Instant::now();
        let mut win_bytes: u64 = 0;
        let mut win_emits: u64 = 0;
        let mut done = false;
        while !done {
            let mut flush_now = false;
            match rx.recv_timeout(FLUSH) {
                Ok(chunk) => {
                    total += chunk.len() as u64;
                    win_bytes += chunk.len() as u64;
                    pending.push_str(&chunk);
                    if pending.len() >= MAX_PENDING || last_emit.elapsed() >= FLUSH {
                        flush_now = true;
                    }
                }
                // Idle for a frame — flush trailing output (e.g. the prompt) now.
                Err(RecvTimeoutError::Timeout) => flush_now = true,
                Err(RecvTimeoutError::Disconnected) => { flush_now = true; done = true; }
            }
            if flush_now && !pending.is_empty() {
                let data = std::mem::take(&mut pending);
                if let Some(ts) = &tunnel_state {
                    ts.broadcast_output(&pane_id, &data);
                }
                // Best-effort runtime-fault side-tap (#2264): scan this batch for stack traces / panics
                // / ERROR lines when the pane is marked an app-runner. Additive — it only BORROWS the
                // bytes here (before the move into `app.emit`), so the WebView/tunnel stream is
                // byte-for-byte unchanged; a no-op (one atomic load) when no pane is tapped.
                crate::observability::pty_faults::observe(&pane_id, &data);
                let _ = app.emit(&evt, data);
                win_emits += 1;
                last_emit = Instant::now();
            }
            let secs = win_start.elapsed().as_secs_f64();
            if secs >= 2.0 {
                let eps = win_emits as f64 / secs;
                let bps = win_bytes as f64 / secs;
                if eps > 60.0 || bps > 128_000.0 {
                    log::warn!("pty[{pane_id}] high output: {eps:.0} emits/s, {bps:.0} B/s");
                }
                win_start = Instant::now();
                win_bytes = 0;
                win_emits = 0;
            }
        }
        // Drop the pane's fault tap if it had one (#2264) — no-op for the common untapped pane.
        crate::observability::pty_faults::on_pane_exit(&pane_id);
        let _ = app.emit(&format!("pty_exit_{}", pane_id), ());
        log::info!("pty[{pane_id}] session ended ({total} bytes)");
    });
}
