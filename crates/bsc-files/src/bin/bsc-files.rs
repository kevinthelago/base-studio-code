//! Legacy `bsc-files` shim (#1877) — delegates to [`bsc_files::cli::run`], which the unified `bsc`
//! binary also dispatches to (`bsc files …`). Kept only until `bsc` is the sole entrypoint and the
//! sidecar wiring is flipped; deleted in the cleanup phase.

use std::process::ExitCode;

fn main() -> ExitCode {
    bsc_cli_util::cli_main("bsc-files", || {
        bsc_files::cli::run(std::env::args().skip(1).collect(), "bsc-files")
    })
}
