//! Pins that the sensor binary stays lean.
//!
//! The whole reason `bsc-lan` is a separate binary is that the unified `bsc`
//! carries bundled DuckDB, and the monitor Pi has 4 GB of RAM with Suricata
//! already holding 1.2 GB and 1.1 GB free on its SD card.
//!
//! Leanness is not a property anyone maintains by intention. The next crate
//! added to the CLI could reintroduce a database, an async runtime or the app
//! shell through some transitive path, and nothing would notice until a deploy
//! filled the Pi's SD card — at which point the symptom appears on the device,
//! not in the change that caused it. So it is asserted here, against this
//! binary's own resolved dependency closure.

const FORBIDDEN: &[(&str, &str)] = &[
    ("duckdb", "an embedded analytical database, and the whole reason this binary is separate"),
    ("tauri", "the app shell: this runs headless on a sensor"),
    ("rusqlite", "the sensor keeps no local store; it emits"),
    ("libsqlite3-sys", "as rusqlite"),
    ("tokio", "an async runtime: the sensor loop is synchronous"),
    ("arrow", "columnar analytics have no place on a 4 GB sensor"),
];

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
fn the_sensor_binary_pulls_in_nothing_heavy() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.lock");
    let lock = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read the workspace Cargo.lock at {path}: {e}"));
    let graph = parse_lock_graph(&lock);

    // A parser that stopped matching would report an empty closure, which reads
    // as a perfectly lean binary. Assert what was parsed before trusting it.
    assert!(graph.len() > 100, "parsed only {} packages from Cargo.lock", graph.len());
    assert!(graph.contains_key("bsc-lan"), "no bsc-lan package in Cargo.lock");

    let mut seen = std::collections::BTreeSet::new();
    let mut stack = vec!["bsc-lan".to_string()];
    while let Some(p) = stack.pop() {
        if !seen.insert(p.clone()) {
            continue;
        }
        if let Some(d) = graph.get(&p) {
            stack.extend(d.iter().cloned());
        }
    }

    // The closure must be a real one, not a stub: the sensor genuinely depends
    // on its own crates, so an empty result cannot masquerade as leanness.
    for expected in ["bsc-lan-sense", "bsc-lan-stream", "bsc-cli-util", "ed25519-dalek"] {
        assert!(seen.contains(expected), "expected {expected} in the closure");
    }

    for (name, why) in FORBIDDEN {
        assert!(
            !seen.contains(*name),
            "`{name}` is reachable from the bsc-lan binary — {why}.\n\
             This binary exists precisely so the sensor does not carry it onto a 4 GB box \
             with 1.1 GB free on its SD card."
        );
    }
}
