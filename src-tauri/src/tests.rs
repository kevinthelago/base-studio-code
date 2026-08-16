//! Genuinely cross-cutting tests with no single owning module; the rest were relocated to
//! their owning modules (#1921).

    #[test]
    fn pane_id_format_matches_frontend_convention() {
        // The frontend uses `t${tabIdx}p${paneIdx}` as the pane ID key.
        // Verify the format matches for several indices.
        assert_eq!(format!("t{}p{}", 0, 0), "t0p0");
        assert_eq!(format!("t{}p{}", 1, 3), "t1p3");
        assert_eq!(format!("t{}p{}", 2, 8), "t2p8");
    }

    /// #2027 P4 guardrail: a compile-time `include_str!`/`include_dir!` reading from `data/` is the
    /// drift class the config-externalization epic removed — every config surface must flow through
    /// `platform::config` (the SINGLE embedded seed), never a second embed. Walk the crate source and
    /// assert the only files embedding `data/` are the allowlisted ones; a NEW one must instead read
    /// via `config::load_str`/`load_opt`. (If a genuine test-only shipped-artifact check needs an
    /// embed, add its path here with a note — that's the intended friction.)
    #[test]
    fn data_embeds_stay_consolidated_in_the_config_loader() {
        // rel path (forward-slash, from src/) → why it may embed `data/`.
        let allow = [
            "platform/config.rs",  // the SINGLE production seed: include_dir!("$CARGO_MANIFEST_DIR/data")
            "session/settings.rs", // test-only drift-guard reads (base.json / process.md / streams.json)
            "tests.rs",            // THIS guard file — it contains the match strings as literals
        ];
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        collect_data_embeds(&src, &src, &allow, &mut offenders);
        offenders.sort();
        assert!(
            offenders.is_empty(),
            "new compile-time `data/` embed(s) outside the config loader (#2027 P4) — read these \
             through `platform::config::load_str` / `load_opt` instead of a second compile-time embed: \
             {offenders:?}",
        );
    }

    /// Collect `.rs` files under `dir` (not allowlisted) that embed `data/` at compile time.
    fn collect_data_embeds(base: &std::path::Path, dir: &std::path::Path, allow: &[&str], out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_data_embeds(base, &path, allow, out);
            } else if path.extension().is_some_and(|x| x == "rs") {
                let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                if allow.contains(&rel.as_str()) {
                    continue;
                }
                let Ok(contents) = std::fs::read_to_string(&path) else { continue };
                let embeds_data = contents.lines().any(|l| {
                    (l.contains("include_str!(") || l.contains("include_dir!(")) && l.contains("/data")
                });
                if embeds_data {
                    out.push(rel);
                }
            }
        }
    }

    /// `cargo nextest` — the workspace test runner (#the-gate-runs-41-test-binaries-one-after-another)
    /// — does NOT run doctests. Today that costs nothing: every doc-comment fence in the workspace is
    /// language-tagged (`text` / `ignore` / `sh`), so there is no Rust doctest to skip. The hazard is
    /// the NEXT one — a BARE fence in a doc comment is a Rust doctest by default, and under nextest it
    /// would silently never run. That is the exact failure this repo keeps getting caught by: a gate
    /// that stays green while covering less (a deleted Worker with tsc+lint+vitest green; ten orphaned
    /// stylesheets; eight test files dropped from a vitest run that reported all-passing).
    ///
    /// So the moment someone writes one, fail here rather than discover it later. The fix is EITHER to
    /// tag the fence (` ```text ` / ` ```ignore `) if it was never meant to execute, OR to add
    /// `cargo test --doc --workspace` to the gate in CLAUDE.md and allow it here. Deleting the guard is
    /// not one of the options.
    #[test]
    fn no_rust_doctests_are_silently_skipped() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let workspace = manifest.parent().expect("src-tauri has a parent");
        let mut found = Vec::new();
        for root in [manifest.join("src"), workspace.join("crates")] {
            collect_rust_doctests(&root, workspace, &mut found);
        }
        found.sort();
        assert!(
            found.is_empty(),
            "Rust doctest(s) found, and `cargo nextest` — the gate's runner — does not run them, so \
             these would pass by never executing. Tag the fence (```text / ```ignore) if it was not \
             meant to run, or add `cargo test --doc --workspace` to the gate: {found:?}",
        );
    }

    /// Collect `<file>:<line>` for every BARE opening fence inside a doc comment under `dir`.
    ///
    /// Fences pair, and a closer is always bare — so counting bare fences would flag every tagged
    /// block's closer. Tracking open/closed state and reporting only the OPENING one is what makes the
    /// difference between "19 bare fences" (all closers, the real workspace) and a genuine doctest.
    /// State resets at any non-doc line, so an unbalanced fence in one item's docs cannot leak into
    /// the next item's.
    fn collect_rust_doctests(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|n| n == "target") {
                    continue; // build output, not source
                }
                collect_rust_doctests(&path, base, out);
                continue;
            }
            if path.extension().is_none_or(|x| x != "rs") {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(&path) else { continue };
            let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let mut inside = false;
            for (i, line) in contents.lines().enumerate() {
                let t = line.trim_start();
                let Some(doc) = t.strip_prefix("///").or_else(|| t.strip_prefix("//!")) else {
                    inside = false; // left the doc comment — state cannot span items
                    continue;
                };
                let doc = doc.trim();
                let Some(rest) = doc.strip_prefix("```") else { continue };
                if inside {
                    inside = false; // this is the closer
                } else {
                    inside = true;
                    if rest.trim().is_empty() {
                        out.push(format!("{rel}:{}", i + 1)); // bare opener == Rust doctest
                    }
                }
            }
        }
    }
