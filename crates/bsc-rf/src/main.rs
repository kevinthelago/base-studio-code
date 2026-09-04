//! `bsc-rf` — the standalone defensive RF monitor.
//!
//! ## Why it ships separately from the `bsc` binary
//!
//! The radio is plugged into the monitor Pi, so the tool has to run *there* —
//! and the unified `bsc` carries bundled DuckDB (196.6 MB against this
//! binary's ~1 MB). The Pi has 1.1 GB free on its SD card. Same reasoning, and
//! the same precedent, as `bsc-lan`.
//!
//! ## The second radio is not interchangeable with the first
//!
//! `wlan0` (brcmfmac) carries `10.99.5.10` and is the monitor Pi's **only**
//! management path — `eth0` has no address at all. Putting *that* interface
//! into monitor mode makes the box unreachable, which is precisely why the
//! ALFA AR9271 was bought: `wlan1` is a separate radio on a separate driver
//! (`ath9k_htc`), so monitor mode there costs nothing.
//!
//! It is written here rather than left as tribal knowledge because the failure
//! mode is losing the machine.
//!
//! Nothing in this crate transmits — no injection, no deauth, no active
//! probing. It reads the radio's own telemetry, and a test in the library
//! asserts that.
#![forbid(unsafe_code)]

/// What `--version` answers. `bsc deploy` health-probes a deployed artifact by
/// running it with `--version`; a binary that cannot answer cannot be proven to
/// work, so a deploy could stage and swap but never be confirmed.
pub fn version_line() -> String {
    format!("bsc-rf {}", env!("CARGO_PKG_VERSION"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("{}", version_line());
        return;
    }
    if let Err(e) = bsc_rf::cli::run(args, "bsc-rf") {
        eprintln!("bsc-rf: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_answer_is_real_and_comes_from_the_package() {
        let v = version_line();
        assert!(v.starts_with("bsc-rf "), "{v}");
        let reported = v.trim_start_matches("bsc-rf ").trim();
        assert!(!reported.is_empty(), "a health probe cannot be satisfied by an empty version");
        assert_eq!(reported, env!("CARGO_PKG_VERSION"));
        assert!(reported.chars().any(|c| c.is_ascii_digit()), "{v}");
    }
}
