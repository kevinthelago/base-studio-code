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
