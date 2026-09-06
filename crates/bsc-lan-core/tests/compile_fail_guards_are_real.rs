//! Guards the guards: a `compile_fail` doctest passes when its block fails to
//! compile **for any reason at all**, so one that has quietly stopped testing
//! what it claims to test is indistinguishable from one that works.
//!
//! ## This is not hypothetical -- it was measured during the fold
//!
//! `bsc-lan-core` was folded out of the networkmonitor repo's `netcon-core` on
//! 2026-09-04. Its two `compile_fail` doctests carried `# use netcon_core::…`
//! imports. Left unrenamed they still PASSED, because an unresolved extern
//! crate (E0432) is a compile failure just as much as the non-exhaustive match
//! (E0004) the block exists to demonstrate. Both guards would have been inert
//! and nothing would have said so.
//!
//! ## Why the error-code annotation is not the fix
//!
//! rustdoc accepts ```` ```compile_fail,E0004 ```` and **stable rustdoc does
//! not verify the code**. MEASURED the same day: with the stale `netcon_core`
//! import AND `,E0004` pinned, the doctest still reported `ok`. The annotation
//! is kept in the source as documentation of intent -- and would start being
//! enforced for free if rustdoc ever stabilises the check -- but it is NOT
//! what makes the guarantee hold. This test is.
//!
//! ## Where the source it scans lives
//!
//! This crate's modules are RECORDS in `graph/algorithms.json`, not files under
//! `src/`. So the scan reads what the COMPILER actually reads: the materialized
//! `$OUT_DIR/crate.rs` emitted by `graph-materialize/build.rs`, plus the one
//! module that stays a real file (`src/lib.rs`). Walking `src/` after the
//! migration would find one file and report zero findings, which reads as a
//! pass -- the exact silent-scanner failure the population floors below exist
//! to make impossible.

use std::path::Path;

/// Every module of this crate, as `(name, source text)`.
///
/// The materialized file is split on the marker `graph-materialize` emits at
/// the head of every module (`// record `<id>` — line N here is …`), so an
/// offender is named by its RECORD id rather than by a filename that no longer
/// exists. Nested modules (`adapters::*`) get their own section, because the
/// marker is emitted per unit at every depth.
fn crate_sections() -> Vec<(String, String)> {
    let materialized = Path::new(env!("OUT_DIR")).join("crate.rs");
    let text = std::fs::read_to_string(&materialized).unwrap_or_else(|e| {
        panic!("cannot read the materialized crate at {}: {e}", materialized.display())
    });

    let mut sections: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        if let Some(id) =
            line.trim_start().strip_prefix("// record `").and_then(|r| r.split('`').next())
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

    sections
}

/// The `use` lines inside every ```` ```compile_fail ```` fence in this crate,
/// paired with the module they came from.
fn imports_inside_compile_fail_fences() -> Vec<(String, String)> {
    let mut found = Vec::new();
    for (name, text) in crate_sections() {
        let mut inside = false;
        for line in text.lines() {
            // Doc-comment fences are `/// ```…` or `//! ```…`; strip the
            // comment marker before looking at the fence itself.
            let body = line
                .trim_start()
                .trim_start_matches("///")
                .trim_start_matches("//!")
                .trim();

            if body.starts_with("```") {
                let info = body.trim_start_matches('`');
                if inside {
                    inside = false; // closing fence
                } else if info.split(',').any(|t| t.trim() == "compile_fail") {
                    inside = true;
                }
                continue;
            }

            if inside {
                let stmt = body.trim_start_matches('#').trim();
                if let Some(rest) = stmt.strip_prefix("use ") {
                    found.push((name.clone(), rest.trim().to_string()));
                }
            }
        }
    }
    found
}

#[test]
fn every_compile_fail_doctest_imports_this_crate_by_its_real_name() {
    let sections = crate_sections();

    // FLOOR ONE: the scanner is reading the crate at all. A materialized file
    // that failed to emit, or a marker whose format drifted, yields zero
    // sections -- and a scan of nothing finds nothing, which reads as a pass.
    assert!(
        sections.len() >= 15,
        "found only {} module section(s) to scan, so this scanner is not reading \
         the crate and its silence means nothing. This crate's modules are records \
         in graph/algorithms.json, materialized into $OUT_DIR/crate.rs by \
         graph-materialize/build.rs; the split marker is `// record `<id>``. Found: {:?}",
        sections.len(),
        sections.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>()
    );

    let imports = imports_inside_compile_fail_fences();

    // FLOOR TWO: the fence parser still matches. A scanner that silently
    // stopped matching reports zero findings, which also reads as a pass.
    assert!(
        imports.len() >= 2,
        "found only {} `use` line(s) inside compile_fail fences, expected at least 2 \
         (Action's E0004 exhaustiveness guard and FirewallLogWitness's E0451 sealing \
         guard). Either a guard was deleted, or this scanner has stopped parsing the \
         fences and its silence means nothing. Found: {imports:?}",
        imports.len()
    );

    let lib_name = "bsc_lan_core";
    for (file, import) in &imports {
        let root = import
            .split("::")
            .next()
            .unwrap_or_default()
            .trim()
            .trim_end_matches(';');
        assert_eq!(
            root, lib_name,
            "{file}: a compile_fail doctest imports `{root}`, but this crate's lib is \
             `{lib_name}`. The block therefore fails to compile because the crate does not \
             resolve (E0432) rather than for the reason it documents, so the guard is inert \
             while still reporting `ok`. This is exactly how the netcon-core fold nearly \
             shipped two dead guards on 2026-09-04."
        );
    }
}
