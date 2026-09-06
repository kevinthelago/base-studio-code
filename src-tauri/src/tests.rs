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

    // =============================================================================================
    // THE SOURCE POPULATION every guard in this file walks.
    // =============================================================================================

    /// One unit of this workspace's Rust source: where it lives, and its text.
    struct SourceUnit {
        /// Path relative to the root passed to [`source_units`], forward-slashed.
        rel: String,
        /// The module's text — read from the file, or taken from its graph record's `code`.
        text: String,
        /// `true` when this module exists ONLY as a graph record, with no file on disk.
        record_only: bool,
    }

    impl SourceUnit {
        /// A CRATE ROOT (`lib.rs` / `main.rs`) rather than a module. Roots declare modules; they are
        /// never declared themselves, and `graph-materialize` deliberately never materializes one —
        /// `include!` refuses the crate-level `//!` docs and `#![…]` inner attributes they carry
        /// (E0753), which is why every migrated crate keeps exactly this file.
        fn is_crate_root(&self) -> bool {
            matches!(
                self.rel.rsplit('/').next(),
                Some("lib.rs") | Some("main.rs")
            )
        }

        /// A CARGO TARGET ROOT — a crate root, or a file cargo auto-discovers as its own target:
        /// `<crate>/tests/x.rs`, `<crate>/examples/x.rs`, `<crate>/benches/x.rs`.
        ///
        /// Same reason as [`is_crate_root`], one level out. Cargo compiles each of those as a
        /// separate crate, so no `mod x;` in a lib or bin can ever resolve to one — they can only
        /// ever sit in the denominator of the declaration ratio below, never in its numerator.
        /// Depth matters: `tests/fixtures/sample.rs` is NOT auto-discovered (cargo looks one level
        /// deep), so it is deliberately not matched here.
        fn is_target_root(&self) -> bool {
            if self.is_crate_root() {
                return true;
            }
            let seg: Vec<&str> = self.rel.split('/').collect();
            // `<crate>/tests/x.rs` under the `crates` root, or `tests/x.rs` under a crate-local one.
            seg.len() >= 2
                && matches!(seg[seg.len() - 2], "tests" | "examples" | "benches")
                && seg[seg.len() - 1].ends_with(".rs")
        }

        /// How to NAME this unit in a failure message. A reader told `platform/config.rs` will go
        /// looking for a file, and for a record that is a dead end — so a record says so.
        fn label(&self) -> String {
            if self.record_only {
                format!("{} (a graph record, not a file)", self.rel)
            } else {
                self.rel.clone()
            }
        }
    }

    /// The collapse floor for `src-tauri/src`. MEASURED 2026-09-04: **141** units, 0 of them records.
    /// Set well below that on purpose — this detects a COLLAPSE, it is not a ratchet to bump whenever
    /// a module lands or leaves.
    const MIN_SRC_TAURI_UNITS: usize = 120;
    /// The collapse floor for `crates/` — files PLUS records. MEASURED 2026-09-04: **514** units, of
    /// which **80 exist only as records** (25 crates already compile out of the graph store).
    const MIN_CRATE_UNITS: usize = 420;
    /// The floor on `#[tauri::command]` declarations. Measured when the registration guard was
    /// written: 174 declared, 174 registered.
    const MIN_TAURI_COMMANDS: usize = 100;

    /// The repository root — `src-tauri`'s parent.
    fn repo_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .to_path_buf()
    }

    /// Every Rust source unit under `rel_root` (a repo-relative directory — `src-tauri/src`,
    /// `crates`), keyed by path relative to it, from the FILE tree **and** from the committed graph
    /// store.
    ///
    /// **A MODULE IS NOT NECESSARILY A FILE.** Twenty-five crates already compile out of
    /// `graph/algorithms.json`: `crates/graph-materialize/build.rs` inlines each record as a `mod`
    /// block, the file is deleted, and `lib.rs` loses its `mod x;` line along with it. MEASURED
    /// 2026-09-04, **80 record `src` paths under `crates/` have no file on disk at all**. `src-tauri`
    /// still has 141 files and 0 records, but the two reasons it COULD not adopt are gone
    /// (`graph-materialize-becomes-a-real-build-dependency`): the materializer is a package its own
    /// `build.rs` now calls as a fifth job, and the repo root and source prefix are derived rather
    /// than assumed to be `crates/<name>`. So its guards are the ones that break the day a module
    /// moves, which is what this resolver exists for.
    ///
    /// A guard that reaches the tree through `read_dir` does not FAIL when a module migrates. Its
    /// population silently shrinks and it keeps passing over whatever is left — this repo's signature
    /// failure, a gate that passes while covering less than the reader assumes. The worst instance was
    /// `data_embeds_stay_consolidated_in_the_config_loader`, whose allow-list is keyed by relative
    /// path and which carried no population check of any kind: migrating `session/settings.rs` would
    /// have taken away the only module it has ever actually matched, and it would have reported the
    /// same empty offender list either way.
    ///
    /// `min` is the population floor and is a REQUIRED argument on purpose — the same reason
    /// `bsc-disk`'s `plan_*` functions take their policy as one. A non-vacuity assertion a caller may
    /// omit is a non-vacuity assertion a caller WILL omit. It detects a COLLAPSE (a resolver pointed
    /// at the wrong root, an unreadable store, a walk that stopped recursing); it cannot detect ONE
    /// module going missing, which is what the allow-list, named-list and declaration checks at the
    /// call sites are for.
    fn source_units(rel_root: &str, min: usize) -> Vec<SourceUnit> {
        let root = repo_root();
        let dir = root.join(rel_root);
        let mut units: std::collections::BTreeMap<String, SourceUnit> = Default::default();
        collect_rs_files(&dir, &dir, &mut units);

        // The COMMITTED store, read the same way `graph-materialize/build.rs` reads it — directly,
        // never through `bsc_graph`, which reconciles the packaged seed and would pull in records the
        // build never compiles.
        let store_path = root.join("graph").join("algorithms.json");
        let raw = std::fs::read_to_string(&store_path).unwrap_or_else(|e| {
            panic!(
                "cannot read the committed graph store at {} ({e}) — every source guard resolves its \
                 modules through it, so an unreadable store means they are all walking a partial tree",
                store_path.display(),
            )
        });
        let store: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", store_path.display()));
        let impls = store
            .get("implementations")
            .and_then(|v| v.as_array())
            .unwrap_or_else(|| panic!("{} has no `implementations` array", store_path.display()));

        let prefix = format!("{rel_root}/");
        for record in impls {
            let Some(src) = record.get("src").and_then(|v| v.as_str()) else { continue };
            let Some(code) = record.get("code").and_then(|v| v.as_str()) else { continue };
            let Some(rel) = src.strip_prefix(&prefix) else { continue };
            if !rel.ends_with(".rs") {
                continue;
            }
            // THE FILE WINS when both exist, and that is not a preference: while a file is on disk it
            // is what rustc compiles, and a record sharing its path is an edit that has not been
            // materialized yet. Scanning both would let a stale record raise an offender that is not
            // in the compiled program.
            units.entry(rel.to_string()).or_insert_with(|| SourceUnit {
                rel: rel.to_string(),
                text: code.to_string(),
                record_only: true,
            });
        }

        assert!(
            units.len() >= min,
            "the source population under `{rel_root}` collapsed to {} units (floor {min}). A guard \
             walking a shrunken tree does not fail — it passes over what is left. Either the walk is \
             broken, or modules migrated into graph/algorithms.json under a `src` prefix this resolver \
             does not recognise.",
            units.len(),
        );
        units.into_values().collect()
    }

    /// Every `.rs` FILE under `dir`, keyed relative to `base`.
    fn collect_rs_files(
        base: &std::path::Path,
        dir: &std::path::Path,
        out: &mut std::collections::BTreeMap<String, SourceUnit>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|n| n == "target") {
                    continue;
                }
                collect_rs_files(base, &path, out);
            } else if path.extension().is_some_and(|x| x == "rs") {
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                out.insert(rel.clone(), SourceUnit { rel, text, record_only: false });
            }
        }
    }

    /// The text of one NAMED unit, or a panic saying what went missing.
    ///
    /// Every "the detector still bites" check below goes through this, so the check cannot quietly
    /// degrade into a skipped `if let` when its subject migrates.
    fn unit_text<'a>(units: &'a [SourceUnit], rel: &str, why: &str) -> &'a str {
        units
            .iter()
            .find(|u| u.rel == rel)
            .unwrap_or_else(|| {
                panic!(
                    "`{rel}` resolves to neither a file nor a graph record, and {why}. Re-point this \
                     check at whatever replaced it — do NOT delete it, because a guard whose known \
                     positive has vanished is a guard that matches nothing.",
                )
            })
            .text
            .as_str()
    }

    /// Every path an allow-list is keyed by must still resolve to a source unit.
    ///
    /// THIS is the `tests.rs:27` failure, isolated. An allow-list keyed by relative path degrades to
    /// SILENCE the moment one of its paths stops existing: the entry excuses nothing, the module it
    /// was excusing is no longer in the walk, and the guard reports an empty offender list exactly as
    /// it does when the tree is clean. Nothing in the output distinguishes "nothing to report" from
    /// "nothing left to look at".
    fn assert_allow_list_resolves(units: &[SourceUnit], allow: &[&str], guard: &str) {
        let present: std::collections::HashSet<&str> = units.iter().map(|u| u.rel.as_str()).collect();
        let dangling: Vec<&str> = allow.iter().copied().filter(|a| !present.contains(a)).collect();
        assert!(
            dangling.is_empty(),
            "`{guard}` excuses path(s) that resolve to neither a file nor a graph record: {dangling:?}. \
             An allow-list keyed by path stops guarding SILENTLY when its subject moves or migrates — \
             re-key the entry onto wherever that module lives now, or drop it if it is genuinely gone.",
        );
    }

    /// The directory a `mod x;` inside `rel` resolves against: the CONTAINING directory for a crate
    /// root or a `mod.rs`, and the file's own stem for anything else — `cli.rs` owns `cli/`.
    ///
    /// Getting this wrong is silent in the safe direction and loud in the useless one: resolving
    /// `crates/plandb/src/cli.rs`'s submodules against `src/` instead of `src/cli/` reported five
    /// false unresolveds on the first pass here.
    fn module_base(rel: &str) -> String {
        let file = rel.rsplit('/').next().unwrap_or(rel);
        if matches!(file, "mod.rs" | "lib.rs" | "main.rs") {
            rel.strip_suffix(file).unwrap_or("").trim_end_matches('/').to_string()
        } else {
            rel.strip_suffix(".rs").unwrap_or(rel).to_string()
        }
    }

    /// The module name declared by `line`, if it is a BARE `mod x;` declaration — no body, no path
    /// attribute of its own. An inline `mod x { … }` declares nothing to resolve.
    fn declared_module(line: &str) -> Option<&str> {
        let mut rest = line.trim();
        if let Some(after) = rest.strip_prefix("pub(") {
            rest = after.split_once(')')?.1.trim_start();
        } else if let Some(after) = rest.strip_prefix("pub ") {
            rest = after.trim_start();
        }
        let name = rest.strip_prefix("mod ")?.strip_suffix(';')?.trim();
        let named = !name.is_empty()
            && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        named.then_some(name)
    }

    /// Every `mod <name>;` declaration resolves to a source unit — a FILE, or a graph record.
    ///
    /// This is the invariant the guards above were all quietly relying on and none of them stated:
    /// that walking the tree finds the whole program. It is the one check here that reacts to a SINGLE
    /// module going missing, where a population floor only sees a collapse — remove any one module's
    /// file and the `mod x;` that declares it has nothing left to point at.
    ///
    /// It is also what a HALF-MIGRATION looks like from the outside: record written, file deleted,
    /// `mod x;` still in `lib.rs`. The crate does not build, but every guard that reaches the tree with
    /// `read_dir` reports green over a smaller population first, and the smaller population is the part
    /// nothing ever said out loud.
    #[test]
    fn every_declared_module_resolves_to_a_file_or_a_record() {
        let mut unresolved = Vec::new();
        for (rel_root, min) in [("src-tauri/src", MIN_SRC_TAURI_UNITS), ("crates", MIN_CRATE_UNITS)] {
            let mut declared = 0usize;
            let units = source_units(rel_root, min);
            let present: std::collections::HashSet<&str> = units.iter().map(|u| u.rel.as_str()).collect();
            for unit in &units {
                let base = module_base(&unit.rel);
                let lines: Vec<&str> = unit.text.lines().collect();
                for (i, line) in lines.iter().enumerate() {
                    let Some(name) = declared_module(line) else { continue };
                    // `#[path = "…"]` re-points the declaration somewhere this cannot derive. There are
                    // none in this workspace; skipping is cheaper than parsing the attribute, and a new
                    // one shows up as a skip rather than as a false red.
                    if i > 0 && lines[i - 1].contains("#[path") {
                        continue;
                    }
                    declared += 1;
                    let sep = if base.is_empty() { "" } else { "/" };
                    let as_file = format!("{base}{sep}{name}.rs");
                    let as_dir = format!("{base}{sep}{name}/mod.rs");
                    if !present.contains(as_file.as_str()) && !present.contains(as_dir.as_str()) {
                        unresolved.push(format!(
                            "{rel_root}/{}:{} declares `mod {name};` — neither {as_file} nor {as_dir} \
                             is a file or a graph record",
                            unit.rel,
                            i + 1,
                        ));
                    }
                }
            }
            // Non-vacuity, PER ROOT: a declaration parser that stopped matching would find nothing to
            // resolve and report a clean tree, which is the same output as a clean tree. Asserted per
            // root rather than over the sum, because a sum lets one root collapse to nothing while the
            // other carries the total over the line — and `crates/` shrinks on purpose as crates
            // migrate, so it is the root whose slack would have been spent hiding the other's.
            // RELATIVE, NOT ABSOLUTE — and that is the whole point. An absolute floor here has to be
            // re-lowered every migration wave (400 -> 180 -> 150 -> red at 144, twice in one day),
            // and a floor lowered every wave is one nobody reads. Migration deletes a module's file
            // AND the `mod x;` that declared it, so those two populations shrink TOGETHER: their
            // relationship is stable while their magnitudes are not.
            //
            // MEASURED 2026-09-04, after 28 crates had migrated: `src-tauri/src` 139 declarations
            // against 140 on-disk non-root files (0.99), `crates` 144 against 172 (0.84 — the
            // denominator also counts `tests/` files and `mod.rs`, which declare nothing). Half is
            // therefore slack of roughly two to one, and it does not erode as the remaining crates
            // migrate.
            //
            // It still catches what this floor exists for: a parser that stops MATCHING reports ~0
            // declarations while the module files are all still on disk, so the ratio goes to zero
            // and this fails loudly. The COLLAPSE question is answered separately and
            // migration-neutrally by the MIN_*_UNITS floors, which count files PLUS records.
            // TARGET ROOTS, not just crate roots, and the difference is what made this fire.
            // `crates/` holds ~23 files under `tests/` and `examples/`; cargo compiles each as its
            // own target, so no `mod x;` can resolve to one and they can only ever pad the
            // denominator. Counting them was harmless while `src/` modules outnumbered them, and
            // stopped being harmless as migration emptied the numerator: MEASURED here, 22
            // declarations against 52 "module files", of which 23 were target roots. Excluding them
            // is not lowering the floor — it is comparing the declarations to the files a
            // declaration could actually point at, which is the ratio the comment above claims to
            // be measuring and the only version of it that stays stable as the last crates migrate.
            let on_disk_modules = units.iter().filter(|u| !u.record_only && !u.is_target_root()).count();
            assert!(
                declared * 2 >= on_disk_modules,
                "found only {declared} `mod x;` declaration(s) under `{rel_root}` against \
                 {on_disk_modules} module file(s) still on disk — the parser is matching almost \
                 nothing and this guard is inert over that root. (This floor is RELATIVE on purpose: \
                 migration removes a file and its declaration together, so it must not need lowering.)",
            );
        }
        assert!(
            unresolved.is_empty(),
            "declared module(s) that resolve to neither a file nor a graph record. Either a file was \
             deleted without its declaration, or a record was written under a `src` path the resolver \
             does not map:\n  {}",
            unresolved.join("\n  "),
        );
    }

    /// No guard in this file may reach the source tree except through [`source_units`].
    ///
    /// Nothing at RUN time can observe that a guard walked with `read_dir` instead — both spellings
    /// produce the same green, and the difference only appears once a module migrates and one of them
    /// quietly covers less. So this asserts about this file's own SOURCE, the same shape as
    /// `every_store_env_mutation_is_inside_the_store_lock` in `crates/bsc-graph`.
    ///
    /// The needle is BUILT rather than written, so this test does not match itself.
    #[test]
    fn every_source_walking_guard_goes_through_the_resolver() {
        let me = include_str!("tests.rs");
        assert!(
            me.contains("fn source_units("),
            "the resolver this file's guards are required to use is gone; the rule below has no subject",
        );
        let needle = format!("join(\"{}\")", "src");
        assert!(
            !me.contains(&needle),
            "a guard in this file joins the crate manifest with `src` and walks the result. That walk \
             sees FILES only, so it stops covering a module the moment it becomes a record in \
             graph/algorithms.json — and it does not fail when that happens, it just covers less. \
             Resolve through `source_units(<repo-relative root>, <floor>)` instead.",
        );
    }

    /// Every way a module can read ITS OWN source, as needles built from its path.
    ///
    /// Two shapes, because the two behave completely differently under migration and only one of them
    /// is visible to the tool:
    ///
    /// * `include_str!("<basename>")` — compile time. `bsc graph migrate-crate` REFUSES `--apply` over
    ///   this one (`refuse_reason`, lexically, so prose about it does not count).
    /// * the module's own repo-relative path as a string literal, which is how a runtime disk read
    ///   spells it — `Path::new(env!("CARGO_MANIFEST_DIR")).join("src/shot/mod.rs")`, and equally the
    ///   absolutized `concat!(env!("CARGO_MANIFEST_DIR"), "/src/shot/mod.rs")` that harvest rewrites a
    ///   relative include into. **`migrate-crate` cannot see this one at all**, which is exactly why
    ///   this guard exists rather than trusting the refusal.
    ///
    /// The needles are BUILT rather than written, so this file does not match itself on them.
    fn self_read_needles(rel: &str) -> [(String, &'static str); 2] {
        // (the tuple below is the whole body; see `code_lines` for why matching is comment-blind)
        let base = rel.rsplit('/').next().unwrap_or(rel);
        [
            (format!("include_str!(\"{base}\")"), "include_str!"),
            (format!("\"src/{rel}\""), "a manifest-rooted disk read"),
        ]
    }

    /// NO MODULE OF THIS CRATE MAY READ ITS OWN SOURCE by a path the graph migration deletes.
    ///
    /// Five did — `console/pty/launch.rs`, `console/pty/pump.rs` (twice), `fleet/wake.rs`,
    /// `session/persona_use.rs` and `shot/mod.rs` — and together they were the last blocker in front of
    /// the 136 modules and 55,843 lines of this crate
    /// (`three-src-tauri-modules-read-their-own-source`). Every one of them is a real guarantee that
    /// nothing at run time can observe: no raw ESC byte in a line typed into a shell, the signal decode
    /// `child_outcome` actually ships, a call site a pure unit test cannot reach. None of them is
    /// deleted here — they are RESOLVED through [`crate::testutil::module_source`], which reads the
    /// file while there is one and the materialized `$OUT_DIR/crate.rs` section once there is not.
    ///
    /// # Why this is a gate and not a note
    ///
    /// The fix repairs five instances; nothing stopped the sixth. `migrate-crate`'s own refusal is not
    /// that gate for two reasons: it is lexical over `include_str!`, so it never sees the disk-read
    /// spelling (`shot/mod.rs` was invisible to it and was found by strace), and it fires only when
    /// somebody runs the migration — long after the module was written.
    ///
    /// # The exclusions are the migration's own buckets, not a convenience
    ///
    /// `lib.rs` and `main.rs` are crate ROOTS, never modules. A `tests.rs` is a `mod tests` and has
    /// nothing to lift. Those are precisely the files `migrate-crate` leaves unplanned
    /// (`the_real_src_tauri_dry_runs_and_writes_nothing` pins the buckets), so a self-read in one of
    /// them survives migration untouched — which is why `tests.rs`'s own `include_str!("tests.rs")`
    /// below is correct and stays.
    #[test]
    fn no_module_reads_its_own_source_by_a_path_the_migration_deletes() {
        let units = source_units("src-tauri/src", MIN_SRC_TAURI_UNITS);

        // COMMENT LINES ARE NOT CODE, and here that is load-bearing rather than tidy. Every one of the
        // five repointed guards now explains in prose what it USED to read, quoting the old
        // `include_str!("<file>")` verbatim — so a raw `contains` over the whole module would report
        // all five as live self-reads and this guard would be a permanent, wrong red. It is the same
        // trap `migrate-crate`'s own `refuse_reason` hit and fixed lexically
        // (`text_about_an_include_str_is_not_a_live_call`); a line filter is the proportionate version
        // here. Its LIMIT, stated rather than hidden: a needle inside a block comment or a raw string
        // literal is missed. `migrate-crate`'s refusal is the backstop for the `include_str!` half —
        // this guard's unique reach is the disk-read half, which nothing else can see at all.
        let code_lines = |text: &str| {
            text.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        };

        // NON-VACUITY, and it is a real one rather than a count: run the needle builder against the
        // ONE legitimate self-read left in the tree — this file's own — and require it to fire. A
        // needle that stopped matching (a spelling change, a formatting change) would otherwise report
        // zero offenders over 140 modules, which reads exactly like a pass.
        let me = units.iter().find(|u| u.rel == "tests.rs").expect("this file is in the walk");
        let my_code = code_lines(&me.text);
        assert!(
            self_read_needles("tests.rs").iter().any(|(n, _)| my_code.contains(n.as_str())),
            "the self-read needles no longer match this file's own `include_str!` of its own name, so \
             this guard is scanning 140 modules for a shape it can no longer recognise",
        );

        let mut offenders: Vec<String> = Vec::new();
        for u in &units {
            let base = u.rel.rsplit('/').next().unwrap_or(&u.rel);
            if u.rel == "lib.rs" || u.rel == "main.rs" || base == "tests.rs" {
                continue; // never planned by `migrate-crate` — see the doc comment
            }
            let code = code_lines(&u.text);
            for (needle, how) in self_read_needles(&u.rel) {
                if code.contains(needle.as_str()) {
                    offenders.push(format!("{} reads its own source via {how} (`{needle}`)", u.rel));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "a module reads its OWN source by a path `bsc graph migrate-crate src-tauri` deletes. The \
             record cannot read a file that no longer exists, so this blocks the migration of the \
             whole crate — and the disk-read spelling is invisible to the tool's own refusal, so it \
             would break AFTER `--apply` succeeded. Resolve through `crate::testutil::module_source(\
             \"<path under src/>\")` instead, which reads the materialized `$OUT_DIR/crate.rs` once \
             the file is gone:\n  {}",
            offenders.join("\n  "),
        );
    }

    /// [`crate::testutil::module_source`]'s RECORD half reads what `graph-materialize` really emits.
    ///
    /// # Why this test has to exist, and why it cannot be a fixture
    ///
    /// `module_source` has two homes: the file, and this crate's section of `$OUT_DIR/crate.rs`. Today
    /// this crate owns ZERO records, so the second half is **dead code that no test can reach** — and
    /// it is the half every self-scanning guard falls onto the moment
    /// `bsc graph migrate-crate src-tauri --apply` runs. Shipping it unexercised would mean five
    /// behaviour guards break at exactly the moment nobody is looking at them.
    ///
    /// So this drives the REAL emitter — `graph_materialize::emit_into`, the same call
    /// `src-tauri/build.rs` makes — over a temp store, and asks the real resolver to split the result.
    /// A hand-written `crate.rs` fixture would prove only that this file agrees with itself: the
    /// failure mode being guarded is the emitter's marker changing shape, and a fixture cannot see
    /// that. VERIFIED end to end once, additionally, by planting a record for a module with no file at
    /// all in the committed `graph/algorithms.json`, building, and watching `module_source` resolve it
    /// out of the real `$OUT_DIR/crate.rs`.
    ///
    /// # What the depth-3 shape pins
    ///
    /// `render` puts CHILDREN INSIDE the parent, after the parent's own body — so a section runs from
    /// its own marker to the NEXT marker, and a directory module (`console/pty/mod.rs`, and in the
    /// real tree `shot/mod.rs`) must still yield its whole body before its children begin. A splitter
    /// that took everything to the closing brace would hand `shot/mod.rs`'s guard its children's source
    /// as well.
    #[test]
    fn the_resolver_reads_what_graph_materialize_actually_emits() {
        let root = crate::testutil::unique_dir("bsc-materialize", "resolver");
        let manifest = root.join("src-tauri"); // the manifest DIRECTORY — `crate_dir` is its name
        std::fs::create_dir_all(root.join("graph")).expect("temp repo");
        std::fs::create_dir_all(&manifest).expect("temp crate dir");
        let out = root.join("out");
        std::fs::create_dir_all(&out).expect("temp out dir");

        // A depth-3 leaf and both of its parents. `render` refuses a nested module whose parent has no
        // record, which is the same rule the real migration follows.
        let record = |rel: &str, code: &str| {
            serde_json::json!({
                "id": graph_materialize::expected_id("src-tauri", rel),
                "src": format!("src-tauri/src/{rel}"),
                "code": code,
            })
        };
        let store = serde_json::json!({
            "implementations": [
                record("console/mod.rs", "pub const CONSOLE_BODY: &str = \"console\";"),
                record("console/pty/mod.rs", "pub const PTY_BODY: &str = \"pty\";"),
                record("console/pty/launch.rs", "pub const LAUNCH_BODY: &str = \"launch\";"),
            ]
        });
        std::fs::write(
            root.join("graph").join("algorithms.json"),
            serde_json::to_string(&store).expect("serializes"),
        )
        .expect("temp store");

        let n = graph_materialize::emit_into(
            &manifest,
            &out,
            Some(&root),
            graph_materialize::Adoption::Required,
        )
        .expect("the real materializer emits these three");
        assert_eq!(n, 3, "all three records are this crate's modules");

        let crate_rs =
            std::fs::read_to_string(out.join("crate.rs")).expect("the materializer wrote crate.rs");
        let section = |id: &str| crate::testutil::record_section(&crate_rs, id);

        // THE LEAF, by the id `migrate-crate` prints for `src/console/pty/launch.rs`.
        let leaf = section("src-tauri--console--pty--launch.rs").expect("the leaf resolves by id");
        assert!(leaf.contains("LAUNCH_BODY"), "{leaf}");

        // THE PARENT ENDS WHERE ITS CHILD BEGINS — the property `shot/mod.rs` depends on.
        let parent = section("src-tauri--console--pty--mod.rs").expect("the directory module resolves");
        assert!(parent.contains("PTY_BODY"), "the parent's own body: {parent}");
        assert!(
            !parent.contains("LAUNCH_BODY"),
            "a directory module's section must stop at its child's marker, or every `mod.rs` guard \
             scans its children too: {parent}"
        );

        // An id nothing emitted is `None`, never an empty string — `module_source` turns that into the
        // panic that stops a guard from silently scanning nothing.
        assert!(section("src-tauri--console--pty--nope.rs").is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Does one source line embed something out of `data/` at compile time?
    fn embeds_data(line: &str) -> bool {
        (line.contains("include_str!(") || line.contains("include_dir!(")) && line.contains("/data")
    }

    /// #2027 P4 guardrail: a compile-time `include_str!`/`include_dir!` reading from `data/` is the
    /// drift class the config-externalization epic removed — every config surface must flow through
    /// `platform::config` (the SINGLE embedded seed), never a second embed. Walk the crate source and
    /// assert the only modules embedding `data/` are the allowlisted ones; a NEW one must instead read
    /// via `config::load_str`/`load_opt`. (If a genuine test-only shipped-artifact check needs an
    /// embed, add its path here with a note — that's the intended friction.)
    #[test]
    fn data_embeds_stay_consolidated_in_the_config_loader() {
        // rel path (forward-slash, from src/) → why it may embed `data/`.
        let allow = [
            "platform/config.rs",  // the SINGLE production seed loader (it embeds `$OUT_DIR/config-seed` today, not `data/` directly)
            "session/settings.rs", // test-only drift-guard reads (base.json / process.md / streams.json)
            "tests.rs",            // THIS guard file — it contains the match strings as literals
        ];
        let units = source_units("src-tauri/src", MIN_SRC_TAURI_UNITS);
        // NON-VACUITY (1/2): the allow-list is keyed by PATH, so an entry whose module migrated
        // excuses nothing and takes its subject out of the walk at the same time.
        assert_allow_list_resolves(&units, &allow, "data_embeds_stay_consolidated_in_the_config_loader");

        let mut offenders: Vec<String> = units
            .iter()
            .filter(|u| !allow.contains(&u.rel.as_str()))
            .filter(|u| u.text.lines().any(embeds_data))
            .map(SourceUnit::label)
            .collect();
        offenders.sort();
        assert!(
            offenders.is_empty(),
            "new compile-time `data/` embed(s) outside the config loader (#2027 P4) — read these \
             through `platform::config::load_str` / `load_opt` instead of a second compile-time embed: \
             {offenders:?}",
        );

        // NON-VACUITY (2/2): the detector must still MATCH a module known to embed `data/`, or it
        // passes by recognising nothing at all. `session/settings.rs` is that module — three
        // `include_str!` reads out of `../../data/`. `platform/config.rs` is deliberately NOT the
        // subject here: it moved to `$OUT_DIR/config-seed` and no longer matches the detector, which
        // is exactly how quietly an allow-list entry goes stale.
        assert!(
            unit_text(&units, "session/settings.rs", "it is this guard's one known `data/` embedder")
                .lines()
                .any(embeds_data),
            "the `data/` embed detector no longer matches the module known to hold one, so it is \
             recognising nothing and would report an empty offender list against any number of new \
             embeds",
        );
    }

    /// The RUST half of `#only-the-user-resumes-a-session`.
    ///
    /// `src/shared/lib/fleet/injectCallers.test.ts` ratchets the frontend injectors — `injectPrompt`
    /// and the raw `pty_write` command — to user-action paths plus one deliberate unattended exception
    /// (a cron automation the user configured). That guard greps `src/`, so it is STRUCTURALLY blind to
    /// a backend writer: Rust can reach `PtyState` directly and type into any live session without the
    /// ratchet noticing. This is that guard for this side.
    ///
    /// The existing frontend guard learned the same lesson the hard way — an inventory that "named
    /// eight injectors and believed itself complete" missed `useWorkerAutoEnd`, which invoked the raw
    /// command twice into the DIRECTOR's pane with a trailing CR. Matching the capability rather than a
    /// convenience wrapper is what caught it, so this matches the capability too.
    #[test]
    fn rust_injectors_are_ratcheted() {
        // rel path (forward-slash, from src/) → why it may write into a live pane.
        let allow = [
            "console/pty/mod.rs",   // DEFINES `write_pane` + the `pty_write` command
            "session/deliver.rs",   // the one deliberate backend injector (#an-ask-is-delivered-not-left-to-be-found)
            "tests.rs",             // THIS guard — it holds the match string as a literal
        ];
        let units = source_units("src-tauri/src", MIN_SRC_TAURI_UNITS);
        // NON-VACUITY (1/2): every excused path still resolves — see `assert_allow_list_resolves`.
        assert_allow_list_resolves(&units, &allow, "rust_injectors_are_ratcheted");

        let mut offenders: Vec<String> = units
            .iter()
            .filter(|u| !allow.contains(&u.rel.as_str()))
            .filter(|u| u.text.contains("write_pane("))
            .map(SourceUnit::label)
            .collect();
        offenders.sort();
        assert!(
            offenders.is_empty(),
            "new backend pane-writer(s) outside the allow-list. Writing into a session nobody clicked \
             crosses #only-the-user-resumes-a-session — the decision is the maintainer's, not a \
             refactor's. Argue it onto the list in this test with a reason: {offenders:?}",
        );
        // NON-VACUITY (2/2): the guard must actually be able to SEE an injector, or it passes by
        // matching nothing — the vacuous-green failure this repo keeps paying for. `session/deliver.rs`
        // is a known writer. This used to `read_to_string` it directly, which is precisely the reach
        // that turns a migration into a panic (`deliver.rs is present`) rather than a resolution.
        assert!(
            unit_text(&units, "session/deliver.rs", "it is the ratchet's one known backend injector")
                .contains("write_pane("),
            "the ratchet's match string no longer appears in the known injector, so it is matching \
             nothing and would pass with any number of new writers",
        );
    }

    /// Doctests are RUN by the gate now, so nothing here has to guess about them.
    ///
    /// This replaced a static scan for untagged ``` fences. The scan could not see an INDENTED code
    /// block — Markdown makes one out of four spaces after a blank line, rustdoc compiles it as Rust
    /// exactly as it would a bare fence, and there is nowhere to write ```text on it. THREE doctests
    /// were failing on develop behind a green gate because of that blind spot, in `bsc-persona`,
    /// `bsc-graph` and `bsc-ui`.
    ///
    /// Widening the scan to indented blocks was tried and abandoned: it flagged five and only two were
    /// real, because rustdoc collects doctests from PUBLIC items only, so a `///` block on a private
    /// static or a `pub(crate)` fn is inert and can never fail. A guard that cries wolf on three of
    /// five is worse than the gap it closes.
    ///
    /// The old doc said the alternatives were to tag the fence or to add `cargo test --doc --workspace`
    /// to the gate, and that deleting the guard was not one of them. The leg is added — MEASURED at
    /// 7.53s warm for the whole workspace, cheaper than clippy — so the property is now enforced by
    /// EXECUTION rather than by inspection. The guard is not deleted, it MOVED: `gate-scope.test.ts`
    /// pins the leg in both tiers, which is what stops it quietly disappearing.
    #[test]
    fn doctests_are_executed_by_the_gate_not_inspected_for() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let scope = manifest.parent().expect("src-tauri has a parent").join("scripts/gateScope.mjs");
        let src = std::fs::read_to_string(&scope).expect("scripts/gateScope.mjs is readable");
        assert!(
            src.contains(r#"key: "doctest""#),
            "the gate no longer carries a doctest leg, and `cargo nextest` does not run doctests — so \
             a failing one would pass by never executing. Restore the leg in {}, or restore a static \
             guard here; leaving neither is the state this test exists to prevent.",
            scope.display(),
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
        // Match the file NAME, so a re-embed under any relative path is caught.
        let names: Vec<&str> = bsc_util::packaged::RUNTIME_SEEDS
            .iter()
            .map(|rel| rel.rsplit('/').next().expect("a seed path has a file name"))
            .collect();
        assert!(
            !names.is_empty(),
            "bsc_util::packaged::RUNTIME_SEEDS is empty, so this guard has nothing to look for and \
             would pass over any re-embed",
        );

        // (unit path, what to show a reader) for every line that embeds a seed.
        let mut found: Vec<(String, String)> = Vec::new();
        // `crates/` is where this guard was ALREADY going blind: 80 of its modules are graph records
        // with no file on disk, and the old `read_dir` walk saw none of them.
        for (rel_root, min) in [("src-tauri/src", MIN_SRC_TAURI_UNITS), ("crates", MIN_CRATE_UNITS)] {
            for unit in source_units(rel_root, min) {
                for (i, line) in unit.text.lines().enumerate() {
                    if is_seed_embed(line, &names) {
                        found.push((
                            format!("{rel_root}/{}", unit.rel),
                            format!("{rel_root}/{}:{}", unit.label(), i + 1),
                        ));
                    }
                }
            }
        }
        found.sort();

        let mut unexpected: Vec<&str> = found
            .iter()
            .filter(|(path, _)| !KNOWN_SEED_EMBEDS.iter().any(|(known, _)| *known == path.as_str()))
            .map(|(_, shown)| shown.as_str())
            .collect();
        unexpected.sort();
        assert!(
            unexpected.is_empty(),
            "a high-churn packaged seed is `include_str!`'d again, which makes every record edit \
             recompile Rust (measured: 3 crates / 7.4s vs 0 crates / 0.77s). Read it through \
             `bsc_util::packaged::read_required` instead: {unexpected:?}",
        );

        // The known-red list ratchets in BOTH directions: an entry that has stopped being an offender
        // must be deleted in the same change that fixes it. Without this half it would decay into
        // exactly the kind of stale path-keyed excuse this file was repaired for.
        let stale: Vec<&(&str, &str)> = KNOWN_SEED_EMBEDS
            .iter()
            .filter(|(known, _)| !found.iter().any(|(path, _)| path.as_str() == *known))
            .collect();
        assert!(
            stale.is_empty(),
            "KNOWN_SEED_EMBEDS names module(s) that no longer embed a seed — delete the entry, because \
             a carried exception that outlives its problem is an excuse nobody will re-examine: {stale:?}",
        );

        // NON-VACUITY. This guard's positive set is EMPTY by design, so — unlike the two above — there
        // is no real module to check the detector against, and a matcher that stopped matching would be
        // indistinguishable from a clean tree. Check it against a constructed line instead, in both
        // directions, so neither "never matches" nor "matches everything" can hide here.
        // The `!` is interpolated rather than written, so this line does not itself read as an embed
        // when this very file is walked — self-flagging would make the guard's own probe its offender.
        let embed = format!("const SEED: &str = include_str{}(\"../data/knowledge/{}\");", '!', names[0]);
        assert!(
            is_seed_embed(&embed, &names),
            "the seed-embed detector no longer recognises a compile-time embed of `{}`, so it is \
             matching nothing and this guard is inert",
            names[0],
        );
        let runtime_read = format!("let seed = read_required(\"knowledge/{}\")?;", names[0]);
        assert!(
            !is_seed_embed(&runtime_read, &names),
            "the seed-embed detector now flags a RUNTIME read, which is the thing this guard exists to \
             steer people towards",
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
    /// The UI's model catalog and the Rust tier registry are ONE vocabulary, and this is what keeps
    /// them one.
    ///
    /// `@data/console/models.json` is what the model menu renders and what `MODEL_IDS` validates a
    /// stored persona / placement / stream against on the frontend; `bsc_util::MODEL_TIERS` is what
    /// `claude_model_flag` maps to a `--model` alias and what `bsc persona model` / `bsc teams model`
    /// accept. A tier in one and not the other is invisible until it reaches a launch: a JSON-only
    /// tier is offerable in the UI and then silently launches with NO `--model` (the harness default),
    /// and a Rust-only tier is settable from the CLI and never appears in the menu.
    ///
    /// ORDER is asserted too, not just membership — the catalog is ordered cheapest → most capable and
    /// both the menu and `DEFAULT_MODEL_ID`'s middle-tier fallback read that order.
    #[test]
    fn the_ui_model_catalog_and_the_rust_tier_registry_are_one_vocabulary() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let raw = std::fs::read_to_string(manifest.join("data").join("console").join("models.json"))
            .expect("data/console/models.json");
        let catalog: Vec<serde_json::Value> = serde_json::from_str(&raw).expect("models.json parses");

        let json_ids: Vec<String> = catalog
            .iter()
            .map(|m| m["id"].as_str().expect("every catalog entry has a string id").to_string())
            .collect();
        let rust_ids: Vec<String> = bsc_util::model_ids().iter().map(|s| s.to_string()).collect();
        assert_eq!(json_ids, rust_ids, "the UI catalog and MODEL_TIERS must name the same tiers, in the same order");

        // ...and every one of them actually maps to a launch alias, which is the property that makes
        // the shared vocabulary worth anything.
        for id in &json_ids {
            assert!(
                crate::session::launch::claude_model_flag(id).is_some(),
                "the catalog offers '{id}', which the launch cannot map to a --model alias",
            );
        }
    }

    /// The app's own project key is written by TWO independent producers, and they must agree.
    ///
    /// Rust files the app's own faults under `bsc_util::SELF_PROJECT_KEY` (the boot watchdog); the
    /// wrapped build commands in `package.json` pass `--project <key>` to `bsc errors run`. A
    /// disagreement would split the app's faults across two stores, each looking EMPTY from the other
    /// — a build failure recorded where nobody reads, and a `bsc errors projects` that says the app is
    /// fine. Neither side can see the other, so nothing but this test can catch it.
    ///
    /// It reaches outside `src-tauri/` to read `package.json`, which Rust otherwise only does for the
    /// cross-repo wire fixtures. That is the point: the drift being guarded is exactly the one that
    /// crosses the boundary.
    #[test]
    fn the_self_project_key_matches_the_wired_npm_scripts() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let raw = std::fs::read_to_string(manifest.join("..").join("package.json")).expect("package.json");
        let pkg: serde_json::Value = serde_json::from_str(&raw).expect("package.json parses");
        let scripts = pkg["scripts"].as_object().expect("scripts is an object");

        let wired: Vec<(&String, String)> = scripts
            .iter()
            .filter_map(|(name, v)| {
                let s = v.as_str()?;
                let at = s.find("--project ")?;
                let key = s[at + "--project ".len()..].split_whitespace().next()?;
                Some((name, key.to_string()))
            })
            .collect();

        assert!(
            !wired.is_empty(),
            "no npm script passes `--project` any more — either the build/launch recording was unwired \
             (see epic-a-build-or-launch-failure-leaves-no-record) or this guard is now pointing at nothing",
        );
        // The FRONTEND's copy (`@/shared/lib/core/projectPaths`), which lives in the record store. It
        // is the third writer of this string — the boot watchdog, the npm scripts and now the debug
        // session's fault path — and a disagreement would split the app's own faults across stores that
        // each look empty from the others, which is precisely the failure nothing else can see.
        let graph = std::fs::read_to_string(manifest.join("data").join("knowledge").join("algorithms.json"))
            .expect("data/knowledge/algorithms.json");
        let needle = format!("SELF_PROJECT_KEY = \\\"{}\\\"", bsc_util::SELF_PROJECT_KEY);
        assert!(
            graph.contains(&needle),
            "the frontend's SELF_PROJECT_KEY does not match `{}` — the app's faults would split across two stores",
            bsc_util::SELF_PROJECT_KEY,
        );

        for (name, key) in wired {
            assert_eq!(
                key,
                bsc_util::SELF_PROJECT_KEY,
                "npm script `{name}` records into project `{key}`, but the app records its own faults \
                 into `{}` — the two stores would each look empty from the other",
                bsc_util::SELF_PROJECT_KEY,
            );
        }
    }

    /// EVERY seed DIRECTORY ships every file it holds.
    ///
    /// THE HOLE THIS CLOSES, and it shipped green. `studios` and `skills` were `include_dir!`'d —
    /// compiled INTO the binary, so they needed no resource entry. When they moved to a runtime read
    /// (`the-directory-seeds-load-at-runtime-and-a-studio-can-be-written-anywhere`) the embed went
    /// away and nothing replaced it: a shipped build had no built-in Studio presets and seeded no
    /// packaged skills, while every existing guard passed. They all key on `RUNTIME_SEEDS`, which
    /// names FILES and cannot express a directory, so none of them could see it.
    ///
    /// `personas` already had a bespoke version of this check; generalising it is what makes the next
    /// `include_dir!` conversion safe by default rather than by remembering.
    #[test]
    fn every_seed_directory_ships_every_file_it_holds() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let shipped: std::collections::BTreeSet<String> = conf["bundle"]["resources"]
            .as_object()
            .expect("bundle.resources is an object")
            .values()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        // Mirrors `BUNDLED_SEED_DIRS` in build.rs. Duplicated for the same reason BUNDLED_SEEDS is:
        // a build script cannot depend on a workspace lib, and a test is what keeps them honest.
        let mut missing = Vec::new();
        for dir in ["personas", "studios", "skills"] {
            let path = manifest.join("data").join(dir);
            let Ok(entries) = std::fs::read_dir(&path) else {
                panic!("seed directory {} is declared but absent", path.display())
            };
            let mut seen = 0usize;
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                seen += 1;
                let name = p.file_name().and_then(|n| n.to_str()).expect("file name");
                let target = format!("data/{dir}/{name}");
                if !shipped.contains(&target) {
                    missing.push(target);
                }
            }
            assert!(seen > 0, "seed directory {dir} is declared but holds no json — a silent empty ship");
        }
        missing.sort();
        assert!(
            missing.is_empty(),
            "these packaged seed files would NOT ship, so a shipped build serves them from nowhere: \
             {missing:?}. Add a bundle.resources entry for each."
        );
    }

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

    /// EVERY ROLE IS CLASSIFIED BY THE CAGE — caged, or uncaged by decision, and never neither.
    ///
    /// `sandboxPlanFor` on the frontend plans a namespace for any role that is not in `UNCAGED_ROLES`.
    /// This side then refuses to build one for a role `Role::parse` does not know, and the session
    /// launches as a plain shell — with `/bsc-hook` guest paths already written into its settings,
    /// pointing at a mount namespace that does not exist. Every gate fails to execute, NON-BLOCKING,
    /// so the session runs with no write-scope gate and no dangerous-command floor until the launcher
    /// repairs it, on every single launch.
    ///
    /// MEASURED: adding the `operator` role put it in neither list, and that is exactly what happened.
    /// `UNCAGED_ROLES` documents the same failure at 13 repairs in one app run. Both lists were
    /// individually correct and the role fell between them, which no test could see — the mirror test
    /// in `uncagedRoles.test.ts` compares two hardcoded lists to each other, so a role missing from
    /// BOTH is invisible to it. This asserts the POPULATION instead: every role the capability table
    /// knows lands in one bucket or the other.
    #[test]
    fn every_role_is_either_caged_or_uncaged_by_decision() {
        use bsc_sandbox::profile::{Role, UNCAGED_ROLES};
        let baseline: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/shared/lib/session/roleCapabilityBaseline.fixtures.json"
        ))
        .expect("the capability baseline parses");
        let roles: Vec<String> = baseline["roles"]
            .as_object()
            .expect("roles is an object")
            .keys()
            .cloned()
            .collect();
        // The population, so a scanner that stopped matching fails loudly instead of going quiet.
        assert!(roles.len() >= 17, "the baseline should hold every role; got {}", roles.len());

        // A RATCHET, not a clean assertion, because this guard found THREE roles already in the state
        // it was written to prevent. They are listed so the population can only SHRINK: a new role
        // that lands unclassified fails immediately, and clearing one of these is a deliberate edit
        // here. They are not laundered — each needs the same judgement `operator` got (is the cage
        // able to serve its store, and if not, what is the blocker), and none can be answered by
        // guessing. Filed as `three-roles-were-never-classified-by-the-cage`.
        //
        // Whether each MANIFESTS depends on something this side cannot see — `sandboxPlanFor` needs a
        // role actually set on the pane, and a debug-studio pane deliberately carries none. `marketer`
        // is a fleet role and fleet panes do carry theirs, so at least one of these is live.
        const UNCLASSIFIED_LEGACY: &[&str] = &["curator", "debugger", "marketer"];
        let unclassified: Vec<&String> = roles
            .iter()
            .filter(|r| {
                Role::parse(r).is_none()
                    && !UNCAGED_ROLES.iter().any(|(n, _, _)| *n == r.as_str())
                    && !UNCLASSIFIED_LEGACY.contains(&r.as_str())
            })
            .collect();
        // The legacy list may only shrink: an entry that HAS been classified must be removed from it,
        // or the ratchet quietly stops ratcheting.
        let stale: Vec<&&str> = UNCLASSIFIED_LEGACY
            .iter()
            .filter(|r| Role::parse(r).is_some() || UNCAGED_ROLES.iter().any(|(n, _, _)| n == *r))
            .collect();
        assert!(stale.is_empty(), "these are classified now — drop them from UNCLASSIFIED_LEGACY: {stale:?}");
        assert!(
            unclassified.is_empty(),
            "these roles are neither caged nor listed in UNCAGED_ROLES, so the frontend plans a \
             namespace this side then declines — leaving every launch with /bsc-hook paths that \
             resolve to nothing and a session running with no gates: {unclassified:?}"
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

    /// The `tauri dev` watcher must not fire on a change CARGO has declared it does not compile
    /// (#a-record-write-restarts-the-app-the-user-is-using).
    ///
    /// `build.rs` keeps `NON_CONFIG_DIRS` out of the embedded config seed, so a record write does not
    /// invalidate the build. The WATCHER is a separate mechanism and did not know: it watched all of
    /// `src-tauri/`, so writing a component record still triggered a rebuild — a ~1.3s no-op — and then
    /// RELAUNCHED the app under the user working in it.
    ///
    /// Pinned rather than trusted, because the two lists live in different files and the failure is
    /// silent in both directions: a dir added to `NON_CONFIG_DIRS` and not here leaves the watcher
    /// firing on it, and one listed here but still embedded means an edit stops reaching the binary.
    #[test]
    fn the_watch_ignore_covers_every_dir_the_build_leaves_out() {
        let ignore = include_str!("../.taurignore");
        let build_rs = include_str!("../build.rs");
        // The list as build.rs states it, read from the source rather than duplicated here — a third
        // copy would be the very drift this pins.
        let decl = build_rs
            .split("const NON_CONFIG_DIRS: &[&str] = &[")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .expect("build.rs declares NON_CONFIG_DIRS");
        let dirs: Vec<&str> = decl
            .split(',')
            .map(|s| s.trim().trim_matches('"'))
            .filter(|s| !s.is_empty())
            .collect();
        assert!(!dirs.is_empty(), "parsed no dirs out of NON_CONFIG_DIRS: {decl:?}");

        for dir in &dirs {
            assert!(
                ignore.lines().any(|l| l.trim() == format!("data/{dir}/")),
                ".taurignore is missing `data/{dir}/`, so `tauri dev` still rebuilds and RELAUNCHES \
                 the app when a session writes there — a build cargo already skips",
            );
        }

        // And nothing MORE: an entry here for a dir that IS embedded would stop an edit reaching the
        // binary, silently, which build.rs's own comment calls strictly worse than a slow build.
        for line in ignore.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
            let named = line.trim_start_matches("data/").trim_end_matches('/');
            assert!(
                dirs.contains(&named),
                "`{line}` is ignored by the watcher but is NOT in build.rs's NON_CONFIG_DIRS, so it \
                 IS compiled in — an edit to it would silently stop reaching the binary",
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

    /// Seed embeds that are LIVE and not fixed here — each with the item that fixes it.
    ///
    /// This is a KNOWN-RED list, not an allow-list, and the second assertion in the guard is the whole
    /// difference: an entry that stops being an offender FAILS, so the exception cannot outlive its
    /// problem the way a path-keyed excuse does.
    ///
    /// The one entry is what widening the walk to records FOUND, and its history is the item's thesis
    /// in miniature: `d19adce07` (Aug 25) migrated `bsc-sound`'s modules into the graph and deleted the
    /// files; `05aac70b6` (Sep 2) then added `sounds/signal.json` to `RUNTIME_SEEDS` under the title
    /// "the last four crates read data/ at runtime — Class A done". By then this guard could no longer
    /// SEE `release.rs`, so it reported green over a crate it had silently stopped covering, and the
    /// "done" was recorded against a check that was no longer looking.
    const KNOWN_SEED_EMBEDS: &[(&str, &str)] = &[(
        "crates/bsc-sound/src/release.rs",
        "#bsc-sound-still-embeds-the-signal-seed-as-a-record — the fix is a graph-store write \
         (`bsc graph impl set` + `promote` on `bsc-sound--release.rs`), out of scope here",
    )];

    /// Does one source line `include_str!` one of the high-churn packaged seeds?
    ///
    /// The guard's own assertion strings name these files; only an actual macro counts.
    fn is_seed_embed(line: &str, names: &[&str]) -> bool {
        line.contains("include_str!") && names.iter().any(|n| line.contains(n))
    }

    /// Collect `<file>:<line>` for every BARE opening fence inside a doc comment under `dir`.
    ///
    /// Fences pair, and a closer is always bare — so counting bare fences would flag every tagged
    /// block's closer. Tracking open/closed state and reporting only the OPENING one is what makes the
    /// difference between "19 bare fences" (all closers, the real workspace) and a genuine doctest.
    /// State resets at any non-doc line, so an unbalanced fence in one item's docs cannot leak into
    /// the next item's.
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
            ("logs_waiting", "re-derives the queue from coord.log AND activity.log, on a 3s poll"),
            ("logs_sessions", "walks five streams AND the cost rollup, which re-reads every transcript"),
            ("logs_costs", "re-reads every transcript named in tokens.log"),
            ("graph_dump", "reads + reconciles the whole algorithms store (#4078)"),
            ("read_log_tail", "reads an arbitrary log stream from disk"),
            ("fault_rows_batch", "opens one error.db per project; 19.3s/4 calls measured"),
            ("bsc", "spawns the sidecar — the app's hottest process spawner (#4074)"),
        ];

        let units = source_units("src-tauri/src", MIN_SRC_TAURI_UNITS);
        let decls = collect_command_decls(&units);
        // NON-VACUITY: the named list below fails loudly when ONE command disappears, but nothing here
        // noticed the whole surface shrinking — a parser that stopped matching, or a walk that lost
        // half the tree to the graph store, would leave every name unfound and report the same thing.
        assert!(
            decls.len() >= MIN_TAURI_COMMANDS,
            "expected the whole command surface, found {} declarations (floor {MIN_TAURI_COMMANDS})",
            decls.len(),
        );

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

    /// **A DECLARED COMMAND THAT IS NEVER REGISTERED FAILS SILENTLY.** `#[tauri::command]` only makes
    /// a function invokable; `generate_handler!` is what the frontend can actually reach. Miss the
    /// second step and every `invoke("...")` rejects — and the frontend bridge wraps them in
    /// `safeInvoke`, which swallows a rejection and returns the fallback. So the failure mode is not
    /// an error anywhere: it is a feature rendering its EMPTY STATE forever, on a screen, while every
    /// gate stays green.
    ///
    /// Measured when this was written: 174 declared, 174 registered. The list has never actually
    /// drifted — which is why the guard is cheap now and expensive to add after the first time it does.
    #[test]
    fn every_tauri_command_is_registered_in_the_invoke_handler() {
        let units = source_units("src-tauri/src", MIN_SRC_TAURI_UNITS);
        let decls = collect_command_decls(&units);

        // Non-vacuity: a parser that stopped matching — or a walk that lost modules to the graph
        // store — would make this pass while checking nothing.
        assert!(
            decls.len() >= MIN_TAURI_COMMANDS,
            "expected the whole command surface, found {} declarations (floor {MIN_TAURI_COMMANDS})",
            decls.len(),
        );

        // Resolved as a UNIT, not `read_to_string`d: the registration list is exactly the kind of
        // module that migrates, and `.expect("app/run.rs")` would then be a panic about a missing file
        // rather than a guard reading a record.
        let run = unit_text(&units, "app/run.rs", "it is where `generate_handler!` lives");
        let start = run.find("generate_handler!").expect("generate_handler! in app/run.rs");
        // Bracket-match the macro body rather than scanning a fixed window: the list grows, and a
        // truncated window would silently stop covering the commands added at the end of it.
        let body = &run[start..];
        let open = body.find('[').expect("generate_handler! opens a list");
        let mut depth = 0usize;
        let mut end = None;
        for (i, ch) in body[open..].char_indices() {
            match ch {
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let list = &body[open..end.expect("generate_handler! list is closed")];
        // Each entry is a path (`logs::logs_tail`, `crate::fleet::x::y`); the command name is its last
        // segment. Compare on that, so moving a command between modules is not a false failure.
        let registered: std::collections::HashSet<&str> = list
            .split(',')
            .filter_map(|e| e.rsplit("::").next())
            .map(|e| e.trim())
            .filter(|e| !e.is_empty())
            .collect();

        let mut missing: Vec<String> = decls
            .iter()
            .filter(|(name, _)| !registered.contains(name.as_str()))
            .map(|(name, (_, at))| format!("`{name}` at {at}"))
            .collect();
        missing.sort();
        assert!(
            missing.is_empty(),
            "these are #[tauri::command] but are NOT in generate_handler! in app/run.rs, so every \
             invoke of them rejects — and `safeInvoke` turns that into a silent empty result:\n  {}",
            missing.join("\n  "),
        );
    }

    /// Map every `#[tauri::command]` in `units` to `(is_async, "where:line")`. Attribute and
    /// signature can be separated by doc comments and other attributes, so scan forward to the first
    /// `fn` rather than assuming the next line.
    fn collect_command_decls(units: &[SourceUnit]) -> std::collections::HashMap<String, (bool, String)> {
        let mut out: std::collections::HashMap<String, (bool, String)> = Default::default();
        for unit in units {
            let lines: Vec<&str> = unit.text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if !line.trim_start().starts_with("#[tauri::command") {
                    continue;
                }
                for probe in lines.iter().skip(i + 1).take(8) {
                    if let Some(rest) = probe.split(" fn ").nth(1) {
                        let name: String =
                            rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                        out.insert(name, (probe.contains("async fn"), format!("{}:{}", unit.label(), i + 1)));
                        break;
                    }
                }
            }
        }
        out
    }

    /// #a-temporary-script-is-a-missing-bsc-command — EVERY session charter the app ships must tell its
    /// session that needing a temporary script is a MISSING COMMAND to be filed, not a puzzle to route
    /// around, and must name the verb that files it.
    ///
    /// The rule is not new; its REACH was the defect. Four studio charters (architect, designer,
    /// librarian, sound-designer) carried an identical hand-placed block and five other session classes
    /// carried nothing — the integrator, the fleet worker, the director and the fleet architect. Nothing
    /// checked any of it, so a fifth charter could ship with no rule and no failure, which is how the
    /// gap opened in the first place.
    ///
    /// The subject is the SHIPPED SET, walked, not a list kept here: a hand-kept list can only assert
    /// things about files someone remembered to add to it, so the one case it must catch — a NEW charter
    /// without the rule — is precisely the case it would miss.
    ///
    /// ROUTING IS DELIBERATELY NOT UNIFORM, and the test encodes that rather than flattening it. A
    /// worker is denied the global tooling queue on purpose (`worker-protocol.md` says so explicitly)
    /// and files `bsc plan request` to its director; every other charter files the global `bsc request`.
    /// Asserting one verb everywhere would push a command past a permission floor that refuses it, which
    /// Every ASKABLE studio must know that a request is DELIVERED to it, and by which routes.
    ///
    /// THIS ASSERTION INVERTED (#the-loop-comes-out-an-ask-is-just-a-delivery). It used to require the
    /// opposite prose — that a request waits in a loop the session must go and find
    /// (`bsc loop watch --as <you>`, "before you go idle"). That was written when an ask WAS a loop and
    /// the callee had to enter the rendezvous itself. Measured 2026-08-28, across the whole store: 20
    /// ask loops, **0 turns**. Not one was ever found. The three loops that DID work (21 turns) were
    /// the overnight design run, where the app-side pump actuates instead of waiting to be joined —
    /// which is the whole difference, and why delivery replaced discovery rather than joining it.
    ///
    /// So what a charter now owes its session is the opposite of a place to look: the fact that the
    /// request ARRIVES, and what each arrival looks like from the inside. The `interrupt` route matters
    /// most — a turn cut off mid-thought is otherwise indistinguishable from a crash.
    #[test]
    fn every_askable_studio_charter_says_a_request_is_delivered_to_it() {
        // One charter per role backing an entry in `SYSTEM_SESSIONS` — every session `bsc session ask`
        // can target. The INTEGRATOR is included: it is a system session (`integration-studio:integrator`)
        // and always was, and the list this replaces excused its absence with the false claim that it is
        // not one. Delivery reaches it whether or not its charter says so, which is exactly why nothing
        // caught the gap.
        const ASKABLE: [&str; 5] = [
            "architect/claude.md",
            "designer/claude.md",
            "integrator/claude.md",
            "librarian/claude.md",
            "sound-designer/claude.md",
        ];

        for rel in ASKABLE {
            let md = crate::platform::config::embedded_str(rel);
            assert!(!md.trim().is_empty(), "{rel} must be packaged and non-empty");
            // The headline claim: it comes to you.
            assert!(
                md.contains("a request is DELIVERED"),
                "{rel} must say a request is delivered rather than waiting to be found:\n{md}",
            );
            // All three arrivals, because each one looks different from inside the session.
            assert!(
                md.contains("you were stopped") && md.contains("you were idle") && md.contains("you were working"),
                "{rel} must name all three states — the route taken is what the session experiences:\n{md}",
            );
            // The interrupt is the one that needs explaining: an abruptly-ended turn is otherwise
            // indistinguishable from a crash, and a session that reads it as a crash re-does its work.
            assert!(
                md.contains("--on-busy interrupt"),
                "{rel} must explain the interrupt route, or a cut-off turn reads as a failure:\n{md}",
            );
            // THE LOOP, and the verb that continues it. A request now carries the exchange it belongs
            // to (#an-ask-is-a-loop-again-and-every-turn-is-delivered), and a charter that describes
            // only the arrival leaves the session holding an answer it cannot send.
            assert!(
                md.contains("bsc session reply"),
                "{rel} must name the verb that answers, or the reply has nowhere to go:\n{md}",
            );
            // ...and the reason the loop came back at all: a studio that cannot finish must be able to
            // ASK rather than guess or stop. Said in the imperative, because the old prose told it the
            // opposite — that nothing was coming back.
            assert!(
                md.contains("YOU DO NOT HAVE TO GUESS"),
                "{rel} must tell the session it may pause and ask instead of guessing:\n{md}",
            );
            // A charter must NOT still send the session to the retired discovery surface.
            assert!(
                !md.contains("bsc loop watch --as <you>"),
                "{rel} still tells the session to go find its request in a loop — that surface is retired:\n{md}",
            );
        }
    }

    /// a model reads as a broken environment rather than as policy.
    #[test]
    fn every_session_charter_says_a_temporary_script_is_a_missing_command() {
        // The canonical marker, identical in every charter so this test has one thing to look for.
        const MARKER: &str = "A TEMPORARY SCRIPT IS A MISSING COMMAND";
        // The worker's ask belongs to its director; everyone else files on the global tooling queue.
        const WORKER_ONLY_LANE: &str = "fleet/worker-protocol.md";

        let mut charters = crate::platform::config::embedded_paths_ending_with("claude.md");
        charters.extend(crate::platform::config::embedded_paths_ending_with("-protocol.md"));
        charters.sort();

        // The walk must actually find the surface — an empty list would make every assertion below
        // vacuous and the test would "pass" while checking nothing.
        assert!(
            charters.len() >= 8,
            "expected the packaged charter set (5 studio claude.md + 3 fleet protocols), found {charters:?}",
        );

        for rel in &charters {
            let md = crate::platform::config::embedded_str(rel);
            assert!(!md.trim().is_empty(), "{rel} must be packaged and non-empty");
            assert!(
                md.contains(MARKER),
                "{rel} must carry the rule verbatim as `{MARKER}` — a new charter does not get to ship without it:\n{md}",
            );
            // Naming the rule without naming the verb leaves a session knowing it may not improvise and
            // not knowing what to do instead, which is worse than saying nothing.
            let verb = if rel == WORKER_ONLY_LANE { "bsc plan request new" } else { "bsc request new" };
            assert!(md.contains(verb), "{rel} must name `{verb}` as the way to file the gap:\n{md}");
        }

        // The worker's lane stays separate. `bsc plan request new` CONTAINS neither more nor less than
        // itself, so the check is that the protocol never points a worker at the global queue as
        // something it may file on — the deny sentence is allowed to mention it, and does.
        let worker = crate::platform::config::embedded_str(WORKER_ONLY_LANE);
        assert!(
            worker.contains("denied to you"),
            "the worker protocol must keep stating that the global tooling queue is not its lane:\n{worker}",
        );

        // The trigger is scoped, in every copy. Without this the rule reads as "never use a pipeline",
        // which a session with a real shell would discard wholesale — taking the useful half with it.
        for rel in &charters {
            let md = crate::platform::config::embedded_str(rel);
            assert!(
                md.contains("OPERATION") || md.contains("inspection"),
                "{rel} must draw the line between an operation (file it) and reading (fine):\n{md}",
            );
        }
    }
