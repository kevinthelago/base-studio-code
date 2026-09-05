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

/// ONE MODULE of a crate, at ANY DEPTH, with everything the migration needs about it.
///
/// The migration used to see a crate as a flat list of `mod x;` lines in its root. That is what made a
/// nested directory a REFUSAL rather than a shape: `plandb/src/cli/nouns.rs` had no declaration in
/// `lib.rs` to be found by, because it is declared in `cli.rs`. Walking the tree is the whole
/// difference — every module is reached from the declaration that names it, wherever that lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleNode {
    /// The module path from the crate root — `["cli", "nouns"]`.
    pub path: Vec<String>,
    /// The file holding its body, relative to `src/` — `cli.rs`, `cli/nouns.rs` or `signals/mod.rs`.
    pub file: String,
    /// How its PARENT declared it, with the docs and attributes that must leave with the declaration.
    pub decl: ModuleDecl,
    /// The declarations of its OWN children.
    ///
    /// These are STRIPPED from the record body, because materialization is what declares them now — a
    /// leftover `pub mod nouns;` inside the `cli` record would look for a file the migration deleted.
    pub children: Vec<ModuleDecl>,
    /// Its source, or `None` when [`file`](Self::file) does not exist — which [`refuse_reason`] reports
    /// rather than treating as an empty module.
    pub source: Option<String>,
}

impl ModuleNode {
    /// The module's own name — the last path segment.
    pub fn name(&self) -> &str {
        self.path.last().map(String::as_str).unwrap_or_default()
    }

    /// `cli::nouns`, for a message a human reads.
    pub fn module_path(&self) -> String {
        self.path.join("::")
    }

    /// The record id — the DRY-RUN prediction; the apply path still reads the real id back from the
    /// harvest rather than trusting this.
    ///
    /// It CALLS `extract::module_id` rather than reproducing it, so migrate-crate cannot drift from the
    /// derivation `bsc graph emit` uses to decide a record is a whole module. The third party to that
    /// agreement, `graph-materialize/plan.rs::expected_id`, cannot call it (a build script must not
    /// depend on the crate graph it is part of) and is pinned against it instead — see
    /// `materialize_plan_tests::expected_id_agrees_with_extract_module_id`.
    pub fn record_id(&self, krate: &str) -> String {
        crate::extract::module_id(&format!("crates/{krate}/src/{}", self.file), "rs")
    }
}

/// Every module of a crate, depth-first from its root, parents before their children.
///
/// A module is a DIRECTORY module when a directory of its name sits beside it; its body is then
/// whichever of the two shapes Rust allows — `src/cli.rs` next to `src/cli/` (the 2018 style `plandb`
/// uses) or `src/signals/mod.rs` (the style `bsc-news`, `bsc-lan-core` and `research` use). Both map
/// onto the DIRECTORY name, which is exactly what `graph-materialize/plan.rs::module_path` does at the
/// other end.
///
/// A declaration with no file at all still produces a node, with `source: None`. Reporting it is
/// [`refuse_reason`]'s job: a walk that silently dropped it would migrate a crate whose root still
/// declares a module nothing provides.
pub fn module_tree(src_dir: &Path, root_src: &str) -> Vec<ModuleNode> {
    let mut out = Vec::new();
    walk_modules(src_dir, "", &[], root_src, &mut out);
    out
}

fn walk_modules(src_dir: &Path, rel_dir: &str, prefix: &[String], parent_src: &str, out: &mut Vec<ModuleNode>) {
    for decl in module_decls(parent_src) {
        let mut path = prefix.to_vec();
        path.push(decl.name.clone());
        let beside = format!("{rel_dir}{}.rs", decl.name);
        let inside = format!("{rel_dir}{}/mod.rs", decl.name);
        let has_dir = src_dir.join(rel_dir).join(&decl.name).is_dir();
        let (file, is_dir_module) = if src_dir.join(&beside).is_file() {
            (beside, has_dir)
        } else if src_dir.join(&inside).is_file() {
            (inside, true)
        } else {
            // Neither shape exists. Name the one a reader would look for first.
            (beside, has_dir)
        };
        let source = std::fs::read_to_string(src_dir.join(&file)).ok();
        let children = if is_dir_module {
            source.as_deref().map(module_decls).unwrap_or_default()
        } else {
            Vec::new()
        };
        out.push(ModuleNode { path: path.clone(), file, decl, children, source: source.clone() });
        if is_dir_module {
            if let Some(src) = source.as_deref() {
                let name = path.last().expect("just pushed");
                walk_modules(src_dir, &format!("{rel_dir}{name}/"), &path, src, out);
            }
        }
    }
}

/// What this crate holds, as [`refuse_reason`] needs to see it.
pub struct CrateShape<'a> {
    pub cargo_toml: &'a str,
    /// The crate's OWN build script, when it already has one: the path as a human would type it, and
    /// the file's source. `None` when the package root holds no `build.rs`.
    ///
    /// Both halves are needed because the refusal has to be actionable: cargo AUTO-DETECTS `build.rs`,
    /// so nothing in `Cargo.toml` names the script that is about to be replaced, and the reader has no
    /// way to know what they would lose unless the message says.
    pub build_rs: Option<(&'a str, &'a str)>,
    /// `lib.rs` or `main.rs`, whichever this crate has.
    pub root_name: &'a str,
    /// EVERY module of the crate, at every depth — see [`module_tree`].
    ///
    /// This replaced a flat `top_files` + `nested_count` pair, and the replacement is what removed the
    /// nested-directory refusal: a directory is no longer a shape the tool cannot describe, it is a
    /// module with children. A directory holding no Rust (a `fixtures/` of JSON, a `.claude/` of
    /// session state) is now invisible for a better reason than a heuristic — nothing DECLARES it, so
    /// the walk never reaches it.
    pub modules: &'a [ModuleNode],
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

