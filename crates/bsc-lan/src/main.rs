//! `bsc-lan` — the standalone sensor binary.
//!
//! ## Why this exists separately from the `bsc` binary
//!
//! The unified `bsc` carries bundled DuckDB (`cargo tree -p bsc -i duckdb`:
//! `bsc → bsc-data → duckdb`), which measures 196.6 MB against this binary's
//! 7.2 MB debug / 1.1 MB release. The monitor Pi has 4 GB of RAM with Suricata
//! already holding 1.2 GB, and 1.1 GB free on its SD card.
//!
//! So this is the `bsc-agent` precedent: a lean binary carrying the same verb
//! surface. It dispatches [`bsc_lan::cli::run`] — the *same* function the
//! unified binary dispatches — so there is one implementation and no second
//! copy to drift out of step.
#![forbid(unsafe_code)]

/// What `--version` answers.
///
/// Taken from the package rather than a hand-written literal, which would be a
/// second place to remember and therefore a place to drift.
pub fn version_line() -> String {
    format!("bsc-lan {}", env!("CARGO_PKG_VERSION"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Answered by the BINARY, not by the shared `cli::run`.
    //
    // `bsc deploy push` health-probes a deployed artifact by running it with
    // `--version`. Until this existed the probe got `unknown flag '--version'`
    // and a non-zero exit, so a push could stage, verify and swap but never
    // PROVE the result — and on a device meant to become unreachable, an
    // unprovable deploy is worse than a failed one, because nobody finds out.
    //
    // It lives here rather than in `cli::run` because the version belongs to
    // the binary: the unified `bsc` answers its own version for the whole
    // tool, and sharing this would have `bsc lan --version` report the sensor
    // crate's version while claiming to be bsc's.
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("{}", version_line());
        return;
    }

    if let Err(e) = bsc_lan::cli::run(args, "bsc-lan") {
        eprintln!("bsc-lan: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_answer_is_real_and_comes_from_the_package() {
        let v = version_line();
        assert!(v.starts_with("bsc-lan "), "{v}");
        let reported = v.trim_start_matches("bsc-lan ").trim();
        assert!(!reported.is_empty(), "a health probe cannot be satisfied by an empty version");
        assert_eq!(reported, env!("CARGO_PKG_VERSION"));
        // A version that is only punctuation would satisfy the checks above
        // while telling a probe nothing.
        assert!(reported.chars().any(|c| c.is_ascii_digit()), "{v}");
    }
}
