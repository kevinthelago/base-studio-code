//! Read the JSON `bsc plan list --full --json` emits on stdin, and materialize the file tree.
//!
//! ```sh
//! bsc plan list --full --json \
//!   | cargo run -q -p bsc-storefs --example project -- /tmp/planfs 2026-08-20T00:00:00Z
//! ```
//!
//! **`--full` is required.** Plain `bsc plan list --json` is the LEAN summary shape, where
//! `acceptance` is a *count* rather than an array and `body` is absent entirely — it does not
//! deserialize into [`bsc_storefs::PlanItem`] and would fail at parse time.
//!
//! Exists so the projection can be mounted for real via `bsc-sandbox` and read by an agent that
//! has no CLI — which is the acceptance criterion for
//! `phase-3-store-surfaces-are-filesystems`, and is not something a string test can establish.
use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: project <root> [generated_at]");
        std::process::exit(2);
    }
    let root = std::path::PathBuf::from(&args[0]);
    // Passed in rather than read from the clock, so the projection stays deterministic.
    let stamp = args.get(1).cloned().unwrap_or_else(|| "unspecified".into());

    let mut buf = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
        eprintln!("reading stdin: {e}");
        std::process::exit(1);
    }

    let items = match bsc_storefs::plan::from_json(&buf) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("parsing plan JSON: {e}");
            std::process::exit(1);
        }
    };

    let tree = bsc_storefs::plan::project(&items, &stamp);
    if let Err(e) = bsc_storefs::materialize(&root, &tree) {
        eprintln!("materializing under {}: {e}", root.display());
        std::process::exit(1);
    }
    println!("{} item(s) -> {} file(s) under {}", items.len(), tree.len(), root.display());
}
