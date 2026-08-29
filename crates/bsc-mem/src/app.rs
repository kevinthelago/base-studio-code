//! `bsc mem app` — the RUNNING app's heap, via the Chromium harness in `e2e/`.
//!
//! # Why this is a wrapper and not a measurement
//!
//! The numbers can only be read from a browser that exposes CDP, and the harness that does it already
//! exists and is already pinned by tests. Reimplementing the drive here would be a second renderer
//! path — the exact failure `e2e/`'s own header warns about, where a forked implementation is green
//! while the shipped one is broken. So this SHELLS OUT to the harness and parses one machine-readable
//! line from it.
//!
//! What this adds over running the npm script by hand is the thing that was missing: the numbers reach
//! the `bsc` surface, which is the only surface a worker (or a caged studio session) actually has.

use std::process::Command;

/// The marker the harness prints its machine-readable line under. A prefix rather than "the last line"
/// because playwright interleaves its own reporter output with the spec's, so position is not a
/// contract and matching on one would break the first time the reporter changed.
pub const MARKER: &str = "BSC_MEM_APP ";

/// Pull the measurement JSON out of a harness run's output.
///
/// Returns the LAST marked line: a spec may sample repeatedly, and the final reading is the one taken
/// after the app has settled. Absent marker ⇒ `None`, which the caller reports as a failure to measure
/// rather than as a zero.
pub fn parse_report(output: &str) -> Option<serde_json::Value> {
    output
        .lines()
        .filter_map(|l| l.trim().strip_prefix(MARKER))
        .filter_map(|j| serde_json::from_str(j).ok())
        .next_back()
}

/// Whether a failure was the BROWSER being absent rather than the app being broken.
///
/// Worth telling apart precisely because `npm install` does not install the browser — so "you have not
/// run `npx playwright install chromium`" is the single most likely reason this fails on a fresh
/// checkout, and reporting it as a measurement failure would send someone hunting a leak that is
/// really a missing binary.
pub fn is_missing_browser(output: &str) -> bool {
    let o = output.to_lowercase();
    o.contains("playwright install") || o.contains("executable doesn't exist")
}

pub fn run(seconds: Option<u32>, pretty: bool, json: bool) -> Result<(), String> {
    let secs = seconds.unwrap_or(20);
    let out = Command::new("npx")
        .args(["playwright", "test", "e2e/memApp.spec.ts", "--reporter=list"])
        .env("BSC_MEM_SECONDS", secs.to_string())
        .output()
        .map_err(|e| format!("bsc mem app needs `npx` on PATH (node): {e}"))?;

    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    if let Some(report) = parse_report(&text) {
        bsc_cli_util::emit(pretty, json, &report, || {
            let g = |k: &str| report.get(k).and_then(serde_json::Value::as_f64);
            format!(
                "heap {:.1} MB · {} DOM nodes · {} listeners  (CHROMIUM, not the shipped WebKitGTK)",
                g("JSHeapUsedSize").unwrap_or(0.0) / 1_048_576.0,
                g("Nodes").map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
                g("JSEventListeners").map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
            )
        });
        return Ok(());
    }

    // NO NUMBER IS AN ERROR, never a zero. A heap of 0 MB would be read as a measurement.
    if is_missing_browser(&text) {
        return Err("bsc mem app needs the headless browser, which `npm install` does not install:\n  \
                    npx playwright install chromium"
            .to_string());
    }
    Err(format!(
        "bsc mem app could not read a measurement (no `{MARKER}` line in the harness output).\n\
         The harness ran but reported nothing — its tail follows:\n{}",
        text.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marked_line_is_parsed_out_of_surrounding_reporter_noise() {
        let out = "Running 1 test\n\
                   BSC_MEM_APP {\"JSHeapUsedSize\":41943040,\"Nodes\":1200}\n\
                   1 passed (3.2s)\n";
        let got = parse_report(out).expect("a marked line is found among the noise");
        assert_eq!(got["Nodes"], 1200);
    }

    /// A spec may sample more than once; the SETTLED reading is the last one, not the first.
    #[test]
    fn the_last_reading_wins_when_several_are_printed() {
        let out = "BSC_MEM_APP {\"Nodes\":10}\nBSC_MEM_APP {\"Nodes\":99}\n";
        assert_eq!(parse_report(out).unwrap()["Nodes"], 99);
    }

    /// No marker is NO MEASUREMENT — the caller must not be handed something it could round to zero.
    #[test]
    fn output_with_no_marker_yields_nothing_rather_than_an_empty_reading() {
        assert!(parse_report("1 passed (3.2s)\n").is_none());
        assert!(parse_report("").is_none());
    }

    /// A marker with unparseable JSON is also nothing — a half-written line is not a reading.
    #[test]
    fn a_malformed_marked_line_is_not_a_reading() {
        assert!(parse_report("BSC_MEM_APP {not json\n").is_none());
    }

    /// The missing-browser case is told apart from a real failure, because it is the most likely one on
    /// a fresh checkout and the fix is a single command rather than an investigation.
    #[test]
    fn a_missing_browser_is_recognised_from_playwrights_own_wording() {
        assert!(is_missing_browser("Executable doesn't exist at /home/x/.cache/ms-playwright/..."));
        assert!(is_missing_browser("Please run the following command to download new browsers:\n npx playwright install"));
        assert!(!is_missing_browser("Error: expected 1200 nodes, got 4000"));
    }
}
