//! `bsc graph migrate-crate <crate> [--apply]` — move one crate's source into the graph.
//!
//! The mechanical half of files-to-zero. `bsc-blueprint` was migrated by hand to prove the pipeline;
//! this is that sequence written down so crates 3..N cost a command rather than a session.
//!
//! For each top-level module of `crates/<crate>/src/` except the crate root:
//!   1. harvest it as ONE module-shaped record with a PATH-derived id
//!   2. record HOW it was declared (`moduleVis` / `moduleAttrs`)
//!   3. promote it into the committed store the build reads
//!   4. drop its `mod <name>;` from the root and delete the file
//!
//! …then opt the crate in (`build = "../graph-materialize/build.rs"`), append the single `include!`,
//! and verify with a real build and the crate's own tests.
//!
//! # A VERB, not a script (`record-operations-belong-on-the-bsc-surface-not-in-scripts`)
//!
//! This began as `scripts/graph-migrate-crate.mjs`, and moving it here is not tidying. Per
//! `src-tauri/data/permissions/base.json`, `bsc` is the MANDATORY tier — auto-runnable by every role,
//! no grant needed — while `node scripts/…` needs the BUILD tier, which the sessions that should drive
//! a migration are least likely to hold. The script was also undiscoverable: `bsc help` lists the
//! nouns, and nothing anywhere advertised a file under `scripts/`.
//!
//! Being in-process buys two things the script could not have. Every operation is ONE implementation —
//! the same `cli::run` arms a human would type, so this tool and the CLI can never disagree about what
//! `harvest` means. And it never has to FIND a `bsc` binary: the script carried `pickUsable` for
//! exactly that, and this repo has repeatedly produced a 0-byte `target/debug/bsc` mid-build.
//!
//! # DRY BY DEFAULT, and that is not politeness
//!
//! Without `--apply` it prints the plan and touches nothing. The write path deletes source files and
//! edits a committed store. A migration tool that runs by default is a migration tool that runs by
//! accident.
//!
//! # It does NOT check prose, and the gate does
//!
//! Deleting a module breaks any markdown link pointing at its file — `docs/backend.md` and
//! `relay/README.md` both linked at `crates/bsc-tunnel/src/*.rs` and went red in `docLinks.test.ts`.
//! That guard already runs in the gate, so this does not duplicate it; expect prose to need updating in
//! the same change, pointing at the RECORD.
use std::path::Path;

/// The shared build script a migrated crate opts into, as it appears in its `Cargo.toml`.
pub const MARKER: &str = r#"build = "../graph-materialize/build.rs""#;

/// One `(pub )?mod name;` declaration, with everything attached to it that carries meaning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleDecl {
    pub name: String,
    /// `pub mod` vs a private `mod`. `build.rs` emits what this says, not an assumption.
    pub public: bool,
    /// The declaration line verbatim.
    pub line: String,
    /// The whole contiguous block this declaration owns — its attributes and docs in the order the
    /// AUTHOR wrote them, through the declaration line itself.
    ///
    /// Stored verbatim rather than reconstructed from `docs` + `attrs`. Rust accepts either order, and
    /// a reconstruction that guessed wrong simply did not match the source, so the removal silently
    /// removed NOTHING and left the declaration in a crate whose file had been deleted. This repo has
    /// no doc-above-attribute declarations today (measured: 0), which is exactly why the bug would have
    /// waited for the first one.
    pub block: String,
    /// The contiguous `///` block directly above it.
    pub docs: Vec<String>,
    /// The `#[…]` attributes directly above it.
    pub attrs: Vec<String>,
}

/// The `(pub )?mod name;` declarations in a crate root, with their docs and attributes.
///
/// `mod tests` is never one — an inline test module has no file to migrate.
///
/// The doc block and the attributes are collected because they must LEAVE WITH the declaration. A
/// leftover `///` makes clippy reject the file ("empty lines after doc comment") and loses prose from a
/// crate that no longer holds the module it described. A leftover `#[…]` is worse than untidy: in
/// `crates/llm` an orphaned `#[cfg(test)]` landed on `pub use anthropic::AnthropicProvider;` and
/// compiled that re-export out of every non-test build.
pub fn module_decls(lib_src: &str) -> Vec<ModuleDecl> {
    let lines: Vec<&str> = lib_src.split('\n').collect();
    let mut out = Vec::new();
    for (i, raw) in lines.iter().enumerate() {
        let Some((public, name)) = parse_mod_line(raw) else { continue };
        if name == "tests" {
            continue;
        }
        // ONE upward walk taking both kinds, so `/// doc` above `#[attr]` and `#[attr]` above
        // `/// doc` are both understood. Stops at the first line that is neither.
        let mut docs: Vec<String> = Vec::new();
        let mut attrs: Vec<String> = Vec::new();
        let mut j = i;
        while j > 0 {
            let prev = lines[j - 1].trim_start();
            if prev.starts_with("///") {
                docs.insert(0, lines[j - 1].to_string());
            } else if prev.starts_with("#[") {
                attrs.insert(0, lines[j - 1].to_string());
            } else {
                break;
            }
            j -= 1;
        }
        out.push(ModuleDecl {
            name: name.to_string(),
            public,
            line: (*raw).to_string(),
            block: lines[j..=i].join("\n"),
            docs,
            attrs,
        });
    }
    out
}

