//! Render the argv for a ROLE's namespace, so a profile can be executed rather than only asserted.
//!
//! ```sh
//! role <role> <worktree> [--store name=path]... [--outbox guest=path]... [--bin b]... -- <cmd>...
//! ```
//!
//! Prints any caveat to stderr. A profile that knowingly grants more than the isolation model
//! wants should be visible at the point of launch, not only in a doc comment.
use bsc_sandbox::profile::{for_role, Role, SessionPaths};
use bsc_sandbox::Limits;
use std::path::PathBuf;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let split = argv.iter().position(|a| a == "--").unwrap_or(argv.len());
    let (head, tail) = argv.split_at(split);
    let command: Vec<String> = tail.iter().skip(1).cloned().collect();

    if head.len() < 2 || command.is_empty() {
            eprintln!("usage: role <role> <worktree> [--store name=path] [--outbox guest=path] [--bin b] -- <cmd>...");
        std::process::exit(2);
    }

    let role = match Role::parse(&head[0]) {
        Some(r) => r,
        None => {
            // Refused, never defaulted — a typo must not yield a permissive namespace.
            eprintln!("unknown role {:?}", head[0]);
            std::process::exit(1);
        }
    };

    let mut paths = SessionPaths { root: PathBuf::from(&head[1]), ..Default::default() };
    let mut bins: Vec<String> = Vec::new();
    let mut i = 2;
    while i + 1 < head.len() {
        match head[i].as_str() {
            "--store" => {
                if let Some((n, p)) = head[i + 1].split_once('=') {
                    paths.stores.push((n.to_string(), PathBuf::from(p)));
                }
            }
            // guest=host, e.g. --outbox /ui/out=/tmp/ui-out
            "--outbox" => {
                if let Some((g, h)) = head[i + 1].split_once('=') {
                    paths.outboxes.push((g.to_string(), PathBuf::from(h)));
                }
            }
            "--bin" => bins.push(head[i + 1].clone()),
            _ => {}
        }
        i += 2;
    }

    let extra: Vec<&str> = bins.iter().map(|s| s.as_str()).collect();
    // The scope name MUST be unique per launch: systemd refuses a --unit that is still loaded
    // with "Unit <name>.scope was already loaded or has a fragment file", and back-to-back runs
    // of the same role collide. The pid is enough here; a real caller should use its pane id.
    let unit = format!("bsc-{}-{}", head[0], std::process::id());
    match for_role(role, unit, &paths, &extra, Limits::default(), command) {
        Ok(p) => {
            if let Some(c) = &p.caveat {
                eprintln!("CAVEAT: {c}");
            }
            for a in p.spec.render().unwrap() {
                println!("{a}");
            }
        }
        Err(e) => {
            eprintln!("profile refused: {e}");
            std::process::exit(1);
        }
    }
}
