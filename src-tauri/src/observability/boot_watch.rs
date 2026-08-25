//! The launch watchdog — the half of a boot failure no wrapper can see.
//!
//! `bsc errors run` (slice 1) catches a launch that DIES: a non-zero exit, and the wrapper files it.
//! It cannot catch the failure that actually happens here. `vite` starts fine and keeps running, the
//! Tauri window opens, and the FRONTEND never mounts — every process is alive and exit codes say
//! nothing. `npm-run-dev-never-generated-the-record-tree` and
//! `a-designer-write-can-crash-the-running-app-with-no-way-back` are both that shape.
//!
//! The only trace today is `fatalOverlay`, which paints a `<pre>` into the DOM and dies with the
//! window. It is deliberately pure DOM with no Tauri dependency, precisely because the IPC bridge can
//! be absent — which is also why it cannot durably record anything itself.
//!
//! So the durable half comes from the side that is still alive when the webview is not: Rust arms a
//! deadline at startup, the frontend ACKS when it mounts, and silence past the deadline is recorded as
//! a `launch` fault.
//!
//! ## Why silence, and not an error
//!
//! There is no error to catch. The webview may have failed to fetch a module, thrown during eval,
//! frozen, or rendered a blank page — from Rust all of those look identical, and all of them look like
//! a slow boot until enough time passes. That is the honest shape of the signal, and the fault says so
//! rather than inventing a cause. When the overlay CAN reach us it hands over what it saw
//! ([`boot_failed`]) and the fault carries a real message instead.
//!
//! ## Why a late ack still clears
//!
//! The deadline is a guess about a machine this code has never seen. A cold `tauri dev` on a slow box
//! transforms thousands of modules on first request, and a boot that takes 70s is slow, not broken. So
//! the ack clears the fault whenever it arrives — the cost of guessing too low is a fault that exists
//! for a few seconds, not a permanent lie. Guessing too HIGH has no such safety net, which is why the
//! deadline is generous rather than tight.

use std::sync::atomic::{AtomicBool, Ordering};

/// How long a boot may go silent before it is recorded as failed.
///
/// Generous on purpose. A healthy boot's own trace is ~1s from document to first paint, so this is not
/// a tight bound on anything real — it is the point past which silence stops being explainable, and
/// the asymmetry above says to err high.
const BOOT_DEADLINE_SECS: u64 = 60;

/// The `source_hint` every boot-stage producer here writes under, and therefore what a successful mount
/// CLEARS. One tag for the watchdog and the overlay together: both are this app's own boot observing
/// itself, and a mount that succeeded resolves whatever the last boot said about itself.
///
/// Deliberately NOT the `dev:app` tag the launch wrapper uses. That producer watches the process exit;
/// this one watches the UI. A mount succeeding says nothing about whether the process later died, so
/// clearing across the two would erase a fault nothing had disproved.
const BOOT_SOURCE: &str = "app-boot";

/// The frontend acked that it mounted.
static MOUNTED: AtomicBool = AtomicBool::new(false);
/// A fault has already been filed for THIS boot — so the watchdog's generic "nothing mounted" never
/// piles on top of the overlay's specific, titled one.
static REPORTED: AtomicBool = AtomicBool::new(false);

/// The app's own error store — `projects/<self>/error.db`.
///
/// The app files its own faults on its own project, which is what makes the existing pipeline carry
/// them with no new machinery: `fault_rows_batch` batches unresolved faults per project and Glance
/// renders the node's health from them (#4008).
fn self_store() -> Option<errordb::Store> {
    errordb::Store::open(&crate::error_db_path(bsc_util::SELF_PROJECT_KEY)).ok()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Record one `launch` fault. Fail-open in every direction: no store, an unopenable db or a write
/// error must never affect the boot it is describing.
fn record(title: String, detail: Option<String>, level: &str) {
    let Some(store) = self_store() else { return };
    let _ = store.record(&errordb::FaultInput {
        stage: "launch".to_string(),
        level: level.to_string(),
        title,
        stack: detail,
        source_hint: Some(BOOT_SOURCE.to_string()),
        context: None,
        release: Some(env!("CARGO_PKG_VERSION").to_string()),
        ts: now_ms(),
    });
}

/// What the watchdog files when the deadline passes in silence.
///
/// Pure + public so the wording is pinned by a test: this is the one fault in the system that is
/// written from the ABSENCE of information, and it has to read as that rather than as a diagnosis.
pub fn silent_boot_title() -> String {
    format!("the app window opened but the UI never mounted within {BOOT_DEADLINE_SECS}s")
}

/// The detail line for a silent boot — what a reader should look at next, since there is no evidence
/// to hand them. Stable text on purpose: it is the fingerprint's frame.
pub fn silent_boot_detail() -> String {
    "No error was observed — the frontend simply never acknowledged mounting, which looks identical \
     from here whether a module failed to load, eval threw, or the page froze. Look at the app log \
     (`bsc logs`) and the webview console for this run."
        .to_string()
}

/// Arm the deadline. Called once from `setup`, after the window exists.
pub fn arm() {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(BOOT_DEADLINE_SECS)).await;
        if MOUNTED.load(Ordering::Relaxed) || REPORTED.swap(true, Ordering::Relaxed) {
            return;
        }
        log::error!("[startup] {} — recording a launch fault", silent_boot_title());
        record(silent_boot_title(), Some(silent_boot_detail()), "error");
    });
}

