//! `bsc-emit` — the BUILD-TREE entry point for the record emitter.
//!
//! A separate, lean binary rather than a verb on `bsc`, for one measured reason: this runs from seven
//! npm entries and from the vite plugin, including on CI where the frontend job is Node-only. `bsc`
//! links `bsc-data`, i.e. bundled DuckDB — CLAUDE.md measures a first `cargo build -p bsc --bin bsc`
//! at 343s plus ~1.8 GB of C++ output. Paying that on every frontend PR to run a file-copying step is
//! not defensible. This binary's whole dependency tree is `serde_json` + `regex` + two leaf crates.
//!
//! `bsc ui emit records` is the AGENT-FACING door over the same library. One implementation, two
//! entry points — which is not two implementations, and is the same arrangement `bsc-agent` and
//! `bsc-hook` already have.
//!
//! ```text
//! bsc-emit [--repo <dir>] [--quiet]     reconcile <repo>/.bsc-records to the seeds
//! bsc-emit --plan --json [--repo <dir>] the PLAN as data, writing nothing
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |f: &str| args.iter().any(|a| a == f);
    let flag = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();

    if has("--help") || has("-h") {
        print!("{}", bsc_emit::cli::USAGE);
        return ExitCode::SUCCESS;
    }

    // Default to the current directory's repo. The npm entries run at the repo root, and the vite
    // plugin passes `--repo` explicitly.
    let repo = match flag("--repo").map(PathBuf::from).map(Ok).unwrap_or_else(std::env::current_dir) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("bsc-emit: cannot resolve the repo root: {e}");
            return ExitCode::FAILURE;
        }
    };

    match bsc_emit::cli::run(&repo, has("--plan"), has("--json"), has("--quiet")) {
        Ok(out) => {
            if !out.is_empty() {
                print!("{out}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("bsc-emit: {e}");
            ExitCode::FAILURE
        }
    }
}