/// `(pub )?mod <name>;` on a line of its own, or `None`. Returns whether it was `pub`.
///
/// Deliberately line-shaped rather than a parse: the rewrite removes the matched LINE, so anything this
/// recognizes must be removable as one. A `mod x { … }` inline module is not matched and not migrated.
fn parse_mod_line(line: &str) -> Option<(bool, &str)> {
    let t = line.trim();
    let (public, rest) = match t.strip_prefix("pub ") {
        Some(r) => (true, r.trim_start()),
        None => (false, t),
    };
    let rest = rest.strip_prefix("mod ")?;
    let name = rest.strip_suffix(';')?.trim();
    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }
    Some((public, name))
}

/// The parent's `/// …` for a module, rewritten as the `//! …` that belongs at the top of its body.
///
/// Legal because `build.rs` writes a LITERAL `pub mod x { … }`, and an inner doc at the start of a
/// module block documents that module — exactly what the outer doc was doing from the parent. So the
/// prose moves WITH the code instead of being deleted alongside a declaration.
pub fn docs_as_inner(docs: &[String]) -> Vec<String> {
    docs.iter().map(|l| l.trim().replacen("///", "//!", 1)).collect()
}

/// The module source with the parent's `///` docs carried in as its own `//!` header — `None` when
/// nothing should be written.
///
/// Carrying happens only onto an UNDOCUMENTED module. A module that already opens with `//!` states
/// what it is, and prepending the parent's one-line summary leaves the record with two headers saying
/// nearly the same thing — measured on the earlier rollout, 5 of 91 migrated records carry that
/// duplication. Where both exist the module's own block is the real documentation and the parent's line
/// is a table-of-contents entry, so the module's wins.
pub fn with_carried_docs(module_src: &str, docs: &[String]) -> Option<String> {
    if docs.is_empty() || module_src.trim_start().starts_with("//!") {
        return None;
    }
    Some(format!("{}\n{}", docs_as_inner(docs).join("\n"), module_src))
}

/// The record-id fragment for a Rust module name — the DRY-RUN prediction only; the apply path reads
/// the real id back from the harvest.
///
/// `extract::module_id` kebabs each path segment and a Rust module name is snake_case, so kebabing is
/// exactly a `_` → `-` swap. This must agree with the `expected` id in `graph-materialize/build.rs`,
/// which selects a record by it.
pub fn module_record_id(module_name: &str) -> String {
    module_name.replace('_', "-")
}

/// What this crate holds, as [`refuse_reason`] needs to see it.
pub struct CrateShape<'a> {
    pub cargo_toml: &'a str,
    pub lib_src: &'a str,
    /// The `*.rs` file names directly under `src/`.
    pub top_files: &'a [String],
    /// How many DIRECTORIES sit under `src/` — each one is a nested module tree.
    pub nested_count: usize,
    /// `lib.rs` or `main.rs`, whichever this crate has.
    pub root_name: &'a str,
    /// Each declared module's source, by module name. Empty is allowed — the include check simply
    /// finds nothing — so a caller that cannot read a file does not turn into a false refusal.
    pub module_sources: &'a [(String, String)],
}

/// Every path literal passed to an `include_str!` in `src`.
///
/// Deliberately a text scan, not a parse: the shapes in this tree are `include_str!("x.rs")` and
/// `include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/x.rs"))`, and both are answered by taking the
/// LAST string literal before the closing paren. A parser would be more correct and would not change a
/// single verdict here.
fn include_str_targets(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (at, _) in src.match_indices("include_str!") {
        let rest = &src[at..];
        let end = rest.find(')').unwrap_or(rest.len());
        let head = &rest[..end];
        // The last quoted literal in the macro call is the path in both shapes above.
        let mut last: Option<String> = None;
        let mut it = head.char_indices().peekable();
        while let Some((i, c)) = it.next() {
            if c != '"' { continue; }
            if let Some(close) = head[i + 1..].find('"') {
                last = Some(head[i + 1..i + 1 + close].to_string());
                while let Some(&(j, _)) = it.peek() {
                    if j <= i + close + 1 { it.next(); } else { break; }
                }
            }
        }
        if let Some(l) = last { out.push(l); }
    }
    out
}

