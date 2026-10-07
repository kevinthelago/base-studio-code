//! Where the CAPTURED fixtures live — the hub, not the repo.
//!
//! `tests/fixtures/monitor-pi/` used to ship in git: 397 real flow records between real
//! machines plus verbatim `/proc/net/*` from the live sensor. That is this network's actual
//! topology, so it left the repo when the repo went public
//! (`the-real-network-estate-belongs-in-the-hub-not-the-repo`) and now lives beside the
//! other per-project private data under `projects/lan/`.
//!
//! The attestation tests therefore RESOLVE their fixtures and SKIP when they are absent, so a
//! fresh clone and CI are green without data they were never given. On a machine that has the
//! capture they run exactly as before.
#![allow(dead_code)]

use std::collections::BTreeSet;
use std::path::PathBuf;

/// `$BSC_LAN_FIXTURES`, else `<base dir>/projects/lan/fixtures/monitor-pi`.
///
/// `None` means "this checkout has no capture" — the caller must skip, not fail. A missing
/// capture is the expected state everywhere except the machine it was taken on.
pub fn monitor_pi() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("BSC_LAN_FIXTURES") {
        let p = PathBuf::from(p);
        return p.is_dir().then_some(p);
    }
    let base = match std::env::var_os("BSC_BASE_DIR") {
        Some(b) => PathBuf::from(b),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".base-studio-code"),
    };
    let p = base.join("projects/lan/fixtures/monitor-pi");
    p.is_dir().then_some(p)
}

/// Print the one line a reader needs to understand a skip, and why it is not a pass.
pub fn skip(test: &str) {
    eprintln!(
        "SKIP {test}: no captured sensor fixtures. They are private to the machine the capture \
         was taken on — set BSC_LAN_FIXTURES, or see projects/lan/estate.md in the hub."
    );
}

/// One fixture file's text, or `None` when the capture is absent.
pub fn fixture(name: &str) -> Option<String> {
    let p = monitor_pi()?.join(name);
    Some(std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("fixture {p:?} is readable: {e}")))
}

/// The documented roster, read from the capture rather than hard-coded here — the whole
/// point of the move is that the repo holds no real address.
pub fn roster() -> Option<BTreeSet<String>> {
    Some(
        fixture("roster.txt")?
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect(),
    )
}

/// The /24 prefix the roster sits on, derived from it — never written down here.
pub fn segment(roster: &BTreeSet<String>) -> String {
    let first = roster.iter().next().expect("the roster is not empty");
    let cut = first.rfind('.').expect("a dotted address") + 1;
    first[..cut].to_string()
}
