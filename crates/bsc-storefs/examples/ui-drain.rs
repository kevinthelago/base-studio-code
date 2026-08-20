//! Drain a designer's component outbox into the UI store.
//!
//! ```sh
//! ui-drain <outbox-dir> [--apply <bsc-path>] [--pretty]
//! ```
//!
//! Without `--apply` it prints the JSON each accepted write would send, and changes nothing —
//! which is how you check a drain before letting it touch a store. With `--apply` it pipes that
//! JSON to `bsc ui set`, which MERGES it onto the stored record.
//!
//! Refused entries are left in place beside a `<id>.rejected` file whose text names the fix. That
//! file IS the correction loop: a plain write into a bound directory cannot return a typed error
//! the way a FUSE write could.
//!
//! Runs on the HOST, outside the namespace. The designer never touches the store.
use std::io::Write;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.is_empty() {
        eprintln!("usage: ui-drain <outbox-dir> [--apply <bsc-path>]");
        std::process::exit(2);
    }
    let dir = std::path::PathBuf::from(&a[0]);
    let apply = a.iter().position(|x| x == "--apply").and_then(|i| a.get(i + 1)).cloned();

    // One directory per component; its files are the fields.
    let mut entries: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let rd = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("reading outbox {}: {e}", dir.display());
            std::process::exit(1);
        }
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if e.path().is_dir() {
            let mut fields = Vec::new();
            if let Ok(inner) = std::fs::read_dir(e.path()) {
                for f in inner.flatten() {
                    if f.path().is_file() {
                        let k = f.file_name().to_string_lossy().into_owned();
                        // Source is read verbatim; no trimming, no normalization.
                        let v = std::fs::read_to_string(f.path()).unwrap_or_default();
                        fields.push((k, v));
                    }
                }
            }
            fields.sort();
            entries.push((name, fields));
        }
    }
    // Sorted so a drain is deterministic regardless of directory order.
    entries.sort();

    let (ok, rejected) = bsc_storefs::ui::drain_writes(&entries);

    for w in &ok {
        let json = w.to_json();
        match &apply {
            None => println!("{json}"),
            Some(bsc) => {
                let mut child = match std::process::Command::new(bsc)
                    .args(["ui", "set"])
                    .stdin(std::process::Stdio::piped())
                    .spawn()
                {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("spawning {bsc}: {e}");
                        std::process::exit(1);
                    }
                };
                // Piped on STDIN rather than passed as an argument: source on a command line is
                // corrupted silently by the shell, which is the whole reason srcText lives in its
                // own file to begin with.
                if let Some(si) = child.stdin.as_mut() {
                    let _ = si.write_all(json.as_bytes());
                }
                match child.wait() {
                    Ok(st) if st.success() => {}
                    Ok(st) => {
                        eprintln!("bsc ui set failed for {} ({st})", w.id);
                        std::process::exit(1);
                    }
                    Err(e) => {
                        eprintln!("bsc ui set failed for {}: {e}", w.id);
                        std::process::exit(1);
                    }
                }
            }
        }
    }

    // Only ACCEPTED entries are consumed. A refused one stays put next to its .rejected note, so
    // the author can see both what they wrote and why it was refused.
    if apply.is_some() {
        let refused: Vec<&str> = rejected.iter().map(|(n, _)| n.trim_end_matches(".rejected")).collect();
        for (id, _) in &entries {
            if !refused.contains(&id.as_str()) {
                let _ = std::fs::remove_dir_all(dir.join(id));
            }
        }
    }
    for (name, fix) in &rejected {
        let _ = std::fs::write(dir.join(name), fix);
    }

    eprintln!("accepted {} · refused {}", ok.len(), rejected.len());
    for (n, _) in &rejected {
        eprintln!("  {n}");
    }
}
