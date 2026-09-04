//! `bsc-lan` — the standalone sensor binary.
//!
//! ## Why this exists separately from the `bsc` binary
//!
//! The unified `bsc` carries bundled DuckDB (`cargo tree -p bsc -i duckdb`:
//! `bsc → bsc-data → duckdb`). The monitor Pi has 4 GB of RAM with Suricata
//! already holding 1.2 GB, and 1.1 GB free on its SD card. Shipping the
//! unified binary there would put an embedded analytical database on a sensor
//! that will never query one.
//!
//! So this is the `bsc-agent` precedent: a lean binary carrying the same verb
//! surface. It dispatches [`bsc_lan::cli::run`] — the *same* function the
//! unified binary dispatches — so there is one implementation and no second
//! copy to drift out of step.
#![forbid(unsafe_code)]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = bsc_lan::cli::run(args, "bsc-lan") {
        eprintln!("bsc-lan: {e}");
        std::process::exit(1);
    }
}
