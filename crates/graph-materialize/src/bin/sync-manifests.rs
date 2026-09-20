//! Manage the crate manifest records — the store the `Cargo.toml`s are generated from.
//!
//! ```text
//! sync-manifests new <crate>        author a NEW crate as a record, and register it
//! sync-manifests import [--prune]   bring EXISTING manifests into the store (migration)
//! sync-manifests --dry-run          what an import would change
//! ```
//!
//! `new` is the authoring path: a crate comes into existence as a RECORD, and the emit
//! (`npm run emit:manifests`) produces its `Cargo.toml`. `import` is the migration direction and is
//! not how a crate is created — it reads files that already exist.
//!
//! This belongs on the `bsc` surface as `bsc algorithms manifests`, and a request is filed to move it. It
//! is a `src/bin/` here because `bsc-graph` compiles FROM the graph, so adding a verb to it is itself
//! a record write — the operation this command exists to make safe.

use graph_materialize::manifest::{self, SyncOptions};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |n: &str| args.iter().any(|a| a == n);
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    let verb = positional.first().map(|s| s.as_str()).unwrap_or("import");

    // The root is the last positional for `import`, and the one after the name for `new`. Default to
    // the cwd, and REFUSE anything that is not a checkout rather than creating `graph/manifests`
    // somewhere arbitrary and reporting success — the `bsc snapshot save --dir <empty>` lesson.
    let root = match verb {
        "new" => positional.get(2).map(PathBuf::from),
        _ => positional.iter().find(|p| p.as_str() != "import").map(|p| PathBuf::from(p.as_str())),
    }
    .unwrap_or_else(|| PathBuf::from("."));
    if !root.join("crates").is_dir() || !root.join("graph").is_dir() {
        eprintln!("{} does not look like the repo root — expected `crates/` and `graph/`", root.display());
        std::process::exit(2);
    }

    match verb {
        "new" => {
            let Some(name) = positional.get(1) else {
                eprintln!("usage: sync-manifests new <crate> [<repo-root>]");
                std::process::exit(2);
            };
            match manifest::new_crate_record(&root, name) {
                Ok(p) => {
                    println!("created {}", p.display());
                    println!("registered `crates/{name}` in the workspace");
                    println!("run `npm run emit:manifests` to materialize its Cargo.toml");
                }
                Err(e) => {
                    eprintln!("cannot create `{name}`: {e}");
                    std::process::exit(1);
                }
            }
        }
        "import" => {
            let opts = SyncOptions { dry_run: flag("--dry-run") || flag("-n"), prune: flag("--prune") };
            match manifest::sync_records(&root, opts) {
                Ok(r) => {
                    println!(
                        "{}{} written · {} unchanged · {} removed",
                        if opts.dry_run { "DRY RUN: " } else { "" },
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
                    eprintln!("import failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        other => {
            eprintln!("unknown verb `{other}` — expected `new` or `import`");
            std::process::exit(2);
        }
    }
}
