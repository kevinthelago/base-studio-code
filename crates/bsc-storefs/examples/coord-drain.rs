//! Drain an agent's coordination outbox into the real log.
//!
//! ```sh
//! coord-drain <outbox-dir> <log-file> <pane> <ts> <actor>
//! ```
//!
//! Accepted entries are appended to the log and removed from the outbox. Refused ones are left
//! as `<name>.rejected`, whose text names the fix — that file IS the correction loop, since a
//! plain write into a bound directory cannot return a typed error the way a FUSE write could.
//!
//! Runs on the HOST, outside the namespace. The agent never touches the real log.
use std::io::Write;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 5 {
        eprintln!("usage: coord-drain <outbox-dir> <log-file> <pane> <ts> <actor>");
        std::process::exit(2);
    }
    let (dir, log, pane, ts, actor) = (&a[0], &a[1], &a[2], &a[3], &a[4]);

    let mut entries: Vec<(String, String)> = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("reading outbox {dir}: {e}");
            std::process::exit(1);
        }
    };
    for f in rd.flatten() {
        if !f.path().is_file() {
            continue;
        }
        let name = f.file_name().to_string_lossy().into_owned();
        let body = std::fs::read_to_string(f.path()).unwrap_or_default();
        entries.push((name, body));
    }
    // Sorted so a drain is deterministic regardless of directory order.
    entries.sort();

    let (ok, rejected) = bsc_storefs::coord::drain(&entries, pane, ts, actor);

    if !ok.is_empty() {
        let mut fh = std::fs::OpenOptions::new().create(true).append(true).open(log).unwrap();
        for e in &ok {
            writeln!(fh, "{}\t{}\t{}\t{}\t{}", e.ts, e.pane, e.verb, e.message, e.actor).unwrap();
        }
    }
    // Only accepted entries are consumed; a refused one stays put next to its .rejected note so
    // the agent can see both what it wrote and why it was refused.
    let refused: Vec<&str> = rejected.iter().map(|(n, _)| n.trim_end_matches(".rejected")).collect();
    for (name, _) in &entries {
        if !name.ends_with(".rejected") && !refused.contains(&name.as_str()) {
            let _ = std::fs::remove_file(std::path::Path::new(dir).join(name));
        }
    }
    for (name, fix) in &rejected {
        let _ = std::fs::write(std::path::Path::new(dir).join(name), fix);
    }

    println!("accepted {} · refused {}", ok.len(), rejected.len());
    for (n, _) in &rejected {
        println!("  {n}");
    }
}
