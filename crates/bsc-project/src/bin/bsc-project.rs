//! Legacy `bsc-project` shim (#1877) — delegates to [`bsc_project::cli::run`], which the unified
//! `bsc` binary also dispatches to (`bsc project …`). Kept only until `bsc` is the sole entrypoint
//! and the sidecar wiring is flipped; deleted in the cleanup phase.

use std::process::ExitCode;

fn main() -> ExitCode {
    bsc_cli_util::cli_main("bsc-project", || {
        bsc_project::cli::run(std::env::args().skip(1).collect(), "bsc-project")
    })
}
