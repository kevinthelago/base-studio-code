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

    /// The high-churn packaged seeds are loaded at RUNTIME (`bsc_util::packaged`), and re-embedding one
    /// with `include_str!` would silently restore the cost the change removed: a **data** edit becoming a
    /// **Rust** invalidation. Measured before/after on a warm tree — touching `react-ui.json` recompiled
    /// 3 crates in 7.4s, and now recompiles 0 in 0.77s.
    ///
    /// Nothing about a re-embed LOOKS wrong: it compiles, every test passes, and the only symptom is that
    /// rebuilds get slow again — which reads as "the machine is busy", not as a regression. That is
    /// precisely the class this repo keeps paying for, so it is pinned here rather than left to notice.
    #[test]
    fn the_high_churn_seeds_are_never_embedded_again() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let workspace = manifest.parent().expect("src-tauri has a parent");
        // Match the file NAME, so a re-embed under any relative path is caught.
        let names: Vec<&str> = bsc_util::packaged::RUNTIME_SEEDS
            .iter()
            .map(|rel| rel.rsplit('/').next().expect("a seed path has a file name"))
            .collect();

        let mut found = Vec::new();
        for root in [manifest.join("src"), workspace.join("crates")] {
            collect_seed_embeds(&root, workspace, &names, &mut found);
        }
        found.sort();
        assert!(
            found.is_empty(),
            "a high-churn packaged seed is `include_str!`'d again, which makes every record edit \
             recompile Rust (measured: 3 crates / 7.4s vs 0 crates / 0.77s). Read it through \
             `bsc_util::packaged::read_required` instead: {found:?}",
        );
    }

    /// Every packaged PERSONA must ship as a bundle resource.
    ///
    /// The clamp reads a built-in's packaged floor as its ceiling (`bsc_persona::packaged`), through
    /// `bsc_util::packaged`, which in a SHIPPED build resolves only what `bundle.resources` staged.
    /// A persona added later and not listed there would resolve to "no packaged floor" — and the
    /// clamp would then fall through to the CLOSED floor and refuse every write to it, in shipped
    /// builds only. That is the failure class `every_runtime_seed_is_shipped_in_the_bundle` exists
    /// for, arriving through a different door.
    #[test]
    fn every_packaged_persona_is_shipped_in_the_bundle() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let shipped: std::collections::BTreeSet<String> = conf["bundle"]["resources"]
            .as_object()
            .expect("bundle.resources is an object")
            .values()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        let mut missing = Vec::new();
        for entry in std::fs::read_dir(manifest.join("data").join("personas")).expect("personas dir") {
            let path = entry.expect("dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).expect("file name").to_string();
            let rel = format!("data/personas/{name}");
            if !shipped.contains(&rel) {
                missing.push(rel);
            }
        }
        missing.sort();
        assert!(
            missing.is_empty(),
            "a packaged persona is not in `bundle.resources`, so a SHIPPED build cannot read its              floor and the clamp would refuse every write to it: {missing:?}",
        );
    }

    /// `bundle.resources` must ship EXACTLY the seeds that are no longer embedded.
    ///
    /// This is the one failure the other tests structurally cannot see: dev resolves the seeds from the
    /// repo checkout, so a missing `resources` entry passes every local gate and breaks only in a
    /// SHIPPED build, where the file simply is not there. Before this change `bundle.resources` was
    /// undefined entirely — the app shipped no data files at all — so there is no prior art to inherit.
    #[test]
    fn every_runtime_seed_is_shipped_in_the_bundle() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is valid JSON");
        let resources = conf
            .get("bundle")
            .and_then(|b| b.get("resources"))
            .and_then(|r| r.as_object())
            .expect("bundle.resources must exist — the runtime-loaded seeds have to ship");

        // The TARGET path is what matters: `bsc_util::packaged` looks for `<exe_dir>/data/<rel>`, so
        // the resource must land there whatever the source path is. The SOURCE is deliberately
        // `resources/data/<rel>` — a staged copy — because `tauri_build` emits a rerun-if-changed for
        // every resource, and pointing them at the live tree rebuilt the app on every record edit
        // (measured 23.2s vs 1.2s). Asserting the target keeps that indirection free to change.
        for rel in bsc_util::packaged::RUNTIME_SEEDS {
            let target = format!("data/{rel}");
            let entry = resources.iter().find(|(_, v)| v.as_str() == Some(target.as_str()));
            let Some((source, _)) = entry else {
                panic!(
                    "seed `{rel}` is loaded at runtime but no bundle.resources entry targets \
                     `{target}`, so a shipped build would not contain it"
                );
            };
            assert!(
                source.starts_with("resources/"),
                "bundle.resources maps `{source}` -> `{target}`, but a seed's SOURCE must be the \
                 staged copy under resources/. Pointing it at the live data/ tree makes tauri_build \
                 watch the file and rebuilds the app on every record edit.",
            );
        }
    }

    /// `build.rs` cannot depend on a workspace lib, so it repeats the seed list as `BUNDLED_SEEDS`.
    /// Pin the copy to the original — a seed added to one and not the other either fails to ship or
    /// fails to stage, and both only show up in a release build.
    #[test]
    fn the_build_scripts_seed_list_matches_the_runtime_one() {
        let build_rs = include_str!("../build.rs");
        for rel in bsc_util::packaged::RUNTIME_SEEDS {
            assert!(
                build_rs.contains(rel),
                "build.rs BUNDLED_SEEDS is missing `{rel}`, so it would never be staged into \
                 resources/ and the bundled copy would be absent or stale",
            );
        }
    }

    /// Collect `<file>:<line>` for every `include_str!` of one of `names` under `dir`.
    fn collect_seed_embeds(
        dir: &std::path::Path,
        base: &std::path::Path,
        names: &[&str],
        out: &mut Vec<String>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|n| n == "target") {
                    continue;
                }
                collect_seed_embeds(&path, base, names, out);
                continue;
            }
            if path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for (i, line) in text.lines().enumerate() {
                // The guard's own assertion strings name these files; only an actual macro counts.
                if line.contains("include_str!") && names.iter().any(|n| line.contains(n)) {
                    let rel = path.strip_prefix(base).unwrap_or(&path);
                    out.push(format!("{}:{}", rel.display(), i + 1));
                }
            }
        }
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

    /// **A plain sync `#[tauri::command]` runs on Tauri's MAIN THREAD**, which is also the window
    /// event loop — so a command that does file/SQLite/process I/O stalls the UI itself, not merely
    /// the next invoke. This repo has now fixed that same bug four times (#3630 log pollers, #4074
    /// the cost read + the `bsc` bridge, #4078 `graph_dump`, and the invoke-fairness slice), and each
    /// time the regression would have been a one-word edit: dropping `async` from the signature.
    ///
    /// Measured before the fairness slice, from one live app log's `[invoke]` lines: `logs_usage`
    /// alone held the main thread for **1477.8s across 3169 calls** — 86% of all main-thread command
    /// time — and trivial commands queued behind it (`dir_exists` at 1594ms, a cluster of unrelated
    /// commands all topping out together near 17s).
    ///
    /// This is a NAMED list rather than a count of sync commands: a bare count fires on every
    /// unrelated feature and gets bumped mechanically, which is theatre. These are the commands whose
    /// cost is already measured, so a regression here is a real one.
    #[test]
    fn hot_path_commands_do_not_run_on_the_main_thread() {
        // command -> why it must never go back to the main thread
        const MUST_BE_ASYNC: &[(&str, &str)] = &[
            ("logs_usage", "re-parses every Claude transcript; 1477.8s/3169 calls measured"),
            ("logs_tail", "reads a log file; 134.8s/219 calls measured"),
            ("logs_pane_activity", "scans the activity log; 62.4s/130 calls measured"),
            ("logs_done_panes", "scans the coord log on the same poll cadence"),
            ("graph_dump", "reads + reconciles the whole algorithms store (#4078)"),
            ("read_log_tail", "reads an arbitrary log stream from disk"),
            ("fault_rows_batch", "opens one error.db per project; 19.3s/4 calls measured"),
            ("bsc", "spawns the sidecar — the app's hottest process spawner (#4074)"),
        ];

        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut decls: std::collections::HashMap<String, (bool, String)> = Default::default();
        collect_command_decls(&src, &src, &mut decls);

        let mut sinned = Vec::new();
        for (cmd, why) in MUST_BE_ASYNC {
            match decls.get(*cmd) {
                // The command was renamed or deleted. Fail rather than skip: a guard that silently
                // stops guarding is worse than no guard, and this list is small enough to update.
                None => sinned.push(format!("`{cmd}` is no longer a #[tauri::command] — {why}")),
                Some((is_async, at)) if !is_async => {
                    sinned.push(format!("`{cmd}` is SYNC at {at} — {why}"))
                }
                Some(_) => {}
            }
        }
        assert!(
            sinned.is_empty(),
            "these commands must not run on Tauri's main thread (it is the window event loop, so \
             they freeze the UI rather than just delaying it). Make the fn `async` and run the body \
             on the blocking pool via `platform::offmain::blocking_or`:\n  {}",
            sinned.join("\n  "),
        );
    }

    /// Map every `#[tauri::command]` in the tree to `(is_async, "file:line")`. Attribute and
    /// signature can be separated by doc comments and other attributes, so scan forward to the first
    /// `fn` rather than assuming the next line.
    #[cfg(test)]
    fn collect_command_decls(
        dir: &std::path::Path,
        root: &std::path::Path,
        out: &mut std::collections::HashMap<String, (bool, String)>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_command_decls(&path, root, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                let lines: Vec<&str> = text.lines().collect();
                for (i, line) in lines.iter().enumerate() {
                    if !line.trim_start().starts_with("#[tauri::command") {
                        continue;
                    }
                    for probe in lines.iter().skip(i + 1).take(8) {
                        if let Some(rest) = probe.split(" fn ").nth(1) {
                            let name: String =
                                rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                            let rel = path.strip_prefix(root).unwrap_or(&path).display();
                            let at = format!("{}:{}", rel.to_string().replace(std::path::MAIN_SEPARATOR, "/"), i + 1);
                            out.insert(name, (probe.contains("async fn"), at));
                            break;
                        }
                    }
                }
            }
        }
    }
