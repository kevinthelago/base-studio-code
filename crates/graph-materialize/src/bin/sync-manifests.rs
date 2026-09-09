//! Write one manifest record per crate into `graph/manifests/`.
//!
//! The operation half of `graph_materialize::manifest` — the library does the work and is tested; this
//! is only how a person invokes it. Auto-discovered from `src/bin/`, so it adds no `[[bin]]` entry to
//! the materializer's own manifest and the workspace's bin population is unchanged.
//!
//! ```text
//! cargo run -p graph-materialize --bin sync-manifests -- [--dry-run] [<repo-root>]
//! ```
//!
//! This belongs on the `bsc` surface rather than in a binary of its own — `bsc graph manifests sync`
//! — and a request is filed to move it. It is here because `bsc-graph` compiles FROM the graph, so
//! adding a verb to it is a record write, which is the thing this command exists to make safe.

use graph_materialize::manifest;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dry = args.iter().any(|a| a == "--dry-run" || a == "-n");
    let root = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    // Fail loudly on a root that is not a checkout, rather than creating `graph/manifests` somewhere
    // arbitrary and reporting success — the failure `bsc studio save --dir <empty>` already taught.
    if !root.join("crates").is_dir() || !root.join("graph").is_dir() {
        eprintln!(
            "{} does not look like the repo root — expected `crates/` and `graph/` under it",
            root.display()
        );
        std::process::exit(2);
    }

    match manifest::sync_records(&root, dry) {
        Ok(r) => {
            println!(
                "{}{} written · {} unchanged · {} removed",
                if dry { "DRY RUN: " } else { "" },
                r.written.len(),
                r.unchanged.len(),
                r.removed.len()
            );
            for w in &r.written {
                println!("  + {w}");
            }
            for x in &r.removed {
                println!("  - {x}");
            }
        }
        Err(e) => {
            eprintln!("sync failed: {e}");
            std::process::exit(1);
        }
    }
}
