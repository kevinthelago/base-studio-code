//! Pins that this crate is the CONTRACT and never the transport.
//!
//! The split matters for a reason beyond tidiness: the sensor is emit-only and
//! physically hard to reach (updates require swapping its SD card), so
//! everything that can be verified without hardware must be. A crate holding
//! a socket cannot be exercised on a laptop; this one can, and these tests
//! keep it that way.
//!
//! The lockfile walk is deliberately duplicated from bsc-lan-core's guard
//! rather than shared. Sharing it would mean a third crate, and one of the two
//! crates taking a dependency purely to test itself -- which is exactly the
//! kind of edge that makes a guard stop being trusted.

use std::path::Path;

const FORBIDDEN: &[(&str, &str)] = &[
    ("tokio", "an async runtime: the codec is synchronous and pure"),
    ("reqwest", "an HTTP client: this crate is the wire format, not a client"),
    ("russh", "an SSH library"),
    ("duckdb", "an embedded database, and build weight the Pi cannot afford"),
    ("rusqlite", "persistence is not the wire contract's concern"),
    ("tauri", "the app shell: this must run on a headless sensor"),
    ("socket2", "a socket library: the transport lives in another crate"),
    ("mio", "an event loop: same reason as socket2"),
];

const OWN_MANIFEST: &str = include_str!("../Cargo.toml");

#[test]
fn own_manifest_declares_none_of_the_forbidden_crates() {
    for (name, why) in FORBIDDEN {
        let declared = OWN_MANIFEST.lines().any(|line| {
            let t = line.trim_start();
            t.strip_prefix(name).is_some_and(|r| r.trim_start().starts_with('='))
        });
        assert!(!declared, "Cargo.toml declares forbidden dependency `{name}` -- {why}");
    }
}

#[test]
fn the_wildcard_deny_lints_are_still_declared() {
    for lint in ["wildcard_enum_match_arm", "match_wildcard_for_single_variants"] {
        let declared = OWN_MANIFEST
            .lines()
            .map(str::trim)
            .any(|l| l.starts_with(lint) && l.contains("deny"));
        assert!(
            declared,
            "Cargo.toml no longer declares `{lint} = \"deny\"`. Both are required: \
             wildcard_enum_match_arm fires only when a `_` arm covers TWO OR MORE \
             variants, so adding exactly one Kind or Event variant and silencing \
             E0004 with `_ =>` slips past it. Measured 2026-09-04."
        );
    }
}

/// THE POINT OF THIS CRATE, asserted rather than trusted.
///
/// A socket needs no dependency -- `std::net` is always available -- so the
/// manifest check above cannot see one. Only reading the source can.
///
/// This crate's modules are RECORDS in `graph/algorithms.json`, not files under
/// `src/`, so the scan reads what the compiler actually reads: the materialized
/// `$OUT_DIR/crate.rs` emitted by `graph-materialize/build.rs`, plus the one
/// module that stays a file (`src/lib.rs`). Scanning `src/` after the migration
/// found one file and correctly refused to call that a pass -- a scanner that
/// silently reads nothing reports zero offenders, which reads as a pass.
#[test]
fn no_module_in_this_crate_opens_a_socket() {
    let materialized = Path::new(env!("OUT_DIR")).join("crate.rs");
    let text = std::fs::read_to_string(&materialized).unwrap_or_else(|e| {
        panic!("cannot read the materialized crate at {}: {e}", materialized.display())
    });

    // Split into per-record sections on the marker `graph-materialize` emits at
    // the head of every module, so an offender can be named by its RECORD id.
    let mut sections: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        if let Some(id) = line
            .trim_start()
            .strip_prefix("// record `")
            .and_then(|r| r.split('`').next())
        {
            sections.push((id.to_string(), String::new()));
        } else if let Some(last) = sections.last_mut() {
            last.1.push_str(line);
            last.1.push('\n');
        }
    }

    // The crate root stays a real file; scan it alongside the records.
    let lib = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("lib.rs");
    sections.push((
        "src/lib.rs".to_string(),
        std::fs::read_to_string(&lib).expect("crate root is readable"),
    ));

    assert!(
        sections.len() >= 5,
        "found only {} module(s) to scan, so this scanner is not reading the \
         crate and its silence means nothing. The modules are records in \
         graph/algorithms.json, materialized into {}",
        sections.len(),
        materialized.display()
    );

    const BANNED: &[&str] = &[
        "std::net", "UdpSocket", "TcpStream", "TcpListener", "SocketAddr",
        "std::fs", "File::open", "std::process",
    ];

    for (name, body) in &sections {
        for banned in BANNED {
            // Skip doc comments and ordinary comments: this crate's prose
            // legitimately discusses sockets and the transport it excludes.
            let hit = body.lines().any(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("*") && l.contains(banned)
            });
            assert!(
                !hit,
                "{name} references `{banned}` in code. This crate is the wire \
                 CONTRACT: the socket, the filesystem and the process table all \
                 belong to the transport crate. Keeping them out is what lets \
                 every property here be tested with no sensor hardware."
            );
        }
    }
}

fn parse_lock_graph(lock: &str) -> std::collections::HashMap<String, Vec<String>> {
    let mut graph: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut current: Option<String> = None;
    let mut in_deps = false;
    for line in lock.lines() {
        let t = line.trim();
        if t == "[[package]]" {
            current = None;
            in_deps = false;
        } else if let Some(rest) = t.strip_prefix("name = ") {
            if !in_deps {
                current = Some(rest.trim_matches('"').to_string());
            }
        } else if t.starts_with("dependencies = [") {
            in_deps = true;
        } else if in_deps {
            if t == "]" {
                in_deps = false;
            } else if let (Some(o), Some(n)) = (
                current.as_ref(),
                t.trim_end_matches(',').trim_matches('"').split_whitespace().next(),
            ) {
                if !n.is_empty() {
                    graph.entry(o.clone()).or_default().push(n.to_string());
                }
            }
        }
    }
    graph
}

#[test]
fn this_crates_own_dependency_closure_pulls_in_none_of_them() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.lock");
    let lock = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read workspace Cargo.lock at {path}: {e}"));
    let graph = parse_lock_graph(&lock);

    assert!(graph.len() > 100, "parsed only {} packages -- the guard is not reading the lockfile", graph.len());
    assert!(graph.contains_key("bsc-lan-stream"), "no bsc-lan-stream package in Cargo.lock");

    let mut seen = std::collections::BTreeSet::new();
    let mut stack = vec!["bsc-lan-stream".to_string()];
    while let Some(p) = stack.pop() {
        if !seen.insert(p.clone()) {
            continue;
        }
        if let Some(d) = graph.get(&p) {
            stack.extend(d.iter().cloned());
        }
    }

    for (name, why) in FORBIDDEN {
        assert!(
            !seen.contains(*name),
            "`{name}` is reachable from bsc-lan-stream's own dependency closure -- {why}"
        );
    }
}
