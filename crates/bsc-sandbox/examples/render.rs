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
//!
//! `--role <name>` renders that ROLE's profile instead of the generic worker spec. Without it the
//! only thing executable-for-real was `SandboxSpec::worker`, so a per-role decision — the network,
//! the curated bin set, the mounts — could only ever be asserted as strings. That is the gap that
//! let `needs_network` ship wrong for the designer: every string test agreed with a cage no session
//! could work in.
use bsc_sandbox::{
    profile::{for_role, Role, SessionPaths},
    Limits, SandboxSpec, Scope,
};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let role = match args.first().map(String::as_str) {
        Some("--role") if args.len() >= 2 => {
            let name = args[1].clone();
            args.drain(..2);
            match Role::parse(&name) {
                Some(r) => Some(r),
                None => {
                    eprintln!("unknown role {name:?}");
                    std::process::exit(2);
                }
            }
        }
        _ => None,
    };
    if args.len() < 3 {
        eprintln!("usage: render [--role <name>] <worktree> <store> <command>...");
        std::process::exit(2);
    }
    let limits = Limits { memory_max: Some("512M".into()), tasks_max: Some(64), cpu_weight: None };
    let spec = match role {
        Some(r) => {
            let paths = SessionPaths {
                root: args[0].clone().into(),
                stores: vec![("plan".into(), args[1].clone().into())],
                ..Default::default()
            };
            match for_role(r, "bsc-sandbox-example", &paths, &[], limits, Scope::User, args[2..].to_vec()) {
                Ok(p) => p.spec,
                Err(e) => {
                    eprintln!("profile rejected: {e}");
                    std::process::exit(1);
                }
            }
        }
        None => SandboxSpec::worker("bsc-sandbox-example", &args[0], &args[1], args[2..].to_vec())
            .with_limits(limits),
    };
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
