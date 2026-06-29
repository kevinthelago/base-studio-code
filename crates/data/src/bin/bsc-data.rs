//! Legacy `bsc-data` shim (#1877) — delegates to [`bsc_data::cli::run`], which the unified `bsc`
//! binary also dispatches to (`bsc data …`). Kept only until `bsc` is the sole entrypoint and the
//! sidecar wiring is flipped; deleted in the cleanup phase.

use std::process::ExitCode;

fn main() -> ExitCode {
    bsc_cli_util::cli_main("bsc-data", || {
        bsc_data::cli::run(std::env::args().skip(1).collect(), "bsc-data")
    })
}