/// The frontend's mount ack (`boot_mounted`). Clears whatever the last boot said about itself.
///
/// Idempotent, and cheap enough to stay so: a second window acking, or a reload, must not cost a db
/// write. The FIRST ack is the interesting one — it is the moment this boot stopped being a candidate
/// failure.
#[tauri::command]
pub fn boot_mounted() {
    if MOUNTED.swap(true, Ordering::Relaxed) {
        return;
    }
    let Some(store) = self_store() else { return };
    match store.resolve_by_source("launch", BOOT_SOURCE, now_ms()) {
        Ok(n) if n > 0 => log::info!("[startup] mounted — cleared {n} launch fault(s) from a previous boot"),
        _ => {}
    }
}

/// The fatal overlay handing over what it caught (`boot_failed`), when the IPC bridge is alive.
///
/// Best-effort by nature: the overlay exists BECAUSE this bridge can be missing, so this path is a
/// bonus rather than the mechanism. When it works the fault carries a real message; when it does not,
/// the watchdog still files the message-less one.
///
/// `fatal` rather than `error`: the overlay only ever fires for a crash that replaced the UI, which is
/// strictly worse than a boot that merely went quiet.
#[tauri::command]
pub fn boot_failed(message: String, detail: Option<String>) {
    let title = message.trim();
    if title.is_empty() {
        return; // nothing to say is not a fault worth a row
    }
    REPORTED.store(true, Ordering::Relaxed);
    log::error!("[startup] the frontend reported a fatal boot error: {title}");
    record(clip(title), detail.map(|d| clip(&d)), "fatal");
}

/// Flatten and cap a field from the frontend. Untrusted length, not untrusted content: a stack can be
/// megabytes and a title has to stay a title.
fn clip(s: &str) -> String {
    let flat = s.replace(['\r', '\n'], " ");
    let capped: String = flat.trim().chars().take(300).collect();
    capped
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The silent-boot fault must read as an ABSENCE of evidence, not as a diagnosis. It is the only
    /// fault in the system written from knowing nothing, and a confident-sounding title would send a
    /// reader looking for a cause this code never observed.
    #[test]
    fn the_silent_boot_fault_says_what_it_does_not_know() {
        let title = silent_boot_title();
        assert!(title.contains("never mounted"), "{title}");
        assert!(title.contains(&BOOT_DEADLINE_SECS.to_string()), "the deadline is stated: {title}");
        let detail = silent_boot_detail();
        assert!(detail.contains("No error was observed"), "{detail}");
        // ...and it points somewhere, because a fault with no evidence and no next step is a dead end.
        assert!(detail.contains("bsc logs"), "{detail}");
    }

    /// The fingerprint of a silent boot has to be STABLE — every silent boot is the same fault with a
    /// rising count, not a new row each time. Both halves are fixed strings for exactly this reason.
    #[test]
    fn every_silent_boot_is_one_fault() {
        let a = errordb::fingerprint("launch", &silent_boot_title(), Some(&silent_boot_detail()));
        let b = errordb::fingerprint("launch", &silent_boot_title(), Some(&silent_boot_detail()));
        assert_eq!(a, b);
        // ...and distinct from a real reported crash, which carries its own message.
        let crash = errordb::fingerprint("launch", "TypeError: x is not a function", None);
        assert_ne!(a, crash);
    }

    /// A frontend message is capped and flattened before it becomes a title. A stack can be megabytes,
    /// and a multi-line title would break the lean TSV `bsc errors list` prints.
    #[test]
    fn a_frontend_message_is_flattened_and_capped() {
        let messy = format!("TypeError: boom\n  at foo\r\n  at bar{}", "x".repeat(5000));
        let c = clip(&messy);
        assert!(!c.contains('\n') && !c.contains('\r'), "flattened");
        assert!(c.chars().count() <= 300, "capped");
        assert!(c.starts_with("TypeError: boom"), "the useful part survives: {c}");
    }

    /// The two producers file under ONE source, so a successful mount clears both — and NOT under the
    /// launch wrapper's tag, which watches a different thing.
    #[test]
    fn the_boot_source_is_distinct_from_the_launch_wrappers() {
        assert_eq!(BOOT_SOURCE, "app-boot");
        assert_ne!(BOOT_SOURCE, "dev:app", "the wrapper watches the process; this watches the UI");
    }
}
