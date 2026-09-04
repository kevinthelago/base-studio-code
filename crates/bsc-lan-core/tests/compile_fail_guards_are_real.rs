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

use std::path::{Path, PathBuf};

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The `use` lines inside every ```` ```compile_fail ```` fence in this crate,
/// paired with the file they came from.
fn imports_inside_compile_fail_fences() -> Vec<(String, String)> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_sources(&src, &mut files);
    files.sort();

    let mut found = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).expect("source file is readable");
        let name = file
            .strip_prefix(env!("CARGO_MANIFEST_DIR"))
            .unwrap_or(&file)
            .display()
            .to_string();

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
    let imports = imports_inside_compile_fail_fences();

    // A scanner that silently stopped matching reports zero findings, which
    // reads as a pass. Assert the population first, so the guard fails loudly
    // if the fence syntax or the doc-comment style ever changes underneath it.
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
