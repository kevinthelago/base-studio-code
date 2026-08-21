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
use bsc_sandbox::{Limits, Mount, SandboxSpec, Usr};
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
        for k in ["plan", "graph", "ui", "coord", "outbox", "ui-outbox"] {
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

    // The outbox is bound AFTER /coord, over a subpath of it — one writable hole in an otherwise
    // read-only snapshot.
    //
    // The MOUNTPOINT MUST ALREADY EXIST in the projection. bwrap cannot mkdir it: the ro-bind
    // makes that whole subtree read-only, and the attempt fails with
    //   bwrap: Can't mkdir /coord/out: Read-only file system
    // So `<root>/coord/out` is created on the host first, and bwrap binds over the existing dir.
    for (flag, proj, guest) in [
        ("outbox", "coord", "/coord/out"),
        ("ui-outbox", "ui", "/ui/out"),
    ] {
        if let Some(p) = src.get(flag) {
            std::fs::create_dir_all(p).ok();
            std::fs::create_dir_all(root.join(proj).join("out")).ok();
            mounts.push(Mount::ReadWrite { host: PathBuf::from(p), guest: PathBuf::from(guest) });
            eprintln!("outbox: writable at {guest}");
        }
    }

    let spec = SandboxSpec {
        unit: unit_from(&worktree),
        limits: Limits { memory_max: Some("2G".into()), tasks_max: Some(512), cpu_weight: None },
        // Curated, not Usr::All. Binding /usr wholesale would hand this agent every binary on the
        // host — measured at 1558, including bsc itself.
        usr: Usr::Curated(bsc_sandbox::MINIMAL_BINS.iter().map(|s| s.to_string()).collect()),
        mounts,
        cwd: PathBuf::from("/repo"),
        env: vec![("HOME".into(), "/repo".into())],
        network: false,
        // The spec's env is the whole environment; an inherited one carries host credentials.
        clear_env: true,
        // No gates in this example: it demonstrates the STORE projections, not the hook layer.
        hook_bin: None,
        // This example demonstrates the STORE projections; HOME and credentials belong to a real
        // harness launch, not here.
        home: None,
        credential_file: None,
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
