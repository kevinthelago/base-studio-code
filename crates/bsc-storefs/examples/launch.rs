//! The composition: project the plan store, then print the argv that launches an agent with it
//! mounted read-only at `/plan` inside an isolated namespace.
//!
//! This is the whole point of the two crates together, in one command. Until now it only existed
//! as a sequence of shell steps, which meant nothing verified that the two halves actually fit.
//!
//! ```sh
//! bsc plan list --full --json \
//!   | cargo run -q -p bsc-storefs --example launch -- /wt/repo--stream /tmp/planfs \
//!       cat /plan/items/some-ref/status \
//!   > argv.txt
//! mapfile -t ARGV < argv.txt && "${ARGV[@]}"
//! ```
//!
//! Note what the agent does NOT get: no `bsc`, no database, no network. The namespace binds
//! `/usr` read-only, its own worktree, and the projection. That is the reason the store is a
//! filesystem rather than a CLI — a CLI would mean binding the binary and a writable SQLite file
//! into every agent's world.
use bsc_sandbox::{Limits, SandboxSpec};
use std::io::Read;

/// systemd unit names accept `[A-Za-z0-9_-]`; a worktree basename can hold anything.
fn unit_from(worktree: &str) -> String {
    let base = worktree
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("agent");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("bsc-agent-{}", if cleaned.is_empty() { "unnamed".into() } else { cleaned })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: launch <worktree> <projection-dir> <command>...");
        eprintln!("       plan JSON (bsc plan list --full --json) on stdin");
        std::process::exit(2);
    }
    let (worktree, projection) = (&args[0], &args[1]);
    let command = args[2..].to_vec();

    let mut buf = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
        eprintln!("reading plan JSON from stdin: {e}");
        std::process::exit(1);
    }
    let items = match bsc_storefs::plan::from_json(&buf) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("parsing plan JSON (did you pass --full?): {e}");
            std::process::exit(1);
        }
    };

    let tree = bsc_storefs::plan::project(&items, "launch");
    if let Err(e) = bsc_storefs::materialize(std::path::Path::new(projection), &tree) {
        eprintln!("materializing the projection under {projection}: {e}");
        std::process::exit(1);
    }
    eprintln!("projected {} item(s) -> {} file(s)", items.len(), tree.len());

    let spec = SandboxSpec::worker(unit_from(worktree), worktree, projection, command)
        .with_limits(Limits {
            memory_max: Some("2G".into()),
            tasks_max: Some(512),
            cpu_weight: None,
        });

    match spec.render() {
        Ok(argv) => {
            for a in argv {
                println!("{a}");
            }
        }
        Err(e) => {
            eprintln!("sandbox spec rejected: {e}");
            std::process::exit(1);
        }
    }
}