/// The distinct `cargo:` directives a build script emits, first-seen order.
///
/// A build script's whole observable output IS its `cargo:` lines, so this answers "what does the one
/// you are about to replace actually do" without pretending to understand its code. It is what makes
/// `crates/data` legible: its single directive is `cargo:rustc-link-lib`, a LINK instruction guarded by
/// `CARGO_CFG_TARGET_OS == "windows"` — so losing it is invisible on Linux and breaks the Windows link.
///
/// A text scan, matching [`include_str_targets`]: a directive inside a comment is counted, which
/// over-reports into a message a human reads and never into a verdict.
pub fn build_script_effects(src: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (at, _) in src.match_indices("cargo:") {
        let key: String = src[at..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_'))
            .collect();
        let key = key.trim_end_matches([':', '-', '_']).to_string();
        if !key.is_empty() && !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// The `build = "…"` path a `Cargo.toml` declares, when it declares one.
fn declared_build_script(cargo_toml: &str) -> Option<String> {
    for line in cargo_toml.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("build") else { continue };
        let Some(v) = rest.trim_start().strip_prefix('=') else { continue };
        if let Some(inner) = v.trim().strip_prefix('"').and_then(|s| s.split('"').next()) {
            if !inner.is_empty() {
                return Some(inner.to_string());
            }
        }
    }
    None
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
    // A CRATE GETS EXACTLY ONE BUILD SCRIPT, and `opt_in` adds ours without looking for the crate's own.
    // Checked FIRST because it is the only refusal here whose damage is silent.
    //
    // REAL, both found green by `migrate-crate` on 2026-09-04:
    //   crates/bsc-config/build.rs stages $OUT_DIR/config-seed for an `include_dir!` in lib.rs —
    //     replacing it is an immediate, loud compile failure.
    //   crates/data/build.rs emits `cargo:rustc-link-lib=dylib=rstrtmgr` on WINDOWS ONLY, for DuckDB's
    //     Restart Manager references — replacing it changes NOTHING observable on Linux and breaks the
    //     Windows link. That is the dangerous one, and it is why the message quotes the directives.
    //
    // Neither crate DECLARES `build =`: cargo auto-detects `build.rs`, so nothing in the manifest names
    // the script, and a reader diffing the Cargo.toml afterwards sees only a line being added.
    if let Some((path, src)) = shape.build_rs {
        let effects = build_script_effects(src);
        let does = if effects.is_empty() {
            "emits no cargo: directives".to_string()
        } else {
            format!("emits {}", effects.join(", "))
        };
        return Some(format!(
            "{path} already exists ({} lines, {does}) and this crate gets exactly ONE build script — \
             cargo AUTO-DETECTS build.rs, so nothing in Cargo.toml names it and adding {MARKER} would \
             SILENTLY REPLACE it. Fold what it does into crates/graph-materialize/build.rs first, or \
             migrate this crate by hand",
            src.lines().count()
        ));
    }
    // The same collision, declared rather than auto-detected. `opt_in` inserts MARKER after the edition
    // line without removing anything, so a second `build =` key makes the manifest unparseable — and it
    // would do so AFTER the records were written, which is the late failure this function exists to
    // prevent.
    if let Some(declared) = declared_build_script(shape.cargo_toml) {
        return Some(format!(
            "its Cargo.toml already declares `build = \"{declared}\"` and a crate gets exactly ONE build \
             script — adding {MARKER} would leave two `build` keys in one manifest. Fold that script into \
             crates/graph-materialize/build.rs first, or migrate this crate by hand"
        ));
    }
    // A NESTED MODULE DIRECTORY USED TO BE REFUSED HERE, and it was the largest remaining blocker —
    // four crates outright (~17,900 lines) and every one of src-tauri's 137 nested files.
    // `graph-materialize/build.rs` now materializes a `mod` TREE mirroring the directories and maps
    // `<dir>/mod.rs` onto its directory name, so the shape is supported rather than declined:
    // `graph-materialize-takes-nested-modules-and-mod-rs`.
    let decls = shape.modules;
    if decls.is_empty() {
        return Some(format!("{} declares no modules — there is nothing to migrate", shape.root_name));
    }
    let missing: Vec<String> = decls
        .iter()
        .filter(|n| n.source.is_none())
        .map(|n| format!("{} (src/{})", n.module_path(), n.file))
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
        .filter(|n| n.name().ends_with("_test") || n.name().ends_with("_tests"))
        .map(ModuleNode::name)
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
    let doomed: Vec<&str> = decls.iter().map(|n| n.file.trim_end_matches(".rs")).collect();
    for node in decls {
        let Some(src) = node.source.as_deref() else { continue };
        for target in include_str_targets(src) {
            let stem = target.trim_end_matches(".rs");
            let stem = stem.rsplit('/').next().unwrap_or(stem);
            if target.ends_with(".rs") && doomed.iter().any(|d| *d == stem || d.ends_with(&format!("/{stem}"))) {
                return Some(format!(
                    "src/{} reads `{target}` with include_str!, and src/{stem}.rs is one of the \
                     files this migration deletes — the record cannot read a file that no longer exists. \
                     Rewrite that read (or move what it asserts onto the record) first",
                    node.file
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
///
/// It lists every file that stopped existing, at every depth — `src/cli/nouns.rs` as readily as
/// `src/cli.rs` — because the header is the only thing a reader who opens the directory has to tell
/// them where the code went.
fn include_block(krate: &str, nodes: &[ModuleNode]) -> String {
    let files: Vec<String> = nodes.iter().map(|n| format!("src/{}", n.file)).collect();
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

/// A source with a set of `mod x;` declaration blocks removed — the shared half of [`rewrite_lib`] and
/// [`strip_child_decls`].
///
/// The attributes and the doc block leave WITH the declaration they belong to — see [`module_decls`]
/// for what a leftover one did to `crates/llm`.
fn remove_decl_blocks(src: &str, decls: &[ModuleDecl]) -> Result<String, String> {
    let mut out = src.to_string();
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
    Ok(out)
}

/// A DIRECTORY module's body with its OWN children's declarations removed.
///
/// `src/cli.rs` says `mod nouns;`, and after migration nothing named `src/cli/nouns.rs` exists —
/// `graph-materialize/build.rs` emits `mod nouns { … }` INSIDE `mod cli { … }` instead. A record that
/// kept the declaration would send rustc looking for a deleted file, and the error would name a
/// generated file under `target/` rather than this step.
pub fn strip_child_decls(module_src: &str, children: &[ModuleDecl]) -> Result<String, String> {
    remove_decl_blocks(module_src, children)
}

/// The crate root with its module declarations removed and the single `include!` appended.
///
/// `decls` are the ROOT's own declarations (the lines to remove); `nodes` is every module at every
/// depth (what the header lists), so a nested crate's header names the files a reader will not find.
pub fn rewrite_lib(lib_src: &str, decls: &[ModuleDecl], nodes: &[ModuleNode], krate: &str) -> Result<String, String> {
    let out = remove_decl_blocks(lib_src, decls)?;
    Ok(format!("{}\n\n{}", out.trim_end(), include_block(krate, nodes)))
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

    // The crate's OWN build script, if it has one. Read here rather than merely probed, because the
    // refusal quotes what it does — see `refuse_reason`.
    let build_path = dir.join("build.rs");
    let build_rel = format!("crates/{krate}/build.rs");
    let build_src = std::fs::read_to_string(&build_path).ok();

    // EVERY module of the crate, at every depth, each reached from the declaration that names it. The
    // scan used to be one `read_dir` of `src/` and a count of directories, which is why a nested
    // directory could only ever be a refusal — nothing in `lib.rs` names `cli/nouns.rs`, only `cli.rs`
    // does.
    let nodes = module_tree(&src_dir, &lib_src);
    let shape = CrateShape {
        cargo_toml: &cargo_toml,
        build_rs: build_src.as_deref().map(|s| (build_rel.as_str(), s)),
        root_name: &root_name,
        modules: &nodes,
    };
    if let Some(why) = refuse_reason(&shape) {
        return Err(format!("REFUSED {krate}: {why}"));
    }
    let root_decls = module_decls(&lib_src);

    writeln!(out, "\n{} {krate} — {} module(s):", if apply { "migrating" } else { "would migrate" }, nodes.len())
        .map_err(|e| e.to_string())?;
    for n in &nodes {
        writeln!(out, "  src/{}  ->  record {}", n.file, n.record_id(&krate)).map_err(|e| e.to_string())?;
    }
    if !apply {
        writeln!(out, "\nDRY RUN — pass --apply to write.").map_err(|e| e.to_string())?;
        return Ok(());
    }

    // ── harvest, one module at a time ───────────────────────────────────────────────────────────
    let mut rollback = Rollback(Vec::new());
    let mut done: Vec<Migrated> = Vec::new();
    for n in &nodes {
        let d = &n.decl;
        let file = src_dir.join(&n.file);
        let original = std::fs::read_to_string(&file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        // A DIRECTORY module's body loses its own children's `mod x;` lines first — materialization is
        // what declares them now. Then the parent's `///` docs are carried in as the record's `//!`
        // header, as they always were.
        let stripped = strip_child_decls(&original, &n.children).inspect_err(|_| {
            rollback.restore();
        })?;
        let body = with_carried_docs(&stripped, &d.docs).unwrap_or(stripped);
        if body != original {
            rollback.0.push((file.clone(), original.clone()));
            std::fs::write(&file, body).map_err(|e| format!("cannot write {}: {e}", file.display()))?;
        }
        // The id is READ from the harvest, never reconstructed. `module_id` kebabs each path segment, so
        // `log_streams.rs` becomes `…--log-streams.rs`; guessing the underscore form promoted an id that
        // did not exist, promote reported it missing, and the build failed on an unresolved import four
        // steps downstream.
        let rel = format!("crates/{krate}/src/{}", n.file);
        let id = crate::extract::harvest_module(&root.join(&rel), &root)
            .map(|c| c.id)
            .ok_or_else(|| {
                let restored = rollback.restore();
                format!(
                    "harvest of src/{} produced no candidate — refusing to guess an id.{}",
                    n.file,
                    if restored > 0 {
                        format!(" Restored {restored} file(s) the doc-carry had rewritten.")
                    } else {
                        String::new()
                    }
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
            &format!("harvesting src/{}", n.file),
        )
        .inspect_err(|_| {
            rollback.restore();
        })?;
        // Record HOW it was declared, so materializing reproduces the program rather than a widened,
        // ungated approximation of it. Attributes go through a FILE — `#[cfg(feature = "x")]` on a
        // command line loses its quotes and brackets silently.
        let mut set: Vec<String> = ["impl", "set", "--tech", "rust", "--id", &id, "--role", "algorithm",
                                    "--name", n.name(), "--module-vis", if d.public { "pub" } else { "private" }]
            .iter().map(|s| s.to_string()).collect();
        // Beside the ROOT, never beside the module — a nested module's directory is deleted at the end
        // of this run, and a scratch file left in one would make the directory non-empty.
        let attrs_file = src_dir.join(format!(".attrs-{}", n.path.join("-")));
        if !d.attrs.is_empty() {
            let body = d.attrs.iter().map(|a| a.trim()).collect::<Vec<_>>().join("\n");
            std::fs::write(&attrs_file, format!("{body}\n")).map_err(|e| e.to_string())?;
            set.push("--module-attrs-file".into());
            set.push(attrs_file.to_string_lossy().to_string());
        }
        let set_res = delegate(set, &format!("recording the declaration of src/{}", n.file));
        let _ = std::fs::remove_file(&attrs_file);
        set_res.inspect_err(|_| {
            rollback.restore();
        })?;
        writeln!(out, "  harvested {id}{}", if d.public { "" } else { " (private)" }).map_err(|e| e.to_string())?;
        done.push(Migrated { module: n.module_path(), id });
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
    let rewritten = rewrite_lib(&lib_src, &root_decls, &nodes, &krate).map_err(|e| {
        rollback.restore();
        format!("{e} — nothing was deleted")
    })?;
    std::fs::write(&cargo_path, opt_in(&cargo_toml)).map_err(|e| e.to_string())?;
    std::fs::write(&root_path, rewritten).map_err(|e| e.to_string())?;
    for n in &nodes {
        std::fs::remove_file(src_dir.join(&n.file))
            .map_err(|e| format!("cannot delete src/{}: {e}", n.file))?;
    }
    // …and the directories those files were in, DEEPEST FIRST, and only when empty. `remove_dir` refuses
    // a non-empty directory, which is exactly the guard wanted: a `fixtures/` of data sitting beside a
    // module tree survives, and so does anything the walk never claimed.
    let mut dirs: Vec<String> = nodes
        .iter()
        .filter_map(|n| n.file.rsplit_once('/').map(|(d, _)| d.to_string()))
        .collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
    dirs.dedup();
    for d in &dirs {
        let _ = std::fs::remove_dir(src_dir.join(d));
    }
    writeln!(out, "  rewrote {root_name}, opted in, deleted {} file(s)", nodes.len()).map_err(|e| e.to_string())?;

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
        let nodes = [node(&["cli"], "cli.rs", Some(""))];
        let out = rewrite_lib(src, &[d], &nodes, "demo").expect("the block is locatable");
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
        let one = rewrite_lib(
            "pub mod cli;\n",
            &[decl("cli", true)],
            &[node(&["cli"], "cli.rs", Some(""))],
            "demo",
        )
        .unwrap();
        assert!(
            one.contains("// src/cli.rs does not exist — it is a record in the\n"),
            "the WHOLE line, not a prefix — a prefix assertion passed against \
             `it is a record records in the`: {one}"
        );
        let two = rewrite_lib(
            "pub mod cli;\npub mod store;\n",
            &[decl("cli", true), decl("store", true)],
            &[node(&["cli"], "cli.rs", Some("")), node(&["store"], "store.rs", Some(""))],
            "demo",
        )
        .unwrap();
        assert!(
            two.contains("// src/cli.rs, src/store.rs do not exist — they are records in the\n"),
            "{two}"
        );

        // A NESTED crate's header names the nested paths, which is the only place a reader who opens
        // `src/` is told that `src/cli/nouns.rs` is gone too — the directory itself is deleted.
        let deep = rewrite_lib(
            "pub mod cli;\n",
            &[decl("cli", true)],
            &[node(&["cli"], "cli.rs", Some("")), node(&["cli", "nouns"], "cli/nouns.rs", Some(""))],
            "demo",
        )
        .unwrap();
        assert!(deep.contains("// src/cli.rs, src/cli/nouns.rs do not exist"), "{deep}");
    }

    #[test]
    fn the_predicted_id_kebabs_like_module_id_does() {
        // `log_streams.rs` becomes `bsc-util--log-streams.rs`. Guessing the underscore form promoted an
        // id that did not exist, `promote` reported it missing, and the build then failed on an
        // unresolved import four steps downstream.
        assert_eq!(node(&["log_streams"], "log_streams.rs", Some("")).record_id("bsc-util"), "bsc-util--log-streams.rs");
        assert_eq!(node(&["cli"], "cli.rs", Some("")).record_id("demo"), "demo--cli.rs");
        // …and a nested one keeps every segment, so two crates' `nouns` cannot collide on one key.
        assert_eq!(node(&["cli", "nouns"], "cli/nouns.rs", Some("")).record_id("plandb"), "plandb--cli--nouns.rs");
        assert_eq!(
            node(&["signals"], "signals/mod.rs", Some("")).record_id("bsc-news"),
            "bsc-news--signals--mod.rs",
            "the ID names the FILE (mod.rs) while the MODULE is named for the directory"
        );
    }

    /// One module, as the tree walk would have produced it. `source: None` is the shape that means
    /// "declared, but there is no such file".
    fn node(path: &[&str], file: &str, source: Option<&str>) -> ModuleNode {
        ModuleNode {
            path: path.iter().map(|s| (*s).to_string()).collect(),
            file: file.into(),
            decl: decl(path.last().expect("a module has a name"), true),
            children: vec![],
            source: source.map(str::to_string),
        }
    }

    fn shape<'a>(cargo: &'a str, modules: &'a [ModuleNode]) -> CrateShape<'a> {
        CrateShape { cargo_toml: cargo, build_rs: None, root_name: "lib.rs", modules }
    }

    #[test]
    fn refuses_every_shape_it_cannot_complete_and_says_which() {
        let cli = vec![node(&["cli"], "cli.rs", Some("pub fn run() {}\n"))];

        let already = format!("[package]\nedition = \"2021\"\n{MARKER}\n");
        assert!(refuse_reason(&shape(&already, &cli)).unwrap().contains("already migrated"));

        let plain = "[package]\nedition = \"2021\"\n";
        assert!(refuse_reason(&shape(plain, &[])).unwrap().contains("declares no modules"));

        let gone = vec![node(&["gone"], "gone.rs", None)];
        let missing = refuse_reason(&shape(plain, &gone)).unwrap();
        assert!(missing.contains("gone") && missing.contains("no matching file"), "{missing}");

        let tests = vec![node(&["surface_tests"], "surface_tests.rs", Some(""))];
        let test_only = refuse_reason(&shape(plain, &tests)).unwrap();
        assert!(test_only.contains("surface_tests") && test_only.contains("is_test_file"), "{test_only}");

        // …and a crate it CAN do is not refused.
        assert!(refuse_reason(&shape(plain, &cli)).is_none());
    }

    /// A NESTED MODULE DIRECTORY IS NO LONGER A REFUSAL. It was the single largest remaining blocker —
    /// four crates outright and every one of src-tauri's 137 nested files — and it existed only because
    /// `graph-materialize/build.rs` materialized direct children of `src/` and nothing else.
    #[test]
    fn a_nested_module_tree_is_no_longer_refused() {
        let plain = "[package]\nedition = \"2021\"\n";
        // `plandb`'s real shape: a directory module whose body sits beside the directory.
        let two_level = vec![
            node(&["cli"], "cli.rs", Some("pub fn run() {}\n")),
            node(&["cli", "nouns"], "cli/nouns.rs", Some("pub fn noun() {}\n")),
        ];
        assert_eq!(refuse_reason(&shape(plain, &two_level)), None, "the 2018-style directory module");

        // …and `bsc-news`'s: the body inside the directory, as `mod.rs`.
        let mod_rs = vec![
            node(&["signals"], "signals/mod.rs", Some("pub struct S;\n")),
            node(&["signals", "framing"], "signals/framing.rs", Some("pub fn f() {}\n")),
        ];
        assert_eq!(refuse_reason(&shape(plain, &mod_rs)), None, "the mod.rs directory module");
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
        let plain = "[package]\nedition = \"2021\"\n";
        let sources = vec![node(&["cli"], "cli.rs", Some("fn t() { let s = include_str!(\"cli.rs\"); }"))];
        let shape = CrateShape {
            cargo_toml: plain, build_rs: None, root_name: "lib.rs", modules: &sources,
        };
        let why = refuse_reason(&shape).expect("a self-read must be refused");
        assert!(why.contains("include_str!"), "names the mechanism: {why}");
        assert!(why.contains("src/cli.rs"), "names the file that goes away: {why}");

        // …and the case this must NOT catch: `bsc-agent` includes ../data/agent-instructions.md, which
        // SURVIVES the migration. Refusing that would restore the blocker `absolutize_includes` removed.
        let survives = vec![node(
            &["agent"],
            "agent.rs",
            Some("const I: &str = include_str!(\"../data/agent-instructions.md\");"),
        )];
        let ok = CrateShape {
            cargo_toml: plain, build_rs: None, root_name: "lib.rs", modules: &survives,
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

    /// REGRESSION. A crate gets exactly ONE build script, and `opt_in` adds ours without ever looking
    /// for the crate's own. Cargo AUTO-DETECTS `build.rs`, so neither offender declares `build =` and
    /// the manifest diff shows only a line being ADDED — nothing says a script was replaced.
    #[test]
    fn refuses_a_crate_that_already_has_its_own_build_script() {
        let plain = "[package]\nedition = \"2021\"\n";
        let cli = vec![node(&["cli"], "cli.rs", Some("pub fn run() {}\n"))];

        // `crates/data`'s script, verbatim in shape: a WINDOWS-ONLY link directive. Replacing it is
        // invisible on Linux — the whole reason this refusal has to be up front rather than caught by a
        // build. The message must name the file AND what it does, or the reader cannot judge the loss.
        let windows_link = "fn main() {\n    if std::env::var(\"CARGO_CFG_TARGET_OS\").as_deref() == Ok(\"windows\") {\n        println!(\"cargo:rustc-link-lib=dylib=rstrtmgr\");\n    }\n}\n";
        let mut s = shape(plain, &cli);
        s.build_rs = Some(("crates/data/build.rs", windows_link));
        let why = refuse_reason(&s).expect("an existing build.rs must be refused");
        assert!(why.contains("crates/data/build.rs"), "names the file: {why}");
        assert!(why.contains("cargo:rustc-link-lib"), "names what it does: {why}");
        assert!(why.contains("5 lines"), "names how much there is to lose: {why}");
        assert!(why.contains(MARKER), "names what would replace it: {why}");

        // A script emitting nothing still refuses, and says so rather than printing an empty list.
        let mut quiet = shape(plain, &cli);
        quiet.build_rs = Some(("crates/x/build.rs", "fn main() {}\n"));
        let why = refuse_reason(&quiet).expect("a silent build.rs is still a build.rs");
        assert!(why.contains("emits no cargo: directives"), "{why}");

        // The DECLARED twin: `opt_in` would leave two `build` keys in one manifest, and only after the
        // records had been written.
        let declared = "[package]\nedition = \"2021\"\nbuild = \"gen.rs\"\n";
        let why = refuse_reason(&shape(declared, &cli)).expect("a declared build script too");
        assert!(why.contains("gen.rs") && why.contains("ONE build"), "{why}");

        // …and a crate with no build script of its own is still not refused.
        assert!(refuse_reason(&shape(plain, &cli)).is_none());
    }

    /// The two crates the audit found GREEN on 2026-09-04, driven through the REAL `run` against this
    /// repo. Both are flat, both declare only files that exist, so every other refusal passes them.
    ///
    /// `crates/data` is checked by the EXISTENCE of its `build.rs`, never by building it: its directive
    /// fires only on Windows, so on this box a replacement compiles, links and tests clean while the
    /// Windows link is broken. A test that tried to observe the breakage would observe nothing.
    #[test]
    fn the_two_crates_with_their_own_build_script_are_refused_by_the_real_run() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        for krate in ["bsc-config", "data"] {
            let dir = repo.join("crates").join(krate);
            assert!(dir.join("build.rs").is_file(), "crates/{krate}/build.rs is the premise of this test");
            let cargo = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();
            assert!(!cargo.contains(MARKER), "crates/{krate} is not migrated yet");
            assert!(
                declared_build_script(&cargo).is_none(),
                "crates/{krate} does NOT declare build = — cargo auto-detects it, which is what makes the \
                 replacement silent"
            );

            let mut out: Vec<u8> = Vec::new();
            let err = run(&[krate.into(), "--root".into(), repo.to_string_lossy().to_string()], &mut out)
                .expect_err("a crate with its own build.rs must be refused");
            assert!(err.contains(&format!("REFUSED {krate}")), "{err}");
            assert!(err.contains(&format!("crates/{krate}/build.rs")), "names the file: {err}");
            assert!(out.is_empty(), "a refusal prints no migration plan: {}", String::from_utf8_lossy(&out));
        }
    }

    /// A DIRECTORY IS REACHED THROUGH ITS DECLARATION, never through a directory listing — which is
    /// what makes the old `nested_count` heuristic unnecessary rather than merely fixed.
    ///
    /// That heuristic existed because the scan was a `read_dir` of `src/`, so it had to guess which
    /// directories were modules; a bare `is_dir()` refused this crate's 18,052 lines over
    /// `crates/bsc-graph/src/.claude`, one file of session state the author never wrote. The walk asks
    /// the source instead: a `fixtures/` of JSON and a `.claude/` of tooling state are invisible because
    /// nothing says `mod fixtures;`, and a directory that IS declared is walked however it is named.
    #[test]
    fn a_directory_is_reached_through_its_declaration_not_a_listing() {
        let root = std::env::temp_dir().join(format!("bsc-migrate-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("crates").join("demo").join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("lib.rs"), "//! demo\npub mod cli;\n").unwrap();
        std::fs::write(src.join("cli.rs"), "pub fn run() {}\n").unwrap();
        std::fs::write(root.join("crates/demo/Cargo.toml"), "[package]\nname = \"demo\"\nedition = \"2021\"\n").unwrap();

        // The exact shape that refused bsc-graph: a dot-dir holding one non-Rust file.
        std::fs::create_dir_all(src.join(".claude")).unwrap();
        std::fs::write(src.join(".claude").join(".cc-writes"), "{}\n").unwrap();
        // …and a plain directory of data, nested, with no Rust anywhere beneath it.
        std::fs::create_dir_all(src.join("fixtures").join("deep")).unwrap();
        std::fs::write(src.join("fixtures").join("deep").join("a.json"), "{}\n").unwrap();
        // …and a directory of REAL Rust that nothing declares. It used to force a refusal; now it is
        // simply not a module of this crate, which is also what rustc thinks.
        std::fs::create_dir_all(src.join("orphan")).unwrap();
        std::fs::write(src.join("orphan").join("mod.rs"), "pub fn f() {}\n").unwrap();

        let tree = module_tree(&src, &std::fs::read_to_string(src.join("lib.rs")).unwrap());
        assert_eq!(tree.len(), 1, "only what lib.rs declares: {tree:?}");
        assert_eq!(tree[0].file, "cli.rs");

        let mut out: Vec<u8> = Vec::new();
        run(&["demo".into(), "--root".into(), root.to_string_lossy().to_string()], &mut out)
            .expect("src/.claude, src/fixtures and an undeclared src/orphan must not refuse the crate");
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("would migrate demo"), "{text}");
        assert!(!text.contains("NESTED"), "{text}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// THE WHOLE TREE, through the REAL `run`, in BOTH shapes Rust allows for a directory module —
    /// `cli.rs` beside `cli/` (what `plandb` uses) and `signals/mod.rs` (what `bsc-news`,
    /// `bsc-lan-core` and `research` use). Three levels deep, because two-level nesting can be
    /// accidentally right in a way three-level cannot.
    ///
    /// It asserts the DRY RUN's plan, which is the thing a reader acts on: every module at every depth,
    /// each against the record id `bsc graph emit` will look for.
    #[test]
    fn the_dry_run_plans_every_module_at_every_depth_in_both_directory_shapes() {
        let root = std::env::temp_dir().join(format!("bsc-migrate-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("crates").join("demo").join("src");
        std::fs::create_dir_all(src.join("cli")).unwrap();
        std::fs::create_dir_all(src.join("signals").join("deep")).unwrap();
        std::fs::write(root.join("crates/demo/Cargo.toml"), "[package]\nname = \"demo\"\nedition = \"2021\"\n").unwrap();
        std::fs::write(src.join("lib.rs"), "//! demo\npub mod cli;\npub mod signals;\n").unwrap();
        // 2018 style: the directory module's body sits BESIDE the directory.
        std::fs::write(src.join("cli.rs"), "pub mod nouns;\npub fn run() {}\n").unwrap();
        std::fs::write(src.join("cli").join("nouns.rs"), "pub fn noun() {}\n").unwrap();
        // mod.rs style, and one level deeper.
        std::fs::write(src.join("signals").join("mod.rs"), "pub mod deep;\npub struct S;\n").unwrap();
        std::fs::write(src.join("signals").join("deep").join("mod.rs"), "pub mod leaf;\n").unwrap();
        std::fs::write(src.join("signals").join("deep").join("leaf.rs"), "pub fn l() {}\n").unwrap();

        let mut out: Vec<u8> = Vec::new();
        run(&["demo".into(), "--root".into(), root.to_string_lossy().to_string()], &mut out)
            .expect("a nested crate is planned, not refused");
        let text = String::from_utf8(out).unwrap();

        assert!(text.contains("would migrate demo — 5 module(s)"), "{text}");
        for (file, id) in [
            ("src/cli.rs", "demo--cli.rs"),
            ("src/cli/nouns.rs", "demo--cli--nouns.rs"),
            ("src/signals/mod.rs", "demo--signals--mod.rs"),
            ("src/signals/deep/mod.rs", "demo--signals--deep--mod.rs"),
            ("src/signals/deep/leaf.rs", "demo--signals--deep--leaf.rs"),
        ] {
            assert!(text.contains(&format!("{file}  ->  record {id}")), "missing {file}: {text}");
        }
        assert!(text.contains("DRY RUN"), "{text}");

        // …and the plan is exactly what `graph-materialize/plan.rs` would place, module for module.
        let tree = module_tree(&src, &std::fs::read_to_string(src.join("lib.rs")).unwrap());
        for n in &tree {
            assert_eq!(
                Some(n.path.clone()),
                super::materialize_plan::module_path(&n.file),
                "migrate-crate and build.rs must agree on which module src/{} is",
                n.file
            );
            assert_eq!(n.record_id("demo"), super::materialize_plan::expected_id("demo", &n.file));
        }
        // The children a directory module's record must NOT keep.
        let cli = tree.iter().find(|n| n.file == "cli.rs").expect("cli");
        assert_eq!(cli.children.len(), 1, "cli.rs declares `mod nouns;`");
        let stripped = strip_child_decls(cli.source.as_deref().unwrap(), &cli.children).unwrap();
        assert!(!stripped.contains("mod nouns;"), "the child declaration is stripped: {stripped}");
        assert!(stripped.contains("pub fn run()"), "…and nothing else is: {stripped}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn build_script_effects_names_the_directives_and_dedupes_them() {
        let src = "println!(\"cargo:rerun-if-changed={}\", p);\nprintln!(\"cargo:rerun-if-changed={}\", q);\nprintln!(\"cargo:rustc-link-lib=dylib=rstrtmgr\");\n";
        assert_eq!(build_script_effects(src), vec!["cargo:rerun-if-changed", "cargo:rustc-link-lib"]);
        assert!(build_script_effects("fn main() {}").is_empty());
    }
}

/// The PURE PLANNING CORE of `crates/graph-materialize/build.rs`, included VERBATIM.
///
/// `crates/graph-materialize` is not a package — it is a bare `build.rs` (plus this `plan.rs`) that 50
/// crates point their `build =` key at — so it has no test target and nothing in it could be asserted
/// except by compiling a crate and reading the output. Including the source here rather than restating
/// it is the point: a restatement can drift from what the build runs, and the drift would be invisible
/// exactly where it matters — the id derivation this file's own `migrate-crate` has to agree with.
#[cfg(test)]
#[allow(dead_code)]
mod materialize_plan {
    include!("../../graph-materialize/plan.rs");
}

#[cfg(test)]
mod materialize_plan_tests {
    use super::materialize_plan::{expected_id, module_path, render, Unit, PREAMBLE};
    use std::path::{Path, PathBuf};

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf()
    }

    fn unit(id: &str, path: &[&str], code: &str, vis: &str) -> Unit {
        Unit {
            id: id.into(),
            path: path.iter().map(|s| (*s).to_string()).collect(),
            code: code.into(),
            vis: vis.into(),
            attrs: vec![],
        }
    }

    /// The scheme, as a golden file. `src/cli.rs` + `src/cli/nouns.rs` is `plandb`'s real shape and the
    /// one that blocked it: before this, `rest.contains('/')` dropped `cli/nouns.rs` on the floor, so
    /// the crate could not migrate at all.
    ///
    /// Written as an EXACT expected string rather than a set of `contains` assertions, because the two
    /// things that can silently go wrong here are both about position — a child emitted outside its
    /// parent still contains both `mod` lines, and an offset that is off by the preamble's height still
    /// contains a plausible-looking header.
    #[test]
    fn a_nested_directory_becomes_a_nested_mod_tree() {
        let out = render(
            vec![
                unit("plandb--cli--nouns.rs", &["cli", "nouns"], "pub fn noun() {}", ""),
                unit("plandb--cli.rs", &["cli"], "pub fn run() {}", "pub "),
            ],
            "plandb",
            PREAMBLE,
        )
        .expect("a parent and its child render");

        let expected = format!(
            "{PREAMBLE}pub mod cli {{\n\
             \x20   // record `plandb--cli.rs` — line N here is line N-10 in the record.\n\
             pub fn run() {{}}\n\
             mod nouns {{\n\
             \x20   // record `plandb--cli--nouns.rs` — line N here is line N-13 in the record.\n\
             pub fn noun() {{}}\n\
             }}\n\
             }}\n"
        );
        assert_eq!(out, expected, "the nested tree mirrors the directory tree");
        // …and the offsets in that golden are arithmetic, not decoration.
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[10 - 1 + 1], "pub fn run() {}", "record line 1 of the parent is at 1+10");
        assert_eq!(lines[13 - 1 + 1], "pub fn noun() {}", "record line 1 of the child is at 1+13");
    }

    /// `<dir>/mod.rs` is the DIRECTORY module. The basename-derived name emitted `pub mod mod { … }`,
    /// which is not parseable Rust — `mod` is a keyword — so every mod.rs-style crate (bsc-news,
    /// bsc-lan-core, research, and 24 files of src-tauri) was unmigratable for that reason alone.
    #[test]
    fn mod_rs_maps_to_its_directory_never_to_a_module_called_mod() {
        assert_eq!(module_path("signals/mod.rs"), Some(vec!["signals".to_string()]));
        assert_eq!(
            module_path("adapters/mod.rs"),
            Some(vec!["adapters".to_string()]),
            "the mod.rs shape bsc-lan-core uses"
        );
        assert_eq!(module_path("a/b/mod.rs"), Some(vec!["a".to_string(), "b".to_string()]));
        // A stray `src/mod.rs` names no module at all, and neither does the crate root.
        assert_eq!(module_path("mod.rs"), None);
        assert_eq!(module_path("lib.rs"), None);
        assert_eq!(module_path("main.rs"), None);
        // …but `foo/lib.rs` IS the module `foo::lib`; the root exemption is the ROOT, not the name.
        assert_eq!(module_path("foo/lib.rs"), Some(vec!["foo".to_string(), "lib".to_string()]));

        let out = render(
            vec![
                unit("bsc-news--signals--mod.rs", &["signals"], "pub struct S;", "pub "),
                unit("bsc-news--signals--framing.rs", &["signals", "framing"], "pub fn f() {}", "pub "),
            ],
            "bsc-news",
            PREAMBLE,
        )
        .expect("mod.rs is the directory module");
        assert!(out.contains("pub mod signals {"), "{out}");
        assert!(out.contains("pub mod framing {"), "{out}");
        assert!(!out.contains("mod mod"), "never a module literally called `mod`: {out}");
    }

    /// THE OFFSET HEADER IS THE ONLY THING making a compiler error inside a 12,609-line record
    /// navigable, and nesting is where it would silently stop being true: emit the modules first and
    /// prepend the preamble afterwards and every offset is short by the preamble's height, while every
    /// header still reads plausibly.
    ///
    /// So this does not assert the arithmetic, it PERFORMS it: every line of every record carries its
    /// own record-line number, and the test reads the offset out of each header and checks that the
    /// generated line it names says the number it should.
    #[test]
    fn the_offset_header_is_exact_at_every_depth() {
        let body = |n: usize| (1..=n).map(|i| format!("// record line {i}")).collect::<Vec<_>>().join("\n");
        let out = render(
            vec![
                unit("k--a.rs", &["a"], &body(7), "pub "),
                unit("k--a--b.rs", &["a", "b"], &body(4), "pub "),
                unit("k--a--b--c.rs", &["a", "b", "c"], &body(9), "pub "),
                unit("k--z.rs", &["z"], &body(3), "pub "),
            ],
            "k",
            PREAMBLE,
        )
        .expect("three levels render");

        let lines: Vec<&str> = out.lines().collect();
        let mut checked = 0usize;
        for (i, l) in lines.iter().enumerate() {
            let Some(rest) = l.trim().strip_prefix("// record `") else { continue };
            let offset: usize = rest
                .rsplit_once("line N-")
                .and_then(|(_, t)| t.split(' ').next())
                .and_then(|n| n.parse().ok())
                .unwrap_or_else(|| panic!("unparseable header: {l}"));
            assert_eq!(offset, i + 1, "the offset IS the header's own line number");
            // Record line 1 lands at generated line offset+1, which is index `offset`.
            assert_eq!(lines[offset], "// record line 1", "header at line {}: {l}", i + 1);
            checked += 1;
        }
        assert_eq!(checked, 4, "every module carries a header — otherwise this loop proves nothing");
    }

    /// A nested module whose PARENT has no record cannot be placed, and inventing an empty `pub mod`
    /// wrapper would assert a visibility the crate never declared. So it is a hard error that names the
    /// parent AND the two files that would provide it.
    #[test]
    fn a_nested_module_with_no_parent_record_is_a_named_error() {
        let err = render(
            vec![unit("plandb--cli--nouns.rs", &["cli", "nouns"], "pub fn n() {}", "pub ")],
            "plandb",
            PREAMBLE,
        )
        .expect_err("an orphan child cannot be placed");
        assert!(err.contains("cli::nouns"), "names the module: {err}");
        assert!(err.contains("crates/plandb/src/cli.rs"), "names the 2018-style body: {err}");
        assert!(err.contains("crates/plandb/src/cli/mod.rs"), "names the mod.rs body: {err}");
    }

    /// TWO RECORDS CLAIMING ONE MODULE stays a hard error, now keyed on the module PATH rather than the
    /// basename — `cli/nouns.rs` and `render/nouns.rs` are two different modules that share one.
    #[test]
    fn two_records_claiming_one_module_path_is_a_hard_error_and_a_shared_basename_is_not() {
        let err = render(
            vec![
                unit("k--cli.rs", &["cli"], "pub fn a() {}", "pub "),
                unit("k--cli-old.rs", &["cli"], "pub fn b() {}", "pub "),
            ],
            "k",
            PREAMBLE,
        )
        .expect_err("one module, two records");
        assert!(err.contains("two records claim module `cli`"), "{err}");

        render(
            vec![
                unit("k--cli.rs", &["cli"], "", "pub "),
                unit("k--cli--nouns.rs", &["cli", "nouns"], "", "pub "),
                unit("k--render.rs", &["render"], "", "pub "),
                unit("k--render--nouns.rs", &["render", "nouns"], "", "pub "),
            ],
            "k",
            PREAMBLE,
        )
        .expect("two modules named `nouns` under different parents are not a collision");
    }

    /// THE ID DERIVATION AGREES WITH `extract::module_id` — proved over every real Rust path in this
    /// tree, not asserted.
    ///
    /// This is the join that cannot be allowed to drift. `build.rs` selects a record with
    /// `id == expected_id(crate_dir, rest)`; `bsc graph emit` decides a record is a whole module with
    /// `extract::module_id(src) == id`; `migrate-crate` names what it writes with the same call. If the
    /// three disagree by one character, records silently stop matching their modules and the failure
    /// surfaces as an unresolved import several steps downstream.
    #[test]
    fn expected_id_agrees_with_extract_module_id() {
        let mut checked = 0usize;
        let mut nested = 0usize;
        let mut mod_rs = 0usize;
        for entry in std::fs::read_dir(repo().join("crates")).expect("crates/") {
            let dir = entry.expect("entry").path();
            let Some(krate) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
            let src = dir.join("src");
            if !src.is_dir() {
                continue;
            }
            for file in rs_files(&src, "") {
                let full = format!("crates/{krate}/src/{file}");
                assert_eq!(
                    expected_id(&krate, &file),
                    crate::extract::module_id(&full, "rs"),
                    "build.rs and extract::module_id must derive the SAME id for {full}"
                );
                if file.contains('/') {
                    nested += 1;
                }
                if file.ends_with("mod.rs") {
                    mod_rs += 1;
                }
                checked += 1;
            }
        }
        // POPULATION, so a walker that silently stopped matching fails loudly rather than passing over
        // nothing. Measured 2026-09-04: 216 files, 30 nested, 4 mod.rs — and every one of those numbers
        // FALLS as crates migrate into the graph, so the floors are deliberately well under them and
        // exist to catch a walk that found nothing, not to pin a census.
        assert!(checked > 120, "the walk found only {checked} .rs files under crates/*/src");
        assert!(nested >= 20, "only {nested} nested files — the case this change exists for");
        assert!(mod_rs >= 4, "only {mod_rs} mod.rs files");
    }

    /// The same agreement for `src-tauri`, which is the reason this change matters: 136 files at depth
    /// ≥ 2 and 24 `mod.rs`, none of which could migrate before.
    #[test]
    fn expected_id_agrees_with_extract_module_id_for_src_tauri() {
        let src = repo().join("src-tauri").join("src");
        let mut deep = 0usize;
        let mut mod_rs = 0usize;
        for file in rs_files(&src, "") {
            let full = format!("src-tauri/src/{file}");
            assert_eq!(expected_id("src-tauri", &file), crate::extract::module_id(&full, "rs"), "{full}");
            if file.matches('/').count() >= 1 {
                deep += 1;
            }
            if file.ends_with("mod.rs") {
                mod_rs += 1;
            }
        }
        // Measured 2026-09-04: 142 files, 137 nested, 24 mod.rs — the whole reason this change is the
        // prerequisite for src-tauri, which could not migrate a single one of them before.
        assert!(deep > 100, "only {deep} nested files under src-tauri/src");
        assert!(mod_rs >= 20, "only {mod_rs} mod.rs files under src-tauri/src");
    }

    /// NOTHING ALREADY MIGRATED CHANGES SHAPE. Driven over the REAL committed store and the REAL
    /// opted-in crates: for each FLAT one, the records `build.rs` selects and the file it renders must
    /// be byte-identical to what the previous flat scheme produced.
    ///
    /// The old scheme is reproduced inline (it is nine lines) rather than described, because "the output
    /// is unchanged" is the only claim that matters when a single file is the build input for 50 crates.
    ///
    /// A NESTED crate is EXCLUDED from the byte-identity arm, and that exclusion is the point rather
    /// than a concession: the flat scheme cannot express a nested module at all — it `continue`s on any
    /// `src` containing a `/` — so demanding byte-identity there would forbid exactly what nested
    /// materialization exists to do. `plandb` became the first such crate on 2026-09-04 and turned this
    /// test red; the fix is to scope the claim, not to weaken it.
    ///
    /// Excluding them silently would be the real hazard, so a nested crate is still CHECKED, just for a
    /// different property: every module the store holds for it must appear in the rendered output. That
    /// is what catches a nested unit being dropped on the floor. Nesting itself is pinned on synthetic
    /// input by `a_nested_directory_becomes_a_nested_mod_tree`, and at depth in the real emitted file by
    /// the offset probes recorded on `plandb-compiles-from-the-graph`.
    #[test]
    fn every_already_migrated_crate_renders_byte_identically_to_the_flat_scheme() {
        let root = repo();
        let store = crate::repo_store::read_at(&crate::repo_store::path_under(&root))
            .expect("the committed store parses")
            .expect("the committed store exists");
        let impls = store.get("implementations").and_then(|v| v.as_array()).expect("implementations");

        let mut crates = 0usize;
        let mut flat_crates = 0usize;
        let mut nested_crates = 0usize;
        for entry in std::fs::read_dir(root.join("crates")).expect("crates/") {
            let dir = entry.expect("entry").path();
            let Some(krate) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
            let cargo = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap_or_default();
            if !cargo.contains(super::MARKER) {
                continue;
            }
            crates += 1;
            let prefix = format!("crates/{krate}/src/");

            // Does the store hold a NESTED module for this crate? If so the flat scheme has nothing to
            // compare against — it skips those records entirely — so this crate takes the other arm.
            let nested_srcs: Vec<&str> = impls
                .iter()
                .filter_map(|i| i.get("src")?.as_str()?.strip_prefix(&prefix))
                .filter(|rest| rest.contains('/'))
                .collect();
            if !nested_srcs.is_empty() {
                nested_crates += 1;
                let units: Vec<Unit> = impls
                    .iter()
                    .filter_map(|i| {
                        let src = i.get("src")?.as_str()?;
                        let rest = src.strip_prefix(&prefix)?;
                        let path = module_path(rest)?;
                        let id = i.get("id")?.as_str()?;
                        if id != expected_id(&krate, rest) {
                            return None;
                        }
                        let vis = match i.get("moduleVis").and_then(|v| v.as_str()) {
                            Some("private") | Some("") => String::new(),
                            Some(v) => format!("{v} "),
                            None => "pub ".to_string(),
                        };
                        let attrs: Vec<String> = i
                            .get("moduleAttrs")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                            .unwrap_or_default();
                        Some(Unit { id: id.into(), path, code: i.get("code")?.as_str()?.into(), vis, attrs })
                    })
                    .collect();
                let ids: Vec<String> = units.iter().map(|u| u.id.clone()).collect();
                // EVERY NESTED RECORD MUST BE SELECTED. Checking only `units.len()` would not bite:
                // a crate's flat modules alone outnumber its nested ones, so a `module_path` that
                // returned None for every nested path would still leave a comfortably large `units`.
                // Name each one instead.
                for rest in &nested_srcs {
                    let want_id = expected_id(&krate, rest);
                    assert!(
                        ids.contains(&want_id),
                        "crates/{krate}: nested module {rest} (id {want_id}) was not selected for rendering"
                    );
                }
                let got = render(units, &krate, PREAMBLE).unwrap_or_else(|e| panic!("crates/{krate}: {e}"));
                // NO MODULE IS DROPPED ON THE WAY OUT. Every selected record must have written its
                // offset header into the output — the failure a blind `continue` here would hide.
                for id in &ids {
                    assert!(
                        got.contains(&format!("// record `{id}` — line N here is line N-")),
                        "crates/{krate}: record {id} never reached the rendered output"
                    );
                }
                continue;
            }
            flat_crates += 1;

            // The scheme as it was: direct children of src/ only, module = basename, id = the
            // underscore-to-hyphen swap of that basename, sorted by module name.
            let mut flat: Vec<(String, String, String, String, Vec<String>)> = Vec::new();
            for i in impls {
                let (Some(src), Some(id), Some(code)) = (
                    i.get("src").and_then(|v| v.as_str()),
                    i.get("id").and_then(|v| v.as_str()),
                    i.get("code").and_then(|v| v.as_str()),
                ) else {
                    continue;
                };
                let Some(rest) = src.strip_prefix(&prefix) else { continue };
                if rest.contains('/') || rest == "lib.rs" || rest == "main.rs" {
                    continue;
                }
                let Some(module) = rest.strip_suffix(".rs") else { continue };
                if id != format!("{krate}--{}.rs", module.replace('_', "-")) {
                    continue;
                }
                let vis = match i.get("moduleVis").and_then(|v| v.as_str()) {
                    Some("private") | Some("") => String::new(),
                    Some(v) => format!("{v} "),
                    None => "pub ".to_string(),
                };
                let attrs: Vec<String> = i
                    .get("moduleAttrs")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                flat.push((id.into(), module.into(), code.into(), vis, attrs));
            }
            assert!(!flat.is_empty(), "crates/{krate} carries the marker but the store holds no module for it");
            flat.sort_by(|a, b| a.1.cmp(&b.1));
            let mut want = String::from(PREAMBLE);
            for (id, module, code, vis, attrs) in &flat {
                for a in attrs {
                    if code.contains(&a.trim().replacen("#[", "#![", 1)) {
                        continue;
                    }
                    want.push_str(a);
                    want.push('\n');
                }
                want.push_str(&format!("{vis}mod {module} {{\n"));
                let at = want.lines().count() + 1;
                want.push_str(&format!("    // record `{id}` — line N here is line N-{at} in the record.\n"));
                want.push_str(&format!("{code}\n}}\n"));
            }

            // …and the same crate through the scheme this change installs.
            let units: Vec<Unit> = impls
                .iter()
                .filter_map(|i| {
                    let src = i.get("src")?.as_str()?;
                    let rest = src.strip_prefix(&prefix)?;
                    let path = module_path(rest)?;
                    let id = i.get("id")?.as_str()?;
                    if id != expected_id(&krate, rest) {
                        return None;
                    }
                    let vis = match i.get("moduleVis").and_then(|v| v.as_str()) {
                        Some("private") | Some("") => String::new(),
                        Some(v) => format!("{v} "),
                        None => "pub ".to_string(),
                    };
                    let attrs: Vec<String> = i
                        .get("moduleAttrs")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                        .unwrap_or_default();
                    Some(Unit { id: id.into(), path, code: i.get("code")?.as_str()?.into(), vis, attrs })
                })
                .collect();
            let got = render(units, &krate, PREAMBLE).unwrap_or_else(|e| panic!("crates/{krate}: {e}"));
            assert_eq!(got, want, "crates/{krate} must render exactly as it did before");
        }
        // POPULATION. A loop that found no opted-in crate would pass in silence, and so would one that
        // routed every crate down the (weaker) nested arm.
        assert!(crates >= 40, "only {crates} crates carry {} — the walk is wrong", super::MARKER);
        assert_eq!(flat_crates + nested_crates, crates, "every opted-in crate took exactly one arm");
        // Measured 2026-09-04: 51 opted-in, 50 flat, 1 nested (plandb). `flat_crates` FALLS as crates
        // migrate nested modules, so this floor is deliberately well under it — it exists to catch the
        // byte-identity arm going empty, not to pin a census.
        assert!(flat_crates >= 30, "only {flat_crates} flat crates — the byte-identity claim is thinning");
    }

    /// Every `.rs` under `dir`, as a path relative to it, skipping dot-directories.
    fn rs_files(dir: &Path, prefix: &str) -> Vec<String> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else { return out };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                out.extend(rs_files(&p, &format!("{prefix}{name}/")));
            } else if name.ends_with(".rs") {
                out.push(format!("{prefix}{name}"));
            }
        }
        out.sort();
        out
    }
}
