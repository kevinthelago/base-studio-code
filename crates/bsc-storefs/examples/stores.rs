//! Project every store and print the argv that launches an agent with all of them mounted.
//!
//! ```sh
//! stores <worktree> <out-root> --plan p.json --graph g.json --ui u.json --coord coord.log \
//!        -- <command>...
//! ```
//!
//! Each store lands at its own top-level mount — `/plan`, `/graph`, `/ui`, `/coord` — rather than
//! under one shared root, because that is the namespace an agent should actually meet. Any store
//! whose input is not supplied is simply not mounted; a missing store is absent, not empty, which
//! is the same principle the isolation itself runs on.
use bsc_sandbox::{Limits, Mount, SandboxSpec};
use bsc_storefs as fs;
use std::path::PathBuf;

fn unit_from(worktree: &str) -> String {
    let base = worktree.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or("agent");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("bsc-agent-{}", if cleaned.is_empty() { "unnamed".into() } else { cleaned })
}

fn read(p: &str) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| {
        eprintln!("reading {p}: {e}");
        std::process::exit(1);
    })
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let split = argv.iter().position(|a| a == "--").unwrap_or(argv.len());
    let (head, tail) = argv.split_at(split);
    let command: Vec<String> = tail.iter().skip(1).cloned().collect();

    if head.len() < 2 || command.is_empty() {
        eprintln!("usage: stores <worktree> <out-root> [--plan f] [--graph f] [--ui f] [--coord f] -- <command>...");
        std::process::exit(2);
    }
    let (worktree, root) = (head[0].clone(), PathBuf::from(&head[1]));

    let mut src: std::collections::HashMap<&str, String> = Default::default();
    let mut i = 2;
    while i + 1 < head.len() {
        for k in ["plan", "graph", "ui", "coord"] {
            if head[i] == format!("--{k}") {
                src.insert(k, head[i + 1].clone());
            }
        }
        i += 2;
    }

    let mut mounts = vec![Mount::ReadWrite { host: PathBuf::from(&worktree), guest: PathBuf::from("/repo") }];

    if let Some(p) = src.get("plan") {
        let items = fs::plan::from_json(&read(p)).unwrap_or_else(|e| { eprintln!("plan JSON (did you pass --full?): {e}"); std::process::exit(1) });
        let t = fs::plan::project(&items, "stores");
        fs::materialize(&root.join("plan"), &t).unwrap();
        eprintln!("plan  : {} item(s) -> {} file(s)", items.len(), t.len());
        mounts.push(Mount::ReadOnly { host: root.join("plan"), guest: PathBuf::from("/plan") });
    }
    if let Some(p) = src.get("graph") {
        let impls = fs::graph::from_json(&read(p)).unwrap_or_else(|e| { eprintln!("graph JSON: {e}"); std::process::exit(1) });
        let t = fs::graph::project(&impls, "stores");
        fs::materialize(&root.join("graph"), &t).unwrap();
        eprintln!("graph : {} impl(s) -> {} file(s)", impls.len(), t.len());
        mounts.push(Mount::ReadOnly { host: root.join("graph"), guest: PathBuf::from("/graph") });
    }
    if let Some(p) = src.get("ui") {
        let comps = fs::ui::from_json(&read(p)).unwrap_or_else(|e| { eprintln!("ui JSON: {e}"); std::process::exit(1) });
        let t = fs::ui::project(&comps, "stores");
        fs::materialize(&root.join("ui"), &t).unwrap();
        eprintln!("ui    : {} component(s) -> {} file(s)", comps.len(), t.len());
        mounts.push(Mount::ReadOnly { host: root.join("ui"), guest: PathBuf::from("/ui") });
    }
    if let Some(p) = src.get("coord") {
        let (events, bad) = fs::coord::parse(&read(p));
        let t = fs::coord::project(&events, &bad, "stores");
        fs::materialize(&root.join("coord"), &t).unwrap();
        eprintln!("coord : {} event(s), {} malformed -> {} file(s)", events.len(), bad.len(), t.len());
        mounts.push(Mount::ReadOnly { host: root.join("coord"), guest: PathBuf::from("/coord") });
    }

    let spec = SandboxSpec {
        unit: unit_from(&worktree),
        limits: Limits { memory_max: Some("2G".into()), tasks_max: Some(512), cpu_weight: None },
        mounts,
        cwd: PathBuf::from("/repo"),
        env: vec![("HOME".into(), "/repo".into())],
        network: false,
        command,
    };

    match spec.render() {
        Ok(a) => a.iter().for_each(|x| println!("{x}")),
        Err(e) => {
            eprintln!("sandbox spec rejected: {e}");
            std::process::exit(1);
        }
    }
}
