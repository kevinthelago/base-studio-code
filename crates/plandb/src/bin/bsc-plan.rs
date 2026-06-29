//! Legacy `bsc-plan` shim (#1877) — delegates to [`plandb::cli::run`], which the unified `bsc` binary
//! also dispatches to (`bsc plan …`). Kept only until `bsc` is the sole entrypoint and the sidecar
//! wiring is flipped; deleted in the cleanup phase. `bsc-plan` is the most-used CLI (planner/director/
//! workers drive it under autopilot), so the behavior must stay byte-identical.

use std::process::ExitCode;

fn main() -> ExitCode {
    bsc_cli_util::cli_main("bsc-plan", || {
        plandb::cli::run(std::env::args().skip(1).collect(), "bsc-plan")
    })
}