/// Why this crate cannot be migrated by this tool, or `None` when it can.
///
/// Every refusal here was a real failure first. Refusing UP FRONT is the feature: reached late, a
/// migration has already written records for a crate that will not complete, and the message names a
/// symptom instead of a cause.
pub fn refuse_reason(shape: &CrateShape<'_>) -> Option<String> {
    if shape.cargo_toml.contains(MARKER) {
        return Some(format!("already migrated — its Cargo.toml carries {MARKER}"));
    }
    if shape.nested_count > 0 {
        return Some(format!(
            "has {} NESTED module director(y/ies); build.rs materializes direct children of src/ only",
            shape.nested_count
        ));
    }
    let decls = module_decls(shape.lib_src);
    if decls.is_empty() {
        return Some(format!("{} declares no modules — there is nothing to migrate", shape.root_name));
    }
    let missing: Vec<&str> = decls
        .iter()
        .filter(|d| !shape.top_files.iter().any(|f| f == &format!("{}.rs", d.name)))
        .map(|d| d.name.as_str())
        .collect();
    if !missing.is_empty() {
        return Some(format!(
            "{} declares [{}] with no matching file at src/<name>.rs",
            shape.root_name,
            missing.join(", ")
        ));
    }
    // A `*_test.rs` / `*_tests.rs` module CANNOT be harvested: `is_test_file` in `extract::language_for`
    // gates the whole file out deliberately (#4136 — a test file carries no production implementation).
    // It is a real module all the same (`bsc-json-store` declares `#[cfg(test)] mod surface_tests;`), so
    // the crate cannot reach the floor until that rule and this migration are reconciled.
    //
    // Reached late this produced an empty harvest and the message "harvest reported no id — refusing to
    // guess one", which names the symptom and not the cause — and the modules harvested BEFORE it had
    // already been written to the runtime store, leaving records for a crate that never migrated.
    let test_only: Vec<&str> = decls
        .iter()
        .filter(|d| d.name.ends_with("_test") || d.name.ends_with("_tests"))
        .map(|d| d.name.as_str())
        .collect();
    if !test_only.is_empty() {
        return Some(format!(
            "module(s) [{}] are named *_test/*_tests, which harvest skips as test files (is_test_file, \
             #4136) — the record cannot be created, so the file cannot be retired",
            test_only.join(", ")
        ));
    }
    // A module that reads a file THIS MIGRATION DELETES cannot survive it, and `absolutize_includes`
    // makes that failure quieter rather than louder: it faithfully rewrites the path so it resolves from
    // `$OUT_DIR`, which turns "cannot resolve" into "No such file or directory" four steps later, at
    // compile time, naming a generated file in `target/`.
    //
    // REAL: `bsc-persona/src/cli.rs` carried `include_str!("cli.rs")` — a test reading ITS OWN SOURCE to
    // assert that `run` intercepts `remove` but not `set`. Perfectly reasonable as a file; impossible as
    // a record, because the file is the thing being retired.
    //
    // Narrow on purpose. `bsc-agent` includes `../data/agent-instructions.md`, which SURVIVES — that is
    // exactly the case `absolutize_includes` was written for, and refusing it would put back the blocker
    // that change removed. So the test is not "does it include anything", it is "does it include one of
    // the files this migration is about to delete".
    let doomed: Vec<&str> = decls.iter().map(|d| d.name.as_str()).collect();
    for (module, src) in shape.module_sources {
        for target in include_str_targets(src) {
            let stem = target.rsplit('/').next().unwrap_or(&target).trim_end_matches(".rs");
            if target.ends_with(".rs") && doomed.contains(&stem) {
                return Some(format!(
                    "src/{module}.rs reads `{target}` with include_str!, and src/{stem}.rs is one of the \
                     files this migration deletes — the record cannot read a file that no longer exists. \
                     Rewrite that read (or move what it asserts onto the record) first"
                ));
            }
        }
    }
    // A relative `include_str!` USED TO BE REFUSED HERE and was the single largest blocker (5 crates).
    // It is not one any more: `absolutize_includes` rewrites it at harvest to
    // `concat!(env!("CARGO_MANIFEST_DIR"), "/src/<original>")`, which resolves from `$OUT_DIR` too.
    //
    // No replacement check is added, and a defensive one would be worse than nothing: the migration
    // VERIFIES with a real build before it finishes, so a shape the rewrite mishandles surfaces as the
    // compiler's own message rather than as a guess made here.
    None
}

/// The header block a migrated crate root carries in place of its module declarations.
fn include_block(krate: &str, decls: &[ModuleDecl]) -> String {
    let files: Vec<String> = decls.iter().map(|d| format!("src/{}.rs", d.name)).collect();
    [
        "// This crate's modules are IN THE GRAPH, not in this directory.".to_string(),
        format!(
            "// {} {} — {} in the",
            files.join(", "),
            if files.len() == 1 { "does not exist" } else { "do not exist" },
            if files.len() == 1 { "it is a record" } else { "they are records" }
        ),
        "// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script."
            .to_string(),
        "// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:"
            .to_string(),
        format!("//     bsc graph impl get {krate}--<module>.rs"),
        format!("//     bsc graph impl set --id {krate}--<module>.rs --code-file <f>"),
        format!("//     bsc graph promote --id {krate}--<module>.rs"),
        "//".to_string(),
        "// This header stays a file because include! refuses crate-level //! docs and #![…] inner"
            .to_string(),
        "// attributes (E0753 / \"an inner attribute is not permitted in this context\").".to_string(),
        r#"include!(concat!(env!("OUT_DIR"), "/crate.rs"));"#.to_string(),
    ]
    .join("\n")
}

/// The crate root with its module declarations removed and the single `include!` appended.
///
/// The attributes and the doc block leave WITH the declaration they belong to — see [`module_decls`]
/// for what a leftover one did to `crates/llm`.
pub fn rewrite_lib(lib_src: &str, decls: &[ModuleDecl], krate: &str) -> Result<String, String> {
    let mut out = lib_src.to_string();
    for d in decls {
        let block = format!("{}\n", d.block);
        // A removal that did not happen must NOT be silent. Returning the text unchanged would leave a
        // `mod x;` pointing at a file the apply path is about to delete, and the first thing anyone
        // would see is an unresolved-module error with nothing connecting it to this step.
        let at = out.find(&block).ok_or_else(|| {
            format!("cannot locate the declaration block for `mod {}` to remove it", d.name)
        })?;
        out.replace_range(at..at + block.len(), "");
    }
    Ok(format!("{}\n\n{}", out.trim_end(), include_block(krate, decls)))
}

