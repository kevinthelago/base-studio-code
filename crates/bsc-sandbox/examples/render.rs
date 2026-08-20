//! Print the argv a worker spec renders to, one argument per line.
//!
//! Exists so the rendered command can be **executed for real** rather than only asserted against
//! as strings — string tests cannot tell you that bwrap accepts the flags in this order. One
//! argument per line so a caller can read it into an array without any quoting layer:
//!
//! ```sh
//! mapfile -t argv < <(cargo run -q -p bsc-sandbox --example render -- /wt /store python3 -V)
//! "${argv[@]}"
//! ```
use bsc_sandbox::{Limits, SandboxSpec};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: render <worktree> <store> <command>...");
        std::process::exit(2);
    }
    let spec = SandboxSpec::worker("bsc-sandbox-example", &args[0], &args[1], args[2..].to_vec())
        .with_limits(Limits {
            memory_max: Some("512M".into()),
            tasks_max: Some(64),
            cpu_weight: None,
        });
    match spec.render() {
        Ok(argv) => {
            for a in argv {
                println!("{a}");
            }
        }
        Err(e) => {
            eprintln!("spec rejected: {e}");
            std::process::exit(1);
        }
    }
}
