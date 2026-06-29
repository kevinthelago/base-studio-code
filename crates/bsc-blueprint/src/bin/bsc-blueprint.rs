//! Legacy `bsc-blueprint` shim (#1877) — delegates to [`bsc_blueprint::cli::run`], which the unified
//! `bsc` binary also dispatches to (`bsc blueprint …`). Kept only until `bsc` is the sole entrypoint
//! and the sidecar wiring is flipped; deleted in the cleanup phase.

use std::process::ExitCode;

fn main() -> ExitCode {
    bsc_cli_util::cli_main("bsc-blueprint", || {
        bsc_blueprint::cli::run(std::env::args().skip(1).collect(), "bsc-blueprint")
    })
}