/// The PACKAGE name, which is not always the directory name — `crates/data` is `bsc-data`.
///
/// The verification step runs `cargo build -p <name>`, and cargo answers an unknown package with a hard
/// error. Using the directory name meant the build and tests for `data` never ran at all, and the tool
/// reported a failure for a crate that was fine. **A verification step that silently does not run is
/// worse than none, because it is indistinguishable from one that passed.**
pub fn package_name(cargo_toml: &str, dir_name: &str) -> String {
    for line in cargo_toml.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("name") {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix('=') {
                let v = v.trim();
                if let Some(inner) = v.strip_prefix('"').and_then(|s| s.split('"').next()) {
                    if !inner.is_empty() {
                        return inner.to_string();
                    }
                }
            }
        }
    }
    dir_name.to_string()
}

/// `Cargo.toml` with the shared build script and the build-dependency it needs.
pub fn opt_in(cargo_toml: &str) -> String {
    let mut out = cargo_toml.to_string();
    if !out.contains(MARKER) {
        // After the `edition` line, which every crate in this workspace has.
        if let Some(idx) = out.lines().position(|l| l.trim_start().starts_with("edition")) {
            let mut lines: Vec<String> = out.lines().map(str::to_string).collect();
            lines.insert(idx + 1, MARKER.to_string());
            out = lines.join("\n");
            if cargo_toml.ends_with('\n') && !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    if !out.lines().any(|l| l.trim() == "[build-dependencies]") {
        let dep = "[build-dependencies]\n\
                   # build.rs parses the committed graph store directly — see crates/graph-materialize/build.rs.\n\
                   serde_json = \"1\"\n\n";
        if let Some(at) = out.find("[lib]") {
            out.insert_str(at, dep);
        } else {
            out = format!("{}\n\n{}", out.trim_end(), dep.trim_end());
            out.push('\n');
        }
    }
    out
}

/// The crate root this crate declares its modules in — `main.rs` for a BINARY crate.
///
/// `bsc` and `bsc-agent` declare every module in `main.rs` and have no `lib.rs` at all, so keying on
/// `lib.rs` reported them as having nothing to migrate — 9 files that looked like floor and were not.
/// A binary `include!`s the generated file exactly as a lib does; only the file the declarations live
/// in differs.
pub fn crate_root(src_dir: &Path) -> Option<std::path::PathBuf> {
    ["lib.rs", "main.rs"].iter().map(|n| src_dir.join(n)).find(|p| p.is_file())
}

/// One module's outcome, so a caller sees what was harvested rather than a bare exit code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migrated {
    pub module: String,
    pub id: String,
}

/// Undo the doc-carry rewrites if the migration aborts.
///
/// The doc-carry edits files that are ABOUT to be deleted, which is free on the success path and a
/// silent working-tree modification on every other one. An earlier run aborted at its third module and
/// left `surface.rs` carrying a duplicated header, under a message saying no file had been touched.
struct Rollback(Vec<(std::path::PathBuf, String)>);

impl Rollback {
    fn restore(&self) -> usize {
        for (f, bytes) in &self.0 {
            let _ = std::fs::write(f, bytes);
        }
        self.0.len()
    }
}

/// Run a delegated `bsc graph …` verb with its output CAPTURED, folding what it said into the error.
///
/// The driver delegates every write to the same `cli::run` arm a human would type — that is what keeps
/// this tool and the CLI from drifting about what `harvest` means. The cost is that those arms `emit`
/// their full record JSON, so one module buried two lines of progress under three enormous blobs.
///
/// It was never merely noisy. A record blob carries THE CRATE'S OWN SOURCE, so the output cannot be
/// filtered by the obvious means: `grep "^  harvested"` still returns everything (a blob is one line),
/// and `grep -oE "REFUSED.*"` matched the word REFUSED inside `bsc-navigate`'s own help text and read a
/// SUCCESSFUL migration as a refusal. Both happened while migrating the single-module batch.
///
/// `capture_output` is the mechanism the warm server already uses (#4152) and is documented to nest, so
/// this adds no second suppression path. Capturing rather than discarding is the point: on failure the
/// verb's own words go into the error. A quiet tool that also goes silent when it breaks would be a
/// worse bug than the noise it fixed.
fn delegate(args: Vec<String>, what: &str) -> Result<(), String> {
    let (res, said) = bsc_util::capture_output(|| crate::cli::run(args, "bsc graph"));
    res.map_err(|e| {
        let said = said.trim();
        if said.is_empty() { format!("{what}: {e}") } else { format!("{what}: {e}\n{said}") }
    })
}

/// `bsc graph migrate-crate <crate> [--apply] [--root <dir>]`.
pub fn run(args: &[String], out: &mut dyn std::io::Write) -> Result<(), String> {
    let krate = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .ok_or("usage: bsc graph migrate-crate <crate> [--apply]")?
        .clone();
    let apply = args.iter().any(|a| a == "--apply");
    let root = args
        .iter()
        .position(|a| a == "--root")
        .and_then(|i| args.get(i + 1))
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?);

    let dir = root.join("crates").join(&krate);
    let src_dir = dir.join("src");
    let root_path = crate_root(&src_dir)
        .ok_or_else(|| format!("crates/{krate}/src has neither lib.rs nor main.rs"))?;
    let root_name = root_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let cargo_path = dir.join("Cargo.toml");
    let cargo_toml = std::fs::read_to_string(&cargo_path)
        .map_err(|e| format!("cannot read {}: {e}", cargo_path.display()))?;
    let lib_src = std::fs::read_to_string(&root_path)
        .map_err(|e| format!("cannot read {}: {e}", root_path.display()))?;

    let mut top_files: Vec<String> = Vec::new();
    let mut nested_count = 0usize;
    for e in std::fs::read_dir(&src_dir).map_err(|e| format!("cannot list {}: {e}", src_dir.display()))? {
        let e = e.map_err(|e| e.to_string())?;
        if e.path().is_dir() {
            nested_count += 1;
        } else if e.file_name().to_string_lossy().ends_with(".rs") {
            top_files.push(e.file_name().to_string_lossy().to_string());
        }
    }

    // Read each declared module's source so the include check can see it. A file that cannot be read
    // contributes an empty string rather than an error: the refusal below is a guard, and a guard that
    // fails the whole migration because one file was unreadable would be worse than the gap it closes.
    let module_sources: Vec<(String, String)> = module_decls(&lib_src)
        .iter()
        .map(|d| {
            let body = std::fs::read_to_string(src_dir.join(format!("{}.rs", d.name))).unwrap_or_default();
            (d.name.clone(), body)
        })
        .collect();
    let shape = CrateShape {
        cargo_toml: &cargo_toml,
        lib_src: &lib_src,
        top_files: &top_files,
        nested_count,
        root_name: &root_name,
        module_sources: &module_sources,
    };
    if let Some(why) = refuse_reason(&shape) {
        return Err(format!("REFUSED {krate}: {why}"));
    }
    let decls = module_decls(&lib_src);

    writeln!(out, "\n{} {krate} — {} module(s):", if apply { "migrating" } else { "would migrate" }, decls.len())
        .map_err(|e| e.to_string())?;
    for d in &decls {
        writeln!(out, "  src/{}.rs  ->  record {krate}--{}.rs", d.name, module_record_id(&d.name))
            .map_err(|e| e.to_string())?;
    }
    if !apply {
        writeln!(out, "\nDRY RUN — pass --apply to write.").map_err(|e| e.to_string())?;
        return Ok(());
    }

    // ── harvest, one module at a time ───────────────────────────────────────────────────────────
    let mut rollback = Rollback(Vec::new());
    let mut done: Vec<Migrated> = Vec::new();
    for d in &decls {
        let file = src_dir.join(format!("{}.rs", d.name));
        let original = std::fs::read_to_string(&file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        if let Some(carried) = with_carried_docs(&original, &d.docs) {
            rollback.0.push((file.clone(), original.clone()));
            std::fs::write(&file, carried).map_err(|e| format!("cannot write {}: {e}", file.display()))?;
        }
        // The id is READ from the harvest, never reconstructed. `module_id` kebabs each path segment, so
        // `log_streams.rs` becomes `…--log-streams.rs`; guessing the underscore form promoted an id that
        // did not exist, promote reported it missing, and the build failed on an unresolved import four
        // steps downstream.
        let rel = format!("crates/{krate}/src/{}.rs", d.name);
        let id = crate::extract::harvest_module(&root.join(&rel), &root)
            .map(|c| c.id)
            .ok_or_else(|| {
                let n = rollback.restore();
                format!(
                    "harvest of src/{}.rs produced no candidate — refusing to guess an id.{}",
                    d.name,
                    if n > 0 { format!(" Restored {n} file(s) the doc-carry had rewritten.") } else { String::new() }
                )
            })?;
        // Delegate the WRITE to the same arm a human would type, so this tool and the CLI can never
        // disagree about what `harvest --module --apply` means.
        //
        // NOTE the argv shape: `cli::run` receives what follows `bsc graph`, so the noun is NOT repeated
        // here. Passing it made the verb read as `graph`, which is unknown — and an unknown verb prints
        // the whole help and exits 1 rather than reporting an error, so it looks like a usage mistake by
        // the CALLER instead of a bug in the call.
        delegate(
            ["harvest", &rel, "--module", "--apply"].iter().map(|s| s.to_string()).collect(),
            &format!("harvesting src/{}.rs", d.name),
        )
        .inspect_err(|_| {
            rollback.restore();
        })?;
        // Record HOW it was declared, so materializing reproduces the program rather than a widened,
        // ungated approximation of it. Attributes go through a FILE — `#[cfg(feature = "x")]` on a
        // command line loses its quotes and brackets silently.
        let mut set: Vec<String> = ["impl", "set", "--tech", "rust", "--id", &id, "--role", "algorithm",
                                    "--name", &d.name, "--module-vis", if d.public { "pub" } else { "private" }]
            .iter().map(|s| s.to_string()).collect();
        let attrs_file = src_dir.join(format!(".attrs-{}", d.name));
        if !d.attrs.is_empty() {
            let body = d.attrs.iter().map(|a| a.trim()).collect::<Vec<_>>().join("\n");
            std::fs::write(&attrs_file, format!("{body}\n")).map_err(|e| e.to_string())?;
            set.push("--module-attrs-file".into());
            set.push(attrs_file.to_string_lossy().to_string());
        }
        let set_res = delegate(set, &format!("recording the declaration of src/{}.rs", d.name));
        let _ = std::fs::remove_file(&attrs_file);
        set_res.inspect_err(|_| {
            rollback.restore();
        })?;
        writeln!(out, "  harvested {id}{}", if d.public { "" } else { " (private)" }).map_err(|e| e.to_string())?;
        done.push(Migrated { module: d.name.clone(), id });
    }

    // ── promote, then VERIFY it landed ──────────────────────────────────────────────────────────
    let ids: Vec<String> = done.iter().map(|m| m.id.clone()).collect();
    delegate(
        ["promote", "--id", &ids.join(","), "--root", &root.to_string_lossy()]
            .iter().map(|s| s.to_string()).collect(),
        &format!("promoting [{}]", ids.join(", ")),
    )
    .inspect_err(|_| {
        rollback.restore();
    })?;
    // READ THE STORE BACK rather than trusting the promote's own report. A promote that could not carry
    // an id was reported all along; the tool simply never looked, which is how a partial migration
    // reached a build error with nothing connecting the two.
    let repo = crate::repo_store::read_at(&crate::repo_store::path_under(&root))?
        .unwrap_or_else(crate::repo_store::empty);
    let present: Vec<&str> = repo
        .get("implementations")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|i| i.get("id").and_then(|x| x.as_str())).collect())
        .unwrap_or_default();
    let lost: Vec<&String> = ids.iter().filter(|id| !present.contains(&id.as_str())).collect();
    if !lost.is_empty() {
        rollback.restore();
        return Err(format!(
            "promote did not carry [{}] into the committed store — stopping before any file is deleted",
            lost.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    writeln!(out, "  promoted {} record(s)", ids.len()).map_err(|e| e.to_string())?;

    // ── rewire the crate. The rewrite is computed BEFORE anything is deleted, so a declaration this
    // cannot locate stops the migration with every file still present. ──────────────────────────
    let rewritten = rewrite_lib(&lib_src, &decls, &krate).map_err(|e| {
        rollback.restore();
        format!("{e} — nothing was deleted")
    })?;
    std::fs::write(&cargo_path, opt_in(&cargo_toml)).map_err(|e| e.to_string())?;
    std::fs::write(&root_path, rewritten).map_err(|e| e.to_string())?;
    for d in &decls {
        std::fs::remove_file(src_dir.join(format!("{}.rs", d.name)))
            .map_err(|e| format!("cannot delete src/{}.rs: {e}", d.name))?;
    }
    writeln!(out, "  rewrote {root_name}, opted in, deleted {} file(s)", decls.len()).map_err(|e| e.to_string())?;

    // ── VERIFY IN THE SAME BREATH ───────────────────────────────────────────────────────────────
    // A migration that deleted source and did not build is the worst state to leave a tree in, and it
    // is not visible from the file list.
    let pkg = package_name(&cargo_toml, &krate);
    let build = std::process::Command::new("cargo")
        .args(["build", "-p", &pkg])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("cannot run cargo: {e}"))?;
    if !build.status.success() {
        let err = String::from_utf8_lossy(&build.stderr);
        return Err(format!(
            "FAILED after migrating — the tree is mid-migration and needs attention:\n{}\n  \
             Recover with: git checkout crates/{krate} && git checkout graph/algorithms.json",
            err.lines().take(12).collect::<Vec<_>>().join("\n")
        ));
    }
    writeln!(out, "  BUILD PASSES — {krate} is now 1 .rs file").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl(name: &str, public: bool) -> ModuleDecl {
        ModuleDecl {
            name: name.into(),
            public,
            line: format!("{}mod {name};", if public { "pub " } else { "" }),
            block: format!("{}mod {name};", if public { "pub " } else { "" }),
            docs: vec![],
            attrs: vec![],
        }
    }

    #[test]
    fn module_decls_reads_visibility_docs_and_attributes() {
        let src = "//! crate\n\n/// The CLI.\npub mod cli;\n#[cfg(test)]\nmod surface_tests;\nmod tests {\n}\n";
        let d = module_decls(src);
        assert_eq!(d.len(), 2, "the inline `mod tests {{` is not a declaration: {d:?}");
        assert_eq!(d[0].name, "cli");
        assert!(d[0].public);
        assert_eq!(d[0].docs, vec!["/// The CLI.".to_string()]);
        assert_eq!(d[1].name, "surface_tests");
        assert!(!d[1].public, "a bare `mod` is private and must be recorded as such");
        assert_eq!(d[1].attrs, vec!["#[cfg(test)]".to_string()]);
    }

    /// REGRESSION. An `#[…]` above a declaration is not decoration — removing the declaration and
    /// leaving the attribute silently re-gates whatever follows. In `crates/llm` a leftover
    /// `#[cfg(test)]` attached to `pub use anthropic::AnthropicProvider;` and compiled that re-export
    /// out of every non-test build, which reads as nothing to do with attributes.
    #[test]
    fn rewrite_lib_takes_the_attribute_and_the_doc_with_the_declaration() {
        let src = "//! crate\n\n/// The CLI.\n#[cfg(feature = \"x\")]\npub mod cli;\n\npub use cli::run;\n";
        let d = module_decls(src).remove(0);
        assert_eq!(d.docs, vec!["/// The CLI.".to_string()], "doc collected in either order");
        assert_eq!(d.attrs, vec!["#[cfg(feature = \"x\")]".to_string()], "attribute too");
        let out = rewrite_lib(src, &[d], "demo").expect("the block is locatable");
        assert!(!out.contains("mod cli;"), "declaration gone: {out}");
        assert!(!out.contains("#[cfg(feature"), "attribute gone WITH it: {out}");
        assert!(!out.contains("/// The CLI."), "doc gone WITH it: {out}");
        assert!(out.contains("pub use cli::run;"), "unrelated code untouched: {out}");
        assert!(out.contains(r#"include!(concat!(env!("OUT_DIR"), "/crate.rs"));"#));
    }

    #[test]
    fn carried_docs_land_only_on_an_undocumented_module() {
        let docs = vec!["/// The CLI.".to_string()];
        assert_eq!(with_carried_docs("pub fn run() {}\n", &docs).unwrap(), "//! The CLI.\npub fn run() {}\n");
        // A module with its own header keeps it — carrying would give the record two headers saying
        // nearly the same thing.
        assert!(with_carried_docs("//! Its own header.\npub fn run() {}", &docs).is_none());
        assert!(with_carried_docs("pub fn run() {}", &[]).is_none());
    }

    /// The driver's own report must survive contact with the verbs it delegates to.
    ///
    /// This pins the REPORT — the writer the driver speaks through — on the dry-run path, which is the
    /// one a test can drive without a store. It does NOT by itself prove the capture works: the dry run
    /// delegates nothing, so "no record JSON" is true there no matter what `delegate` does. The capture
    /// is pinned separately by `a_failing_delegated_verb_still_says_what_it_said`.
    #[test]
    fn the_report_is_readable_and_carries_no_record_json() {
        let dir = std::env::temp_dir().join(format!("bsc-migrate-report-{}", std::process::id()));
        let src = dir.join("crates").join("demo").join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(dir.join("crates/demo/Cargo.toml"), "[package]\nname = \"demo\"\nedition = \"2021\"\n").unwrap();
        std::fs::write(src.join("lib.rs"), "//! demo\npub mod cli;\n").unwrap();
        std::fs::write(src.join("cli.rs"), "pub fn run() {}\n").unwrap();

        let mut out: Vec<u8> = Vec::new();
        run(&["demo".into(), "--root".into(), dir.to_string_lossy().to_string()], &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();

        assert!(text.contains("would migrate demo"), "it says what it would do: {text}");
        assert!(text.contains("src/cli.rs  ->  record demo--cli.rs"), "{text}");
        // The shape that broke: a delegated verb's JSON in the stream. One blob makes the whole output
        // unfilterable, because it contains arbitrary source.
        assert!(!text.contains("\"applied\""), "no harvest JSON: {text}");
        assert!(!text.contains("\"impl\""), "no impl-set JSON: {text}");
        assert!(text.lines().count() < 12, "a report a human reads, not a dump: {} lines", text.lines().count());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The capture must not become a GAG. `delegate` suppresses a verb's output on the success path, so
    /// the one thing that would make it a worse bug than the noise is losing that output when the verb
    /// FAILS — a tool that goes silent exactly when something breaks.
    ///
    /// Driven through a real delegated call with a bogus id, so it exercises `capture_output` rather
    /// than a stub of it.
    #[test]
    fn a_failing_delegated_verb_still_says_what_it_said() {
        let err = delegate(
            ["impl".into(), "set".into(), "--id".into(), "".into()].to_vec(),
            "recording something",
        )
        .expect_err("an empty id is refused");
        assert!(err.starts_with("recording something: "), "the error names WHAT was being done: {err}");
        assert!(err.len() > "recording something: ".len(), "…and carries the verb's own words: {err}");
    }

    /// And the success path is genuinely quiet.
    ///
    /// Written in TWO halves on purpose, because the obvious one-half version passes for the wrong
    /// reason. My first attempt delegated `help` and asserted the outer sink was empty — but `help`
    /// prints through a raw `print!`, which never reaches the capture sink at all, so the assertion was
    /// true no matter what `delegate` did. A quiet test proves nothing unless the thing it silences is
    /// shown to be loud first.
    ///
    /// So: pick a verb that DOES emit through the shared helper (`impl get` answers `null` for a miss),
    /// prove it is loud undelegated, then prove `delegate` swallows exactly that.
    #[test]
    fn a_succeeding_delegated_verb_prints_nothing_through() {
        let args = || ["impl".into(), "get".into(), "no-such-id-zzz".into()].to_vec();

        // Half one: undelegated, this verb really does emit through the capturable helper.
        let (direct, loud) = bsc_util::capture_output(|| crate::cli::run(args(), "bsc graph"));
        assert!(direct.is_ok(), "the verb ran: {direct:?}");
        assert!(!loud.trim().is_empty(), "the verb IS loud undelegated — otherwise half two is vacuous");

        // Half two: through `delegate`, the inner capture takes it and the outer sink sees nothing.
        let (result, said) = bsc_util::capture_output(|| delegate(args(), "reading a record"));
        assert!(result.is_ok(), "still ran: {result:?}");
        assert!(said.is_empty(), "delegate captured it — outer sink got {} bytes: {said}", said.len());
    }

    /// The header is written into EVERY migrated crate, so its grammar is not cosmetic — it is the
    /// sentence the next reader is told to trust about where the code went.
    #[test]
    fn the_generated_header_agrees_in_number() {
        let one = rewrite_lib("pub mod cli;\n", &[decl("cli", true)], "demo").unwrap();
        assert!(
            one.contains("// src/cli.rs does not exist — it is a record in the\n"),
            "the WHOLE line, not a prefix — a prefix assertion passed against \
             `it is a record records in the`: {one}"
        );
        let two = rewrite_lib(
            "pub mod cli;\npub mod store;\n",
            &[decl("cli", true), decl("store", true)],
            "demo",
        )
        .unwrap();
        assert!(
            two.contains("// src/cli.rs, src/store.rs do not exist — they are records in the\n"),
            "{two}"
        );
    }

    #[test]
    fn the_predicted_id_kebabs_like_module_id_does() {
        // `log_streams.rs` becomes `bsc-util--log-streams.rs`. Guessing the underscore form promoted an
        // id that did not exist, `promote` reported it missing, and the build then failed on an
        // unresolved import four steps downstream.
        assert_eq!(module_record_id("log_streams"), "log-streams");
        assert_eq!(module_record_id("cli"), "cli");
    }

    fn shape<'a>(cargo: &'a str, lib: &'a str, files: &'a [String], nested: usize) -> CrateShape<'a> {
        CrateShape {
            cargo_toml: cargo, lib_src: lib, top_files: files, nested_count: nested,
            root_name: "lib.rs", module_sources: &[],
        }
    }

    #[test]
    fn refuses_every_shape_it_cannot_complete_and_says_which() {
        let files = vec!["lib.rs".to_string(), "cli.rs".to_string()];
        let lib = "pub mod cli;\n";

        let already = format!("[package]\nedition = \"2021\"\n{MARKER}\n");
        assert!(refuse_reason(&shape(&already, lib, &files, 0)).unwrap().contains("already migrated"));

        let plain = "[package]\nedition = \"2021\"\n";
        assert!(refuse_reason(&shape(plain, lib, &files, 2)).unwrap().contains("NESTED"));
        assert!(refuse_reason(&shape(plain, "", &files, 0)).unwrap().contains("declares no modules"));

        let missing = refuse_reason(&shape(plain, "pub mod gone;\n", &files, 0)).unwrap();
        assert!(missing.contains("gone") && missing.contains("no matching file"), "{missing}");

        let test_only = refuse_reason(&shape(
            plain,
            "mod surface_tests;\n",
            &["lib.rs".to_string(), "surface_tests.rs".to_string()],
            0,
        ))
        .unwrap();
        assert!(test_only.contains("surface_tests") && test_only.contains("is_test_file"), "{test_only}");

        // …and a crate it CAN do is not refused.
        assert!(refuse_reason(&shape(plain, lib, &files, 0)).is_none());
    }

    /// REGRESSION, from Slice D. `bsc-persona/src/cli.rs` carried `include_str!("cli.rs")` — a test
    /// reading ITS OWN SOURCE to assert that `run` intercepts `remove` but not `set`. The migration
    /// happily took it, and the crate then failed to compile with `couldn't read …/src/cli.rs`, pointing
    /// at a GENERATED file under `target/` four steps from the cause.
    ///
    /// `absolutize_includes` makes this quieter, not louder: it faithfully rewrites the relative path to
    /// `CARGO_MANIFEST_DIR + "/src/cli.rs"`, so the error is a missing FILE rather than an unresolvable
    /// path. Nothing about it says "this module read something you deleted".
    #[test]
    fn refuses_a_module_that_reads_a_file_the_migration_deletes() {
        let files = vec!["lib.rs".to_string(), "cli.rs".to_string()];
        let plain = "[package]\nedition = \"2021\"\n";
        let sources = vec![("cli".to_string(), "fn t() { let s = include_str!(\"cli.rs\"); }".to_string())];
        let shape = CrateShape {
            cargo_toml: plain, lib_src: "pub mod cli;\n", top_files: &files,
            nested_count: 0, root_name: "lib.rs", module_sources: &sources,
        };
        let why = refuse_reason(&shape).expect("a self-read must be refused");
        assert!(why.contains("include_str!"), "names the mechanism: {why}");
        assert!(why.contains("src/cli.rs"), "names the file that goes away: {why}");

        // …and the case this must NOT catch: `bsc-agent` includes ../data/agent-instructions.md, which
        // SURVIVES the migration. Refusing that would restore the blocker `absolutize_includes` removed.
        let survives = vec![(
            "agent".to_string(),
            "const I: &str = include_str!(\"../data/agent-instructions.md\");".to_string(),
        )];
        let ok = CrateShape {
            cargo_toml: plain, lib_src: "pub mod agent;\n",
            top_files: &["lib.rs".to_string(), "agent.rs".to_string()],
            nested_count: 0, root_name: "lib.rs", module_sources: &survives,
        };
        assert!(refuse_reason(&ok).is_none(), "a data file that survives is not a refusal");
    }

    /// REGRESSION. `cargo build -p <dir>` never ran for `crates/data`, whose package is `bsc-data` —
    /// cargo answered an unknown package with a hard error and the tool reported a migration failure
    /// for a crate that was fine.
    #[test]
    fn the_package_name_comes_from_the_manifest_not_the_directory() {
        assert_eq!(package_name("[package]\nname = \"bsc-data\"\n", "data"), "bsc-data");
        assert_eq!(package_name("[package]\n", "data"), "data", "falls back to the directory");
    }

    #[test]
    fn opt_in_adds_the_build_script_and_its_dependency_once() {
        let before = "[package]\nname = \"demo\"\nedition = \"2021\"\n\n[dependencies]\nserde = \"1\"\n";
        let once = opt_in(before);
        assert!(once.contains(MARKER));
        assert!(once.contains("[build-dependencies]"));
        // Idempotent: a re-run must not double-add either.
        let twice = opt_in(&once);
        assert_eq!(twice.matches(MARKER).count(), 1, "{twice}");
        assert_eq!(twice.matches("[build-dependencies]").count(), 1, "{twice}");
    }
}
