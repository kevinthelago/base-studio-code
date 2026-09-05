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
///
/// This is the line for a crate at `crates/<name>`; the path inside it is relative to the crate, so at
/// another depth it is [`marker_for`] that answers. See that function.
pub const MARKER: &str = r#"build = "../graph-materialize/build.rs""#;

/// The `[build-dependencies]` entry a crate takes when it reaches the materializer by CALLING it —
/// the line for a crate at `crates/<name>`, with [`dep_for`] as its depth-aware twin.
pub const DEP: &str = r#"graph-materialize = { path = "../graph-materialize" }"#;

/// The call a crate's OWN build script makes, as one more job beside the ones it already had.
///
/// [`calls_materializer`] is what detects it, lexically — a mention of this in a doc comment is not a
/// call, and reading one as a call already changed a refusal once.
pub const CALL: &str = "graph_materialize::emit();";

/// How a crate reaches the materializer. **A package gets exactly ONE build script**, and that single
/// fact is the whole reason there are two routes rather than one.
///
/// Both run THE SAME SOURCE — `crates/graph-materialize/build.rs` and its `src/lib.rs` `include!` the
/// same `plan.rs` and `emit.rs` — so a crate emits byte-identical output whichever way it got there.
/// The choice is about the manifest, never about the rules.
///
/// # Where this sits relative to [`calls_materializer`]
///
/// They are two halves of one story and neither subsumes the other:
///
/// - [`calls_materializer`] is PASSIVE. It asks whether a build script is ALREADY wired, and both
///   `refuse_reason` and the apply path use it to leave such a crate alone — nothing to replace,
///   nothing to opt in. That is what lets `migrate-crate src-tauri` work, since `src-tauri/build.rs`
///   was hand-wired ahead of its first record.
/// - [`Route::Alongside`] is ACTIVE. It DOES the wiring, for a crate whose build script does not have
///   it yet. `crates/data` and `crates/bsc-config` are that case
///   (`the-two-build-rs-crates-adopt-the-materializer-alongside-their-own`) and there was no route to
///   them at all before it: [`Route::Shared`] refuses them, correctly, because the `build =` key would
///   silently replace the script they need.
///
/// So the three shapes are: no build script → [`Route::Shared`]; a build script that already calls →
/// either route, both no-ops on the wiring; a build script that does NOT call → `--alongside` only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Route {
    /// The shared script IS the crate's build script ([`marker_for`]). One line in `Cargo.toml`, no
    /// build script of the crate's own. This is how the 58 crates that opted in before
    /// `graph-materialize` became a real package reach it, and it stays the default.
    #[default]
    Shared,
    /// The crate KEEPS its own `build.rs` and calls [`CALL`] from it, taking [`dep_for`] as a
    /// `[build-dependencies]` entry.
    ///
    /// Reached with `--alongside`. It is NOT the default and must not become one: for a crate with no
    /// build script of its own it would add a FILE where [`Route::Shared`] adds a line, which is
    /// exactly the net-zero outcome the shared script exists to avoid.
    Alongside,
}

/// One `<vis> mod name;` declaration, with everything attached to it that carries meaning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleDecl {
    pub name: String,
    /// The declared VISIBILITY, verbatim — `"pub"`, `"pub(crate)"`, `"pub(super)"`, `"pub(self)"`,
    /// `"pub(in crate::a)"`, or `""` for a bare private `mod`. `build.rs` emits what this says, not an
    /// assumption.
    ///
    /// A STRING rather than the `bool` it used to be, because `pub` and private were never the whole
    /// set: `pub(crate) mod x;` is neither, and collapsing it to either one changes what the crate
    /// exports. It was not an exotic shape — 13 declarations in `src-tauri` are spelled that way, and
    /// `planner/mod.rs` spells ALL FOUR of its children that way, so the entire subtree left with them.
    ///
    /// Canonically SPACED rather than byte-verbatim (`pub (crate)` records as `pub(crate)`), for the
    /// reason [`role_for`] squeezes an attribute: a record must not change because somebody reformatted
    /// the declaration.
    pub vis: String,
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

impl ModuleDecl {
    /// The `--module-vis` value this declaration records.
    ///
    /// `private` rather than an empty string because that is the word
    /// `graph-materialize/emit.rs` maps back to a bare `mod`; every other visibility is passed through
    /// unchanged, and that side already renders an ARBITRARY vis string (`Some(v) => format!("{v} ")`),
    /// so `pub(crate)` materializes as `pub(crate) mod x { … }` with nothing else to teach it.
    pub fn module_vis(&self) -> &str {
        if self.vis.is_empty() { "private" } else { &self.vis }
    }
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
    read_decls(lib_src).0
}

/// [`module_decls`], plus every line that IS a `mod` declaration and could not be read as one.
///
/// The pair exists because the second half used to be nothing at all. A declaration the parser did not
/// recognize was indistinguishable from a line that is not a declaration, so it left the plan SHORT and
/// silent — 13 modules of `src-tauri`, and with `planner/mod.rs` a whole subtree. That is this repo's
/// signature failure (a tool reporting less than it knows while looking green), so the shortfall is now
/// a value the caller has to carry rather than a `continue`.
///
/// Each entry is the offending line, trimmed and verbatim.
pub fn read_decls(lib_src: &str) -> (Vec<ModuleDecl>, Vec<String>) {
    // WHICH BYTES ARE CODE. `mod` inside a doc comment or a test fixture string is prose ABOUT a
    // declaration, not one — and this crate's own `migrate.rs` holds four such fixture lines
    // (`pub mod cli;\n\` inside a raw continuation), which a raw line scan reads as an unreadable
    // declaration and would refuse the crate over. The mask already exists for `include_str!`
    // evidence, which is the same discrimination.
    let mask = CodeMask::of(lib_src);
    let lines: Vec<&str> = lib_src.split('\n').collect();
    let mut out = Vec::new();
    let mut unreadable = Vec::new();
    let mut line_start = 0usize;
    for (i, raw) in lines.iter().enumerate() {
        let at = line_start;
        line_start += raw.len() + 1;
        let Some(kw) = raw.find("mod") else { continue };
        if !mask.is_code(at + kw) {
            continue;
        }
        let (vis, name) = match parse_mod_line(raw) {
            ModLine::Decl(vis, name) => (vis, name),
            ModLine::Unreadable => {
                unreadable.push(raw.trim().to_string());
                continue;
            }
            ModLine::Other => continue,
        };
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
            vis,
            line: (*raw).to_string(),
            block: lines[j..=i].join("\n"),
            docs,
            attrs,
        });
    }
    (out, unreadable)
}

/// What a source line is, as far as module declarations go.
///
/// THREE answers rather than two, and the third is the whole point of the type. A `mod` declaration the
/// parser could not read used to return the same `None` as a line that is not a declaration at all, so
/// the tool's plan was short and nothing said so. A silent skip is what produced the `pub(crate)` gap;
/// [`ModLine::Unreadable`] is what stops the next one, because [`refuse_reason`] turns it into a
/// refusal that names the line.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ModLine<'a> {
    /// `<vis> mod <name>;` — the visibility verbatim (`""` when private) and the module name.
    Decl(String, &'a str),
    /// It IS a `mod` declaration and this parser cannot read how it is spelled. Never skipped.
    Unreadable,
    /// Not a declaration: ordinary code, or an inline `mod x { … }`, which has no file to migrate.
    Other,
}

/// `<vis> mod <name>;` on a line of its own — see [`ModLine`].
///
/// Deliberately line-shaped rather than a parse: the rewrite removes the matched LINE, so anything this
/// recognizes must be removable as one. A `mod x { … }` inline module is not matched and not migrated.
///
/// EVERY visibility Rust spells is read, and each one round-trips unchanged, because
/// `graph-materialize/plan.rs::emit_level` nests a child INSIDE its parent's `mod` block — the
/// materialized crate has the identical module tree, so a POSITION-RELATIVE visibility (`pub(super)`,
/// `pub(self)`, `pub(in <path>)`) means in the record exactly what it meant in the file. Excluding them
/// would have been the cheaper change and the wrong one: `pub(crate)` was already "the exotic form
/// nobody writes" right up until it hid a subtree, and a form left unread is a form left SILENT.
fn parse_mod_line(line: &str) -> ModLine<'_> {
    let t = line.trim();
    // The TAIL of a multi-line visibility — `pub(\n    crate\n) mod x;`. Its restriction is on another
    // line, so the declaration can be neither read nor REMOVED as one line. Reported, not dropped.
    if let Some(tail) = t.strip_prefix(')') {
        return match mod_shape(tail.trim_start()) {
            ModShape::Decl(_) | ModShape::Unreadable => ModLine::Unreadable,
            ModShape::Inline | ModShape::NotMod => ModLine::Other,
        };
    }
    // The visibility prefix. `pub` must be a whole TOKEN (`pub_thing` is not `pub`), and Rust allows a
    // space before the restriction (`pub (crate) mod x;`), so it is consumed rather than string-matched.
    let after_pub = t
        .strip_prefix("pub")
        .filter(|a| !a.starts_with(|c: char| c.is_alphanumeric() || c == '_'));
    let (vis, rest) = match after_pub {
        None => (Ok(String::new()), t),
        Some(after) => {
            let after = after.trim_start();
            match after.strip_prefix('(') {
                // `pub(` with no `)` on this line is the HEAD of a multi-line visibility; its tail is
                // caught above, which is where the restriction can actually be judged.
                None => (Ok("pub".to_string()), after),
                Some(open) => match open.find(')') {
                    None => return ModLine::Other,
                    Some(close) => (restriction(&open[..close]), open[close + 1..].trim_start()),
                },
            }
        }
    };
    // The SHAPE is decided before the visibility is judged, so `pub(in weird!) fn f()` is ordinary code
    // rather than an unreadable module declaration.
    match mod_shape(rest) {
        ModShape::NotMod | ModShape::Inline => ModLine::Other,
        ModShape::Unreadable => ModLine::Unreadable,
        ModShape::Decl(name) => match vis {
            Ok(v) => ModLine::Decl(v, name),
            Err(()) => ModLine::Unreadable,
        },
    }
}

/// What follows a visibility on a line.
enum ModShape<'a> {
    /// `mod <name>;` — the name.
    Decl(&'a str),
    /// `mod <name> { … }`, which owns no file.
    Inline,
    /// A `mod` declaration whose name or trailer this tool cannot read — a raw identifier
    /// (`mod r#async;`), a trailing comment, two declarations on one line, a `;` on the next line.
    /// Each of those is removable-as-a-line in a way that would take something else with it, or
    /// materializable only by guessing, so each is reported rather than migrated.
    Unreadable,
    /// Not a `mod` item at all.
    NotMod,
}

fn mod_shape(rest: &str) -> ModShape<'_> {
    let Some(after) = rest.strip_prefix("mod") else { return ModShape::NotMod };
    if !after.starts_with(char::is_whitespace) {
        return ModShape::NotMod;
    }
    let body = after.trim();
    if body.split(';').next().unwrap_or(body).contains('{') {
        return ModShape::Inline;
    }
    match body.strip_suffix(';').map(str::trim) {
        Some(name) if is_ident(name) => ModShape::Decl(name),
        _ => ModShape::Unreadable,
    }
}

/// The canonical `pub(…)` spelling for a restriction, or `Err` when it is not one Rust defines.
///
/// Whitespace is normalized rather than preserved (`pub(in  crate :: a)` records as
/// `pub(in crate::a)`) so a record does not change because a declaration was reformatted.
fn restriction(raw: &str) -> Result<String, ()> {
    let squeezed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    match squeezed.as_str() {
        "crate" | "super" | "self" => Ok(format!("pub({squeezed})")),
        r => match r.strip_prefix("in ") {
            Some(path) => {
                let segs: Vec<&str> = path.split("::").map(str::trim).collect();
                if segs.iter().all(|s| is_ident(s)) {
                    Ok(format!("pub(in {})", segs.join("::")))
                } else {
                    Err(())
                }
            }
            None => Err(()),
        },
    }
}

/// A plain Rust identifier — no raw `r#` form, which names a FILE this tool would have to spell
/// differently from the declaration.
fn is_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
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
    ///
    /// `crate_dir` is the crate's REPO-RELATIVE directory — `crates/plandb`, `src-tauri` — never a bare
    /// crate name pasted into `crates/{}`. That hard-coded layout is what made `src-tauri` unnameable,
    /// and this is the same value `graph-materialize/emit.rs::src_prefix` derives at the other end of
    /// the agreement, from the manifest directory rather than from a convention.
    pub fn record_id(&self, crate_dir: &str) -> String {
        crate::extract::module_id(&format!("{crate_dir}/src/{}", self.file), "rs")
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
    module_walk(src_dir, root_src, "the crate root").nodes
}

/// The result of one crate walk: its modules, and every declaration the walk could not read.
pub struct CrateWalk {
    /// Every module, depth-first from the root, parents before their children.
    pub nodes: Vec<ModuleNode>,
    /// `<file>: <line>` for each `mod` declaration [`parse_mod_line`] cannot read.
    ///
    /// It is carried out of the walk instead of dropped inside it because a declaration the tool cannot
    /// see is a module it will not migrate, and the plan says nothing about what it never reached. That
    /// silence is the failure this list exists to make impossible — see [`refuse_reason`].
    pub unreadable: Vec<String>,
}

/// [`module_tree`], keeping what the walk could not read. `root_file` names the crate root for a
/// human — `lib.rs`, `main.rs`.
pub fn module_walk(src_dir: &Path, root_src: &str, root_file: &str) -> CrateWalk {
    let mut walk = CrateWalk { nodes: Vec::new(), unreadable: Vec::new() };
    walk_modules(src_dir, "", &[], root_src, root_file, &mut walk);
    walk
}

fn walk_modules(
    src_dir: &Path,
    rel_dir: &str,
    prefix: &[String],
    parent_src: &str,
    parent_file: &str,
    walk: &mut CrateWalk,
) {
    let (decls, unreadable) = read_decls(parent_src);
    walk.unreadable.extend(unreadable.into_iter().map(|l| format!("{parent_file}: {l}")));
    for decl in decls {
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
        // A directory module's own declarations are read HERE and reported by the recursion below, so
        // each unreadable line is attributed to exactly one file rather than twice or not at all.
        let children = if is_dir_module {
            source.as_deref().map(module_decls).unwrap_or_default()
        } else {
            Vec::new()
        };
        let child_file = file.clone();
        walk.nodes.push(ModuleNode { path: path.clone(), file, decl, children, source: source.clone() });
        if is_dir_module {
            if let Some(src) = source.as_deref() {
                let name = path.last().expect("just pushed").clone();
                walk_modules(src_dir, &format!("{rel_dir}{name}/"), &path, src, &child_file, walk);
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
    /// The `build = "…"` line THIS crate would need — [`marker_for`] of its repo-relative directory.
    ///
    /// A field rather than the [`MARKER`] constant because the path inside it is relative to the crate,
    /// so "already migrated" is a different string at a different depth. Reading the constant here would
    /// have told a depth-1 crate it was not migrated when it was, and offered it a build key cargo
    /// cannot resolve.
    pub marker: &'a str,
    /// The `[build-dependencies]` line THIS crate would need under [`Route::Alongside`] — [`dep_for`]
    /// of its repo-relative directory.
    ///
    /// A field for exactly the reason [`marker`](Self::marker) is one: the path inside it is relative
    /// to the crate. `src-tauri` reaches the same package at `../crates/graph-materialize`, and writing
    /// the depth-1 form there would produce a manifest cargo cannot resolve — the same
    /// silent-until-build failure, on the other route.
    pub dep: &'a str,
    /// EVERY module of the crate, at every depth — see [`module_tree`].
    ///
    /// This replaced a flat `top_files` + `nested_count` pair, and the replacement is what removed the
    /// nested-directory refusal: a directory is no longer a shape the tool cannot describe, it is a
    /// module with children. A directory holding no Rust (a `fixtures/` of JSON, a `.claude/` of
    /// session state) is now invisible for a better reason than a heuristic — nothing DECLARES it, so
    /// the walk never reaches it.
    pub modules: &'a [ModuleNode],
    /// Every `mod` declaration in this crate the walk could NOT read — see [`CrateWalk::unreadable`].
    ///
    /// A field on the SHAPE rather than a warning printed by the walk, because the honest verdict for a
    /// crate holding one is a refusal: the plan is short by an unknown amount, and `--apply` would
    /// migrate the modules it found while leaving behind declarations pointing at files it deleted.
    pub unreadable: &'a [String],
}

/// Which bytes of Rust source are CODE, and where the string literals sitting in code are.
///
/// NOT a parser — a LEXER, and only over the four things that can hide a token from a text scan:
/// `//` line comments, `/* … */` block comments (which NEST in Rust), string literals under every
/// prefix the language allows (`"…"`, `b"…"`, `c"…"`, `r"…"`, `r#"…"#`, `br#"…"#`), and char
/// literals. That is the exact discrimination the caller needs and nothing more: the difference
/// between a LIVE `include_str!` and text that merely NAMES one is entirely lexical, so a full parse
/// would answer the same question at far greater cost, while anything narrower than a lexer keeps
/// getting it wrong in one direction or the other.
///
/// Two details are load-bearing rather than incidental:
/// - **Escapes.** The fixture that blocked `bsc-graph` is `"… include_str!(\"cli.rs\") …"`, so a
///   scanner that ends a literal at the next `"` splits it in the middle and reads the inside as code.
/// - **`'a` is a lifetime, not a quote.** Treating one as an opening char literal blanks every byte to
///   the next `'`, which is usually real code — the failure that hides a live call.
pub(crate) struct CodeMask {
    /// One entry per BYTE: `true` when that byte is code, `false` inside a comment or a literal.
    code: Vec<bool>,
    /// Every string literal in code position, ascending by [`CodeString::start`].
    pub(crate) strings: Vec<CodeString>,
}

/// One string literal sitting in code position — its SPAN as well as its body.
///
/// The span is what a REWRITER needs and a reporter does not: [`include_str_targets`] only has to
/// read a path out, while `extract::absolutize_includes` has to replace the literal in place, and
/// "the bytes of the literal" is not something a text scan can recover once escapes and raw
/// delimiters are in play.
pub(crate) struct CodeString {
    /// The first byte of the literal TOKEN, prefix included — `r` in `r#"…"#`, `b` in `b"…"`.
    pub(crate) start: usize,
    /// The text between the delimiters, verbatim. Escapes are NOT decoded: this is what the source
    /// says, which is what has to be written back.
    pub(crate) body: String,
    /// The byte after the closing delimiter, so `start..after` is the whole literal.
    pub(crate) after: usize,
    /// A raw literal (`r"…"`, `r#"…"#`, `br#"…"#`), whose body may itself contain a bare `"`.
    pub(crate) raw: bool,
}

impl CodeMask {
    pub(crate) fn is_code(&self, at: usize) -> bool {
        self.code.get(at).copied().unwrap_or(false)
    }

    /// The string literal STARTING at `at`, when one does.
    ///
    /// A literal's own bytes are not code, so [`is_code`](Self::is_code) alone cannot walk to one —
    /// a scan looking for the argument of `include_str!` steps clean over the argument. `strings` is
    /// ascending by construction, so this is a binary search.
    pub(crate) fn string_at(&self, at: usize) -> Option<&CodeString> {
        self.strings.binary_search_by_key(&at, |s| s.start).ok().map(|i| &self.strings[i])
    }

    /// The next byte at or after `from` that begins a TOKEN — whitespace and comments stepped over,
    /// and a string literal reported at its opening byte rather than walked past.
    ///
    /// Stepping over a comment rather than stopping at it is deliberate: `include_str! /* why */
    /// ("x")` is one live call, and reading the `/` as the argument would quietly decline to
    /// absolutize a path that then fails to resolve out of `$OUT_DIR`.
    pub(crate) fn next_token(&self, src: &[u8], from: usize) -> Option<usize> {
        let mut k = from;
        while k < src.len() {
            if self.string_at(k).is_some() {
                return Some(k);
            }
            if self.is_code(k) {
                if src[k].is_ascii_whitespace() {
                    k += 1;
                    continue;
                }
                return Some(k);
            }
            k += 1;
        }
        None
    }

    pub(crate) fn of(src: &str) -> Self {
        let b = src.as_bytes();
        let n = b.len();
        let mut code = vec![true; n];
        let mut strings: Vec<CodeString> = Vec::new();
        let mut i = 0usize;
        while i < n {
            if b[i] == b'/' && i + 1 < n && b[i + 1] == b'/' {
                let start = i;
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
                code[start..i].fill(false);
                continue;
            }
            if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
                let start = i;
                let mut depth = 1usize;
                i += 2;
                while i < n && depth > 0 {
                    if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
                        depth += 1;
                        i += 2;
                    } else if b[i] == b'*' && i + 1 < n && b[i + 1] == b'/' {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                code[start..i].fill(false);
                continue;
            }
            if let Some((quote, hashes, raw)) = string_open(b, i) {
                let body = quote + 1;
                let (body_end, after) = if raw { close_raw(b, body, hashes) } else { close_plain(b, body) };
                strings.push(CodeString {
                    start: i,
                    body: String::from_utf8_lossy(&b[body..body_end]).into_owned(),
                    after: after.min(n),
                    raw,
                });
                code[i..after.min(n)].fill(false);
                i = after;
                continue;
            }
            if b[i] == b'\'' {
                if let Some(after) = close_char(b, i) {
                    code[i..after.min(n)].fill(false);
                    i = after;
                    continue;
                }
            }
            i += 1;
        }
        CodeMask { code, strings }
    }
}

/// A string literal opening at `i`: `(the quote's offset, how many `#` pad a raw one, whether it is raw)`.
///
/// The prefix only counts when it STARTS a token, or the `r` of `for` opens a raw string.
fn string_open(b: &[u8], i: usize) -> Option<(usize, usize, bool)> {
    let n = b.len();
    if i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_') {
        return None;
    }
    let mut j = i;
    if j < n && matches!(b[j], b'b' | b'c') {
        j += 1;
    }
    let raw = j < n && b[j] == b'r';
    if raw {
        j += 1;
    }
    let hash_start = j;
    while j < n && b[j] == b'#' {
        j += 1;
    }
    let hashes = j - hash_start;
    // `#` padding is a RAW-string thing; `#[attr]` and `#"` are not string opens.
    if j < n && b[j] == b'"' && (raw || hashes == 0) { Some((j, hashes, raw)) } else { None }
}

/// The body end and the byte after a plain string literal — the one shape where `\"` does NOT close it.
fn close_plain(b: &[u8], body: usize) -> (usize, usize) {
    let n = b.len();
    let mut k = body;
    while k < n {
        match b[k] {
            b'\\' => k += 2,
            b'"' => return (k, k + 1),
            _ => k += 1,
        }
    }
    (n, n)
}

/// The same, for `r#"…"#`: nothing escapes, and the terminator is `"` followed by exactly the padding.
fn close_raw(b: &[u8], body: usize, hashes: usize) -> (usize, usize) {
    let n = b.len();
    let mut k = body;
    while k < n {
        if b[k] == b'"' && b[k + 1..].iter().take(hashes).filter(|c| **c == b'#').count() == hashes {
            return (k, k + 1 + hashes);
        }
        k += 1;
    }
    (n, n)
}

/// The byte after a char literal at `i`, or `None` when the quote opens a LIFETIME instead.
fn close_char(b: &[u8], i: usize) -> Option<usize> {
    let n = b.len();
    if i + 1 >= n {
        return None;
    }
    if b[i + 1] == b'\\' {
        // An escape, bounded: `'\u{1F600}'` is the longest shape Rust allows.
        return (i + 2..n.min(i + 13)).find(|k| b[*k] == b'\'').map(|k| k + 1);
    }
    // Exactly one char, which may be several bytes — walk off its UTF-8 continuation bytes.
    let mut k = i + 2;
    while k < n && b[k] & 0xC0 == 0x80 {
        k += 1;
    }
    if k < n && b[k] == b'\'' { Some(k + 1) } else { None }
}

/// Every path literal passed to a LIVE `include_str!` in `src`.
///
/// Still not a parse — the shapes in this tree are `include_str!("x.rs")` and
/// `include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/x.rs"))`, and both are answered by taking the
/// LAST string literal before the closing paren.
///
/// What it is no longer is a RAW text scan. That could not tell a call from text describing one, and it
/// cost twice in a day: `bsc-graph` was refused over the fixture string in
/// `refuses_a_module_that_reads_a_file_the_migration_deletes` and over the `//` comments in
/// [`refuse_reason`] that explain the rule — the rule refusing the crate that implements it — and
/// `bsc-secret` was refused a second time with identical wording after its live read was removed and
/// only the prose explaining the removal was left. So a token is evidence only where [`CodeMask`] says
/// it is code, and the literals it may read are the ones the same pass found in code position.
fn include_str_targets(src: &str) -> Vec<String> {
    let mask = CodeMask::of(src);
    let b = src.as_bytes();
    let mut out = Vec::new();
    for (at, _) in src.match_indices("include_str!") {
        if !mask.is_code(at) {
            continue;
        }
        // …and a whole token: `my_include_str!` is a different macro.
        if at > 0 && (b[at - 1].is_ascii_alphanumeric() || b[at - 1] == b'_') {
            continue;
        }
        let end = (at..b.len()).find(|k| b[*k] == b')' && mask.is_code(*k)).unwrap_or(b.len());
        if let Some(s) = mask.strings.iter().rev().find(|s| s.start > at && s.start < end) {
            out.push(s.body.clone());
        }
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
/// A RAW text scan, unlike [`include_str_targets`]: a directive inside a comment is counted. That is
/// the same mistake, made deliberately, because it lands somewhere else — this feeds a message a human
/// reads and never a verdict, so over-reporting costs a reader one glance rather than a blocked crate.
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

/// The `role` a migrated module's record wears — `test` or `algorithm`
/// (`a-test-only-module-is-not-an-algorithm`).
///
/// A module is a TEST when its DECLARATION gates it out of production builds. `#[cfg(test)]` on the
/// `mod` line is not a heuristic about the module: it is the compiler's own statement that the module
/// is absent from every shipped binary, which is exactly what "not production logic" means.
///
/// This is the write path that produced the two mis-roled records. Every module `migrate-crate` lifted
/// was set `--role algorithm`, so `llm--http-it.rs` (405 lines of localhost mock-HTTP integration test)
/// and `bsc-ui--test-store.rs` both landed claiming to be production logic. Nothing broke — the same
/// `moduleAttrs` still gate them out at materialization — but any consumer that surveys or ranks
/// implementations counted test code as production logic.
///
/// The role is STORED, not recomputed from `moduleAttrs` on every read. Derivation is the auditor, not
/// the definition: `bsc graph doctor` reports the two disagreeing (`mis-roled-test`), which keeps a
/// reformatted attribute from silently reclassifying a record and leaves room to label a test-support
/// module that is deliberately not `#[cfg(test)]`-gated.
///
/// A FEATURE gate is not a test gate: `crates/data` gates three modules on
/// `#[cfg(feature = "duckdb-store")]` and those are production logic that happens to be optional.
fn role_for(d: &ModuleDecl) -> &'static str {
    let is_cfg_test = d.attrs.iter().any(|a| {
        // Whitespace-insensitive: a record must not change role because somebody reformatted the
        // declaration. `#[ cfg ( test ) ]` and `#[cfg(test)]` are the same gate.
        let squeezed: String = a.chars().filter(|c| !c.is_whitespace()).collect();
        squeezed == "#[cfg(test)]"
    });
    if is_cfg_test { "test" } else { "algorithm" }
}

/// The `impl set` argv `migrate-crate` delegates for one module — the record's declaration, recorded.
///
/// A FUNCTION rather than an inline vec because it is the only place the ROLE is chosen, and a test
/// that reaches `role_for` alone does not prove this call site uses it. It did not: the role was a
/// hardcoded `"algorithm"` here for every module, which is exactly how `llm--http-it.rs` and
/// `bsc-ui--test-store.rs` came to claim they were production logic. Reverting `role_for` to a constant
/// left every `role_for` unit test green, because none of them ran through here.
///
/// `delegate` is a free function, so a test cannot capture what was sent; making the argv itself
/// testable is the seam that costs nothing.
fn impl_set_argv(id: &str, n: &ModuleNode) -> Vec<String> {
    let d = &n.decl;
    ["impl", "set", "--tech", "rust", "--id", id, "--role", role_for(d),
     "--name", n.name(), "--module-vis", d.module_vis()]
        .iter().map(|s| (*s).to_string()).collect()
}

/// Why this crate cannot be migrated by this tool, or `None` when it can.
///
/// Every refusal here was a real failure first. Refusing UP FRONT is the feature: reached late, a
/// migration has already written records for a crate that will not complete, and the message names a
/// symptom instead of a cause.
pub fn refuse_reason(shape: &CrateShape<'_>, route: Route) -> Option<String> {
    let marker = shape.marker;
    if shape.cargo_toml.contains(marker) {
        return Some(format!("already migrated — its Cargo.toml carries {marker}"));
    }
    // A DECLARATION THIS TOOL CANNOT READ IS A REFUSAL, NEVER A SKIP.
    //
    // The plan would be short by an unknown amount and nothing would say so — which is exactly how
    // `pub(crate) mod x;` went unseen for the whole of `src-tauri` and, through `planner/mod.rs`, for a
    // whole subtree. It is also a correctness risk under `--apply`: the "declares [x] with no matching
    // file" check below cannot see a declaration the parser did not read either, so the migration would
    // delete files while leaving the declarations that name them.
    if !shape.unreadable.is_empty() {
        let shown: Vec<&str> = shape.unreadable.iter().take(5).map(String::as_str).collect();
        let more = shape.unreadable.len().saturating_sub(shown.len());
        return Some(format!(
            "{} module declaration(s) cannot be read, so the plan would be SHORT and nothing would say              so: {}{}. `migrate-crate` reads `mod x;`, `pub mod x;` and every restricted form              (`pub(crate)`, `pub(super)`, `pub(self)`, `pub(in <path>)`) written on ONE line with a              plain identifier. Put the declaration in one of those shapes, or teach `parse_mod_line`              the new one — do not leave it unseen",
            shape.unreadable.len(),
            shown.join("; "),
            if more > 0 { format!("; and {more} more") } else { String::new() }
        ));
    }
    match route {
        // A CRATE GETS EXACTLY ONE BUILD SCRIPT, and `opt_in` adds ours without looking for the crate's
        // own. Checked FIRST because it is the only refusal here whose damage is silent.
        //
        // REAL, both found green by `migrate-crate` on 2026-09-04:
        //   crates/bsc-config/build.rs stages $OUT_DIR/config-seed for an `include_dir!` in lib.rs —
        //     replacing it is an immediate, loud compile failure.
        //   crates/data/build.rs emits `cargo:rustc-link-lib=dylib=rstrtmgr` on WINDOWS ONLY, for
        //     DuckDB's Restart Manager references — replacing it changes NOTHING observable on Linux
        //     and breaks the Windows link. That is the dangerous one, and it is why the message quotes
        //     the directives.
        //
        // Neither crate DECLARES `build =`: cargo auto-detects `build.rs`, so nothing in the manifest
        // names the script, and a reader diffing the Cargo.toml afterwards sees only a line being added.
        //
        // …UNLESS that build script ALREADY CALLS THE MATERIALIZER. Then it is not a script about to be
        // replaced, it is the OTHER adoption route — a build-dependency call site, which
        // `graph-materialize-becomes-a-real-build-dependency` added so a package whose build script
        // already does other jobs (src-tauri does four) could materialize without giving any of them up.
        // Nothing to replace, nothing to fold, and `opt_in` is skipped for it downstream. See
        // `calls_materializer`.
        //
        // It stays a REFUSAL for the un-wired case rather than silently becoming `--alongside`: the two
        // routes edit different files, and quietly picking the one that rewrites the crate's own build
        // script is not a choice a tool should make for a reader who asked for the other.
        Route::Shared => {
            if let Some((path, src)) = shape.build_rs.filter(|(_, s)| !calls_materializer(s)) {
                let effects = build_script_effects(src);
                let does = if effects.is_empty() {
                    "emits no cargo: directives".to_string()
                } else {
                    format!("emits {}", effects.join(", "))
                };
                return Some(format!(
                    "{path} already exists ({} lines, {does}) and this crate gets exactly ONE build \
                     script — cargo AUTO-DETECTS build.rs, so nothing in Cargo.toml names it and adding \
                     {marker} would SILENTLY REPLACE it. Re-run with --alongside to KEEP that script and \
                     call the materializer from it instead",
                    src.lines().count()
                ));
            }
            // The same collision, declared rather than auto-detected. `opt_in` inserts the marker after
            // the edition line without removing anything, so a second `build =` key makes the manifest
            // unparseable — and it would do so AFTER the records were written, which is the late failure
            // this function exists to prevent.
            if let Some(declared) = declared_build_script(shape.cargo_toml) {
                return Some(format!(
                    "its Cargo.toml already declares `build = \"{declared}\"` and a crate gets exactly \
                     ONE build script — adding {marker} would leave two `build` keys in one manifest. \
                     Re-run with --alongside to KEEP that script and call the materializer from it instead"
                ));
            }
        }
        // The mirror image: `--alongside` has nothing to add the call TO unless the crate owns a build
        // script, and the write path edits the AUTO-DETECTED `<crate_dir>/build.rs` by name.
        //
        // NOTE what is deliberately NOT refused here — a build script that already calls the
        // materializer. That is `calls_materializer`'s carve-out and it is the same answer on this
        // route: the wiring half is simply already done, `add_emit_call` and `opt_in` are both
        // idempotent, and the modules still migrate. Refusing it would block `migrate-crate src-tauri`,
        // whose build script was hand-wired ahead of its first record — the exact crate the carve-out
        // was written for.
        Route::Alongside => {
            let Some((path, src)) = shape.build_rs else {
                return Some(
                    "--alongside keeps the crate's OWN build script and calls the materializer from it, \
                     and this crate has no build.rs — drop --alongside and it opts into the shared script \
                     with one manifest line instead of a new file"
                        .to_string(),
                );
            };
            // A DECLARED path other than `build.rs` is refused rather than guessed at: the write path
            // edits `<crate_dir>/build.rs` by name, so a manifest pointing somewhere else would have the
            // call inserted into a file cargo never runs — inert, and invisible, which is the exact
            // silent-success failure every refusal here exists to prevent.
            if let Some(declared) = declared_build_script(shape.cargo_toml) {
                if declared != "build.rs" {
                    return Some(format!(
                        "its Cargo.toml declares `build = \"{declared}\"`, but --alongside edits {path} — \
                         the call would land in a file cargo does not run. Add {CALL} to {declared} by \
                         hand, with `{}` under [build-dependencies]",
                        shape.dep
                    ));
                }
            }
            if !src.contains("fn main(") {
                return Some(format!("{path} has no `fn main(` for --alongside to add {CALL} to"));
            }
        }
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
    // A `*_test.rs` / `*_tests.rs` MODULE USED TO BE REFUSED HERE, because `is_test_file` gated the
    // whole file out of the harvest (#4136) so no record could be created and the file could not be
    // retired. It is not a refusal any more: that gate read a FILENAME as a verdict, and
    // `crates/bsc-graph/src/rust_test.rs` — 358 lines of production logic — disproved it. The
    // function-granularity harvest still skips a test-only file, now by its CONTENTS
    // (`extract::rust_file_is_test_only`), while module granularity always lifts and records the role.
    //
    // What the refusal was right about survives as the ROLE: see `role_for`. A `#[cfg(test)]` module
    // migrates as `role: test`, so it is retired without being counted as production logic — at every
    // depth, now that `module_tree` walks nested modules.
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
fn include_block(krate: &str, nodes: &[ModuleNode], route: Route) -> String {
    let files: Vec<String> = nodes.iter().map(|n| format!("src/{}", n.file)).collect();
    // WHICH build script, because the header is what a reader who opens the directory acts on. Saying
    // "the shared build script" for a `--alongside` crate sends them looking for a `build =` key its
    // manifest does not have — the same invisibility that made the collision this route exists for so
    // hard to see in the first place.
    let by = match route {
        Route::Shared => "materialized into $OUT_DIR by the shared build script.".to_string(),
        Route::Alongside => format!(
            "materialized into $OUT_DIR by `{CALL}`, called from this\n// crate's own build.rs \
             (a package gets exactly ONE build script, and this one was taken)."
        ),
    };
    [
        "// This crate's modules are IN THE GRAPH, not in this directory.".to_string(),
        format!(
            "// {} {} — {} in the",
            files.join(", "),
            if files.len() == 1 { "does not exist" } else { "do not exist" },
            if files.len() == 1 { "it is a record" } else { "they are records" }
        ),
        format!("// committed graph/algorithms.json, {by}"),
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
pub fn rewrite_lib(
    lib_src: &str,
    decls: &[ModuleDecl],
    nodes: &[ModuleNode],
    krate: &str,
    route: Route,
) -> Result<String, String> {
    let out = remove_decl_blocks(lib_src, decls)?;
    Ok(format!("{}\n\n{}", out.trim_end(), include_block(krate, nodes, route)))
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

/// `Cargo.toml` with the route's build wiring.
///
/// `wiring` is [`marker_for`] of the crate's repo-relative directory under [`Route::Shared`], and
/// [`dep_for`] of it under [`Route::Alongside`] — never the [`MARKER`] / [`DEP`] constants, because the
/// path inside each is relative to the crate that declares it and is therefore a fact about the crate's
/// DEPTH. All 58 shared adopters sit at `crates/<name>` and get the constant back unchanged.
///
/// The two routes wire DIFFERENT dependencies, and swapping them is silently wrong rather than a
/// compile error: the shared script parses the store itself (`serde_json`), while a crate that CALLS
/// the materializer needs the package and never touches JSON.
///
/// Idempotent on both routes: re-running adds nothing a second time.
pub fn opt_in(cargo_toml: &str, route: Route, wiring: &str) -> String {
    let mut out = cargo_toml.to_string();
    if route == Route::Shared && !out.contains(wiring) {
        // After the `edition` line, which every crate in this workspace has.
        if let Some(idx) = out.lines().position(|l| l.trim_start().starts_with("edition")) {
            let mut lines: Vec<String> = out.lines().map(str::to_string).collect();
            lines.insert(idx + 1, wiring.to_string());
            out = lines.join("\n");
            if cargo_toml.ends_with('\n') && !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    let (key, block) = match route {
        Route::Shared => (
            "serde_json",
            "[build-dependencies]\n\
             # build.rs parses the committed graph store directly — see crates/graph-materialize/build.rs.\n\
             serde_json = \"1\"\n\n"
                .to_string(),
        ),
        Route::Alongside => (
            "graph-materialize",
            format!(
                "[build-dependencies]\n\
                 # GRAPH MATERIALIZATION, as a real build-dependency. A package gets exactly ONE build\n\
                 # script and this crate already has its own, so the `build = \"…/graph-materialize/\n\
                 # build.rs\"` line the other adopters use is not available here — the shared file has to\n\
                 # be CALLED instead. build.rs runs it as one more job.\n\
                 {wiring}\n\n"
            ),
        ),
    };
    if !out.lines().any(|l| l.trim() == "[build-dependencies]") {
        if let Some(at) = out.find("[lib]") {
            out.insert_str(at, &block);
        } else {
            out = format!("{}\n\n{}", out.trim_end(), block.trim_end());
            out.push('\n');
        }
    } else if !section_of(&out, "[build-dependencies]").contains(key) {
        // The section exists but not our entry — add the LINE rather than a second header, which would
        // be a manifest with two `[build-dependencies]` tables and is a hard cargo error. `src-tauri`
        // is exactly this shape: it already declares `tauri-build` there.
        let mut lines: Vec<String> = out.lines().map(str::to_string).collect();
        if let Some(idx) = lines.iter().position(|l| l.trim() == "[build-dependencies]") {
            let entry: Vec<&str> = block.lines().skip(1).filter(|l| !l.is_empty()).collect();
            lines.insert(idx + 1, entry.join("\n"));
            out = lines.join("\n");
            out.push('\n');
        }
    }
    out
}

/// The body of one TOML table — from its header to the next `[` at the start of a line, or the end.
///
/// Used to ask whether `[build-dependencies]` already names an entry. A whole-file `contains` would
/// answer yes for `serde_json` in `[dependencies]`, which is true of nearly every crate here.
fn section_of(cargo_toml: &str, header: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for line in cargo_toml.lines() {
        if line.trim() == header {
            inside = true;
            continue;
        }
        if inside && line.starts_with('[') {
            break;
        }
        if inside {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// The crate's OWN build script with [`CALL`] added as one more job.
///
/// Inserted as the FIRST statement of `fn main`, not the last, and that is a constraint rather than a
/// preference: finding the END of `main` means matching braces, and a build script here is full of
/// `format!`/`panic!` strings carrying `{}` — `bsc-config`'s own has `"could not create the staged
/// config seed at {}: {e}"` — so a brace count closes `main` inside a string literal and splices the
/// call into the middle of the file. The jobs are independent (each only prints `cargo:` directives or
/// writes under `$OUT_DIR`), so order among them carries no meaning.
///
/// [`Route::Alongside`] means the crate's `lib.rs` `include!`s the result, so this calls `emit()` — the
/// hard-error entry point — never `emit_when_adopted()`. `src-tauri` uses the latter because it was
/// wired AHEAD of its first record; a crate migrating modules in the same change is not.
///
/// Idempotent, and it asks [`calls_materializer`] rather than a bare `contains` for the same reason
/// that function exists: a build script whose DOC COMMENT names the call has not made one.
pub fn add_emit_call(build_src: &str) -> Result<String, String> {
    if calls_materializer(build_src) {
        return Ok(build_src.to_string());
    }
    let at = build_src.find("fn main(").ok_or("build.rs has no `fn main(` to add the call to")?;
    let open = build_src[at..]
        .find('{')
        .map(|i| at + i + 1)
        .ok_or("build.rs's `fn main` has no body to add the call to")?;
    let mut out = String::with_capacity(build_src.len() + 256);
    out.push_str(&build_src[..open]);
    out.push_str(
        "\n    // Materialize this crate's graph records into `$OUT_DIR/crate.rs`, which `lib.rs`\n    \
         // `include!`s. A package gets exactly ONE build script and this one is already spoken for, so\n    \
         // the materializer is CALLED here rather than reached with a `build =` key — same source, same\n    \
         // output, one manifest line's difference\n    \
         // (`graph-materialize-becomes-a-real-build-dependency`).\n    ",
    );
    out.push_str(CALL);
    out.push('\n');
    out.push_str(&build_src[open..]);
    Ok(out)
}

/// Every path the workspace manifest lists in `members`, in declaration order.
///
/// A TEXT scan of the array rather than a TOML parse, matching `declared_build_script` beside it and
/// `bsc`'s own `crate_roster`. The list in this workspace is 70 quoted literals across three lines with
/// no globs and no inline tables, so there is nothing here a parser would see that a scan does not — and
/// the scan cannot pull a TOML dependency into a crate whose whole job is to be cheap to compile.
///
/// Returns empty for a tree with no `[workspace]` at all, which is a scratch fixture, not an error:
/// [`resolve_crate_dir`] falls through to discovery there.
pub fn workspace_members(root_manifest: &str) -> Vec<String> {
    let Some(start) = root_manifest.find("members") else { return Vec::new() };
    let Some(open) = root_manifest[start..].find('[').map(|i| i + start) else { return Vec::new() };
    let Some(close) = root_manifest[open..].find(']').map(|i| i + open) else { return Vec::new() };
    let mut out = Vec::new();
    let mut rest = &root_manifest[open..close];
    while let Some(q) = rest.find('"') {
        let after = &rest[q + 1..];
        let Some(e) = after.find('"') else { break };
        let m = after[..e].replace('\\', "/");
        let m = m.trim_matches('/').to_string();
        if !m.is_empty() {
            out.push(m);
        }
        rest = &after[e + 1..];
    }
    out
}

/// Which members `krate` names — matched on the member path's LAST SEGMENT, or on the whole path.
///
/// The tool's argument has always been a DIRECTORY name (`data`, whose package is `bsc-data`), so the
/// last segment is what it has always meant; accepting the full path too means `crates/data` and
/// `src-tauri` can both be typed literally. Every match is returned rather than the first, because two
/// members ending in the same segment is a question for the caller and not something to resolve by
/// declaration order — see [`resolve_crate_dir`].
pub fn member_dirs(members: &[String], krate: &str) -> Vec<String> {
    members
        .iter()
        .filter(|m| m.as_str() == krate || m.rsplit('/').next() == Some(krate))
        .cloned()
        .collect()
}

/// The crate's REPO-RELATIVE directory — DERIVED, never assumed to be `crates/<krate>`.
///
/// # Why this is not simply a second hard-coded case
///
/// `src-tauri` is not an exception to a `crates/<name>` rule; it is the proof that the rule was never
/// the truth. Cargo resolves membership from the workspace manifest's `members` list, and that list is
/// the ONLY thing that decides where a workspace member lives — `bsc`'s own crate roster already reads
/// it for exactly this reason, and its doc comment records that a listing of `crates/` disagrees with it
/// in BOTH directions (it drops `src-tauri`, and it invents packages out of directories that are not
/// ones). So this asks the manifest, which is the same move `graph-materialize-becomes-a-real-build-
/// dependency` made at the other end of the pipeline when it replaced a `manifest.parent().parent()`
/// repo root with an upward walk for the store. Adding `src-tauri` as a second branch would have left
/// the next member at a new depth exactly as unreachable as `src-tauri` was.
///
/// # The fallback is DISCOVERY, not a convention
///
/// A tree with no `[workspace]` — every scratch fixture in this module's tests — gets a probe instead:
/// `<root>/<krate>` and `<root>/*/<krate>`, taking whichever holds a `Cargo.toml`. That still names no
/// directory in advance, so `crates/demo` is found for the same reason `src-tauri` would be, and a
/// fixture laid out under `pkgs/` would work without this function learning the word `pkgs`.
///
/// Ambiguity is an ERROR naming the candidates. Picking one would be a coin flip that migrates the
/// wrong crate's source, and this tool deletes files.
pub fn resolve_crate_dir(root: &Path, krate: &str) -> Result<String, String> {
    let manifest = std::fs::read_to_string(root.join("Cargo.toml")).unwrap_or_default();
    let members = workspace_members(&manifest);
    let mut found = member_dirs(&members, krate);
    let from_members = !found.is_empty();
    if !from_members {
        // No workspace manifest, or a directory that is not a member. Probe rather than assume.
        let mut seen: Vec<String> = Vec::new();
        if root.join(krate).join("Cargo.toml").is_file() {
            seen.push(krate.to_string());
        }
        if let Ok(entries) = std::fs::read_dir(root) {
            let mut parents: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .filter(|d| !d.starts_with('.') && d != "target" && d != "node_modules")
                .filter(|d| root.join(d).join(krate).join("Cargo.toml").is_file())
                .map(|d| format!("{d}/{krate}"))
                .collect();
            parents.sort();
            seen.append(&mut parents);
        }
        found = seen;
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(format!(
            "no workspace member or directory named `{krate}` under {} — the workspace lists {} \
             member(s), and nothing at <root>/{krate} or <root>/*/{krate} holds a Cargo.toml",
            root.display(),
            members.len()
        )),
        _ => Err(format!(
            "`{krate}` is ambiguous — it names [{}]. Pass the full repo-relative path instead",
            found.join(", ")
        )),
    }
}

/// The `build = "…"` line a crate at `crate_dir` needs to reach the shared script, relative to ITSELF.
///
/// [`MARKER`] is that line for a crate at `crates/<name>`, which is where all 58 adopters sit — but the
/// path inside it is relative to the crate's own directory, so it is a fact about DEPTH rather than a
/// constant. `src-tauri` sits one level up and needs `crates/graph-materialize/build.rs`. Writing
/// `MARKER` there would produce a manifest cargo cannot resolve, which is a silent-until-build failure
/// of exactly the kind `refuse_reason` exists to move to the front.
pub fn marker_for(crate_dir: &str) -> String {
    let mut rel = rel_to_materializer(crate_dir);
    rel.push("build.rs".into());
    format!("build = \"{}\"", rel.join("/"))
}

/// The `[build-dependencies]` line a crate at `crate_dir` needs to CALL the materializer, relative to
/// ITSELF — [`marker_for`]'s twin on the other route.
///
/// Same depth fact, same failure if ignored: [`DEP`] is right at `crates/<name>` and wrong everywhere
/// else, and `src-tauri` — the one adopter not at that depth — declares
/// `path = "../crates/graph-materialize"`. Sharing [`rel_to_materializer`] with `marker_for` is what
/// keeps the two from disagreeing about depth, which is the kind of drift neither would report.
pub fn dep_for(crate_dir: &str) -> String {
    let rel = rel_to_materializer(crate_dir);
    // The materializer's OWN directory resolves to no segments at all, which is `.` as a cargo path —
    // nonsense as a dependency (it cannot depend on itself) but it must not render as the empty string,
    // which is what a bare `join` produces and what an earlier version of this pair got wrong.
    let path = if rel.is_empty() { ".".to_string() } else { rel.join("/") };
    format!("graph-materialize = {{ path = \"{path}\" }}")
}

/// The path SEGMENTS from `crate_dir` up to `crates/graph-materialize` — possibly none, when the crate
/// IS that directory.
///
/// One derivation behind both [`marker_for`] and [`dep_for`]: a crate reaches the same package either
/// way, so the only thing that can differ between the two lines is what they append. Returning segments
/// rather than a joined string is deliberate — joining here made `marker_for("crates/graph-materialize")`
/// render `build = "/build.rs"` with a leading slash, which `the_build_key_is_derived_from_the_crates_own_depth`
/// caught immediately. An empty path is a real case, not a corner.
fn rel_to_materializer(crate_dir: &str) -> Vec<String> {
    const TARGET: [&str; 2] = ["crates", "graph-materialize"];
    let from: Vec<&str> = crate_dir.split('/').filter(|s| !s.is_empty()).collect();
    let shared = from.iter().zip(TARGET.iter()).take_while(|(a, b)| a == b).count();
    let mut rel: Vec<String> = std::iter::repeat_n("..".to_string(), from.len() - shared).collect();
    rel.extend(TARGET[shared..].iter().map(|s| (*s).to_string()));
    rel
}

/// Does this crate's OWN build script already call the materializer?
///
/// The build-script refusal exists because `opt_in` adds [`MARKER`] without looking, and cargo lets a
/// package have exactly one build script — so the crate's own would be SILENTLY REPLACED. That premise
/// does not hold for a crate that already calls `graph_materialize::…` from its own `build.rs`: it is
/// wired to the store through a build-DEPENDENCY, which is the route
/// `graph-materialize-becomes-a-real-build-dependency` added precisely so `src-tauri` — a package whose
/// build script already does four other jobs — could materialize without giving up any of them. There
/// is nothing to replace and nothing to fold, so refusing would be refusing an already-solved problem.
/// THE EVIDENCE IS LEXICAL, for the same reason `include_str_targets` above it is — a bare `contains`
/// got a verdict WRONG here too, and the two bugs were found independently on the same day.
///
/// `build_script_effects` beside this one is a deliberate RAW text scan and says so, on the grounds
/// that a directive inside a comment "over-reports into a message a human reads and never into a
/// verdict". This one DOES feed a verdict, so that looseness is not available to it. Measured: a bare
/// `contains("graph_materialize::")` matched the phrase `calls as `graph_materialize::emit()`` in the
/// SHARED script's own module docs, so `crates/graph-materialize` — whose `build.rs` IS that script and
/// which calls nothing — silently changed refusal from "already has its own build script" to "declares
/// no modules". Same exit code, different reason, and nothing would have said so; only a diff of all 70
/// crates against the previous binary caught it.
///
/// It reuses [`CodeMask`] rather than stripping comment lines itself. A line scan would have answered
/// this case, and it would still have been a SECOND half-answer to a question the crate had just
/// settled properly: the mask also knows string literals, nested `/* */`, and escapes, so a
/// `graph_materialize::` inside a fixture string is not a call either.
pub fn calls_materializer(build_src: &str) -> bool {
    let mask = CodeMask::of(build_src);
    build_src.match_indices("graph_materialize::").any(|(at, _)| mask.is_code(at))
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
    let route = if args.iter().any(|a| a == "--alongside") { Route::Alongside } else { Route::Shared };
    let root = args
        .iter()
        .position(|a| a == "--root")
        .and_then(|i| args.get(i + 1))
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?);

    // WHERE THE CRATE IS, derived from the workspace rather than pasted into `crates/{}`. Everything
    // repo-relative below — the record id, the harvest path, the build.rs path, the recovery hint — is
    // built from this ONE value, so there is a single place the layout is decided and no second copy of
    // it to fall out of step. See `resolve_crate_dir`.
    let crate_dir = resolve_crate_dir(&root, &krate)?;
    let dir = root.join(&crate_dir);
    let src_dir = dir.join("src");
    let root_path = crate_root(&src_dir)
        .ok_or_else(|| format!("{crate_dir}/src has neither lib.rs nor main.rs"))?;
    let root_name = root_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let cargo_path = dir.join("Cargo.toml");
    let cargo_toml = std::fs::read_to_string(&cargo_path)
        .map_err(|e| format!("cannot read {}: {e}", cargo_path.display()))?;
    let lib_src = std::fs::read_to_string(&root_path)
        .map_err(|e| format!("cannot read {}: {e}", root_path.display()))?;

    // The crate's OWN build script, if it has one. Read here rather than merely probed, because the
    // refusal quotes what it does — see `refuse_reason`.
    let build_path = dir.join("build.rs");
    let build_rel = format!("{crate_dir}/build.rs");
    let build_src = std::fs::read_to_string(&build_path).ok();

    // EVERY module of the crate, at every depth, each reached from the declaration that names it. The
    // scan used to be one `read_dir` of `src/` and a count of directories, which is why a nested
    // directory could only ever be a refusal — nothing in `lib.rs` names `cli/nouns.rs`, only `cli.rs`
    // does.
    let walk = module_walk(&src_dir, &lib_src, &root_name);
    let nodes = walk.nodes;
    let marker = marker_for(&crate_dir);
    let dep = dep_for(&crate_dir);
    let shape = CrateShape {
        cargo_toml: &cargo_toml,
        build_rs: build_src.as_deref().map(|s| (build_rel.as_str(), s)),
        root_name: &root_name,
        marker: &marker,
        dep: &dep,
        modules: &nodes,
        unreadable: &walk.unreadable,
    };
    // THE VERDICT AND THE PLAN ARE TWO DIFFERENT ANSWERS, and a dry run is owed both.
    //
    // `--apply` still refuses here, before anything is written — the refusal's whole value is being
    // reached UP FRONT, and none of that changes: same verdict, same message, same exit code.
    //
    // A DRY RUN is different, because it writes nothing whatever it prints. Returning the refusal alone
    // meant asking "what would migrating this crate do?" about a 142-module crate and being told one
    // sentence about one `include_str!`, with the other 141 modules unmentioned. That is the reader
    // learning less than the tool knows. So the plan is printed either way and the refusal is still
    // returned as the error — stdout gains the plan, stderr and the exit code are byte-identical to
    // what they were (`the_refusal_is_unchanged_and_the_dry_run_now_shows_its_plan_too`).
    let refusal = refuse_reason(&shape, route).map(|why| format!("REFUSED {krate}: {why}"));
    if apply {
        if let Some(why) = refusal {
            return Err(why);
        }
    }
    let root_decls = module_decls(&lib_src);

    writeln!(out, "\n{} {krate} — {} module(s):", if apply { "migrating" } else { "would migrate" }, nodes.len())
        .map_err(|e| e.to_string())?;
    if route == Route::Alongside {
        // The plan says which FILE it is about to rewrite, because that is the whole difference between
        // the routes and it is otherwise invisible until after `--apply`.
        let already = build_src.as_deref().is_some_and(calls_materializer);
        writeln!(
            out,
            "  route: ALONGSIDE — {build_rel} is KEPT and {}",
            if already { format!("already calls `{CALL}`") } else { format!("gains `{CALL}`") }
        )
        .map_err(|e| e.to_string())?;
    }
    for n in &nodes {
        // The ROLE is part of the plan, so the plan says it. A reader dry-running a crate with test
        // modules should see they land as `role: test` before `--apply` writes anything, not discover
        // it afterwards from the store.
        let role = role_for(&n.decl);
        writeln!(
            out,
            "  src/{}  ->  record {}{}",
            n.file,
            n.record_id(&crate_dir),
            if role == "algorithm" { String::new() } else { format!("  (role: {role})") },
        )
        .map_err(|e| e.to_string())?;
    }
    if !apply {
        // A refused crate is told what stands in the way AND what it would otherwise have migrated. The
        // refusal is still the return value, so the exit code and the message a caller sees are exactly
        // what they were before the plan was printed alongside them.
        match refusal {
            Some(why) => {
                writeln!(out, "\nDRY RUN — nothing was written, and --apply would refuse:").map_err(|e| e.to_string())?;
                return Err(why);
            }
            None => {
                writeln!(out, "\nDRY RUN — pass --apply to write.").map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
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
        let rel = format!("{crate_dir}/src/{}", n.file);
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
        let mut set = impl_set_argv(&id, n);
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
        writeln!(out, "  harvested {id}{}", if d.vis == "pub" { String::new() } else { format!(" ({})", d.module_vis()) })
            .map_err(|e| e.to_string())?;
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
    let rewritten = rewrite_lib(&lib_src, &root_decls, &nodes, &krate, route).map_err(|e| {
        rollback.restore();
        format!("{e} — nothing was deleted")
    })?;
    match route {
        // A crate whose OWN build script already calls the materializer is opted in ALREADY, through a
        // build-dependency rather than the `build =` key — adding the key would replace the very script
        // doing the call. `refuse_reason` lets that crate through for the same reason; this is the other
        // half of that decision, and leaving it out would have made the refusal a silent misfeature.
        Route::Shared => {
            if !build_src.as_deref().is_some_and(calls_materializer) {
                std::fs::write(&cargo_path, opt_in(&cargo_toml, route, &marker)).map_err(|e| e.to_string())?;
            }
        }
        // The other route WRITES that call rather than presuming it. Both steps are idempotent, so a
        // crate wired by hand ahead of its first record (`src-tauri`) passes through unchanged — which
        // is why "already calls the materializer" is not a refusal on this route either.
        //
        // The build script is rewritten BEFORE anything is deleted, for the same reason the lib rewrite
        // is computed first: a `main` this cannot find must stop the migration with every file still
        // present, not after.
        Route::Alongside => {
            let src = build_src.as_deref().ok_or("--alongside needs the crate's build.rs")?;
            let with_call = add_emit_call(src).inspect_err(|_| {
                rollback.restore();
            })?;
            if with_call != src {
                std::fs::write(&build_path, with_call).map_err(|e| format!("cannot write {build_rel}: {e}"))?;
            }
            std::fs::write(&cargo_path, opt_in(&cargo_toml, route, &dep)).map_err(|e| e.to_string())?;
        }
    }
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
             Recover with: git checkout {crate_dir} && git checkout graph/algorithms.json",
            err.lines().take(12).collect::<Vec<_>>().join("\n")
        ));
    }
    writeln!(out, "  BUILD PASSES — {krate} is now 1 .rs file").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One declaration, as `module_decls` would have read it. `vis` is the visibility verbatim —
    /// `""` for a bare private `mod`.
    fn decl(name: &str, vis: &str) -> ModuleDecl {
        let line = format!("{}mod {name};", if vis.is_empty() { String::new() } else { format!("{vis} ") });
        ModuleDecl { name: name.into(), vis: vis.into(), line: line.clone(), block: line, docs: vec![], attrs: vec![] }
    }

    #[test]
    fn module_decls_reads_visibility_docs_and_attributes() {
        let src = "//! crate\n\n/// The CLI.\npub mod cli;\n#[cfg(test)]\nmod surface_tests;\nmod tests {\n}\n";
        let d = module_decls(src);
        assert_eq!(d.len(), 2, "the inline `mod tests {{` is not a declaration: {d:?}");
        assert_eq!(d[0].name, "cli");
        assert_eq!(d[0].vis, "pub");
        assert_eq!(d[0].docs, vec!["/// The CLI.".to_string()]);
        assert_eq!(d[1].name, "surface_tests");
        assert_eq!(d[1].vis, "", "a bare `mod` is private and must be recorded as such");
        assert_eq!(d[1].attrs, vec!["#[cfg(test)]".to_string()]);
    }

    /// THE GAP, as a unit. Against the parser this replaced, ALL FOUR of these were invisible and the
    /// assertion read `left: []` — not a near-miss on one exotic form, a whole class unseen, because
    /// `strip_prefix("pub ")` demanded a SPACE where every restriction puts a paren.
    ///
    /// EVERY visibility Rust spells is read, and none is flattened to `pub`. That is not generosity, it
    /// is a property of the other end: `graph-materialize/plan.rs::emit_level` nests a child INSIDE its
    /// parent's `mod` block, so the materialized crate has the identical module tree and a
    /// POSITION-RELATIVE visibility means there exactly what it meant in the file.
    #[test]
    fn every_restricted_visibility_is_read_and_recorded_verbatim() {
        let src = "//! crate\n\
                   pub(crate) mod closure;\n\
                   pub(super) mod near;\n\
                   pub(self) mod own;\n\
                   pub(in crate::a::b) mod deep;\n\
                   pub mod open;\n\
                   mod shut;\n";
        let d = module_decls(src);
        let got: Vec<(&str, &str)> = d.iter().map(|x| (x.name.as_str(), x.vis.as_str())).collect();
        assert_eq!(
            got,
            [
                ("closure", "pub(crate)"),
                ("near", "pub(super)"),
                ("own", "pub(self)"),
                ("deep", "pub(in crate::a::b)"),
                ("open", "pub"),
                ("shut", ""),
            ],
            "every form is a declaration, and its visibility is recorded as written"
        );
        // What travels to the record. `private` is the word `emit.rs` maps back to a bare `mod`;
        // everything else is passed through, which is why nothing on the emit side needed teaching.
        let vis: Vec<&str> = d.iter().map(ModuleDecl::module_vis).collect();
        assert_eq!(vis, ["pub(crate)", "pub(super)", "pub(self)", "pub(in crate::a::b)", "pub", "private"]);
    }

    /// A record must not change because somebody reformatted the declaration — the same rule
    /// [`role_for`] applies to an attribute. Rust allows a space before the restriction and around the
    /// `::`, and `pub` is a TOKEN, so `pub_thing` is not one.
    #[test]
    fn a_reformatted_visibility_records_the_same_thing() {
        let d = module_decls("pub (crate) mod a;\npub(crate)mod b;\npub(in  crate :: x ) mod c;\n");
        let got: Vec<(&str, &str)> = d.iter().map(|x| (x.name.as_str(), x.vis.as_str())).collect();
        assert_eq!(got, [("a", "pub(crate)"), ("b", "pub(crate)"), ("c", "pub(in crate::x)")]);
        assert_eq!(module_decls("pub_thing mod x;\n").len(), 0, "`pub` must be a whole token");
    }

    /// The `--module-vis` the tool actually SENDS, from the declaration a walk actually read.
    ///
    /// A separate assertion from the parser's, because `impl_set_argv` is where the value leaves this
    /// crate and a parser test cannot see it — the same seam that caught `role_for` being bypassed by a
    /// hardcoded `"algorithm"` at this exact call site.
    #[test]
    fn impl_set_argv_sends_the_restricted_visibility_it_read() {
        let mut n = node(&["closure"], "closure.rs", Some("pub fn c() {}"));
        n.decl = module_decls("pub(crate) mod closure;\n").remove(0);
        let argv = impl_set_argv("bsc-component--closure.rs", &n);
        let at = argv.iter().position(|a| a == "--module-vis").expect("the flag is sent");
        assert_eq!(argv[at + 1], "pub(crate)", "not flattened to pub, and not to private: {argv:?}");

        n.decl = module_decls("mod closure;\n").remove(0);
        let argv = impl_set_argv("x", &n);
        let at = argv.iter().position(|a| a == "--module-vis").expect("the flag is sent");
        assert_eq!(argv[at + 1], "private", "a bare `mod` still records `private`");
    }

    /// A `mod` DECLARATION THIS PARSER CANNOT READ IS A REFUSAL, never a skip.
    ///
    /// A silent skip is the entire bug: the plan comes up short by an unknown amount and the tool
    /// reports success. So each shape below is one the parser deliberately does NOT migrate — a raw
    /// identifier names a file it would have to spell differently from the declaration, a trailing
    /// comment or a second declaration on the line would be swallowed by a LINE removal, and a
    /// multi-line visibility cannot be read OR removed as one line — and each is REPORTED.
    #[test]
    fn a_declaration_this_parser_cannot_read_is_reported_not_skipped() {
        for line in ["mod r#async;", "mod x; // note", "mod a; mod b;", "pub(nonsense) mod x;", ") mod x;"] {
            let (decls, unreadable) = read_decls(&format!("{line}\n"));
            assert!(decls.is_empty(), "`{line}` must not be migrated");
            assert_eq!(unreadable, [line.to_string()], "`{line}` must be REPORTED, not dropped");
        }
        // …and what must NOT be reported: ordinary code, an inline module, and a `pub(…)` restriction
        // on something that is not a module at all.
        for line in ["pub(in weird!) fn f() {}", "mod x { }", "pub(crate) mod x { }", "let modest = 1;"] {
            assert!(read_decls(&format!("{line}\n")).1.is_empty(), "`{line}` is not a bad declaration");
        }

        // The refusal names the count and the line, so the reader can act on it.
        let modules = [node(&["cli"], "cli.rs", Some(""))];
        let bad = ["lib.rs: mod r#async;".to_string()];
        let sh = CrateShape {
            cargo_toml: "[package]\nedition = \"2021\"\n",
            build_rs: None,
            root_name: "lib.rs",
            marker: MARKER,
            dep: DEP,
            modules: &modules,
            unreadable: &bad,
        };
        let why = refuse_reason(&sh, Route::Shared).expect("an unreadable declaration is a refusal");
        assert!(why.contains("lib.rs: mod r#async;"), "names the line: {why}");
        assert!(why.contains("cannot be read"), "{why}");
        assert!(why.contains("pub(crate)"), "says which shapes it DOES read: {why}");
    }

    /// A `mod` token in a COMMENT or a STRING is prose about a declaration, not one.
    ///
    /// This is not hypothetical tidiness: `crates/bsc-graph/src/cli.rs` is a directory module, so the
    /// walk reads its source, and this file holds four `pub mod cli;\n\` fixture lines inside raw
    /// continuations. A line scan reads those as unreadable declarations and refuses `bsc-graph` over
    /// its own test data — the same trap the `include_str!` evidence hit in this file the day before,
    /// which is why `CodeMask` was already here to reuse rather than a second answer to write.
    #[test]
    fn a_mod_line_inside_a_comment_or_a_string_is_neither_read_nor_reported() {
        let src = "//! doc: pub mod cli;\n\
                   // mod r#async;\n\
                   const F: &str = \"pub mod cli;\";\n\
                   const G: &str = \"mod r#async;\";\n\
                   /* mod block; */\n\
                   pub(crate) mod real;\n";
        let (decls, unreadable) = read_decls(src);
        assert_eq!(decls.len(), 1, "only the live declaration: {decls:?}");
        assert_eq!(decls[0].name, "real");
        assert!(unreadable.is_empty(), "nothing in a comment or a literal is a bad declaration: {unreadable:?}");
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
        let out = rewrite_lib(src, &[d], &nodes, "demo", Route::Shared).expect("the block is locatable");
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
            &[decl("cli", "pub")],
            &[node(&["cli"], "cli.rs", Some(""))],
            "demo",
            Route::Shared,
        )
        .unwrap();
        assert!(
            one.contains("// src/cli.rs does not exist — it is a record in the\n"),
            "the WHOLE line, not a prefix — a prefix assertion passed against \
             `it is a record records in the`: {one}"
        );
        let two = rewrite_lib(
            "pub mod cli;\npub mod store;\n",
            &[decl("cli", "pub"), decl("store", "pub")],
            &[node(&["cli"], "cli.rs", Some("")), node(&["store"], "store.rs", Some(""))],
            "demo",
            Route::Shared,
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
            &[decl("cli", "pub")],
            &[node(&["cli"], "cli.rs", Some("")), node(&["cli", "nouns"], "cli/nouns.rs", Some(""))],
            "demo",
            Route::Shared,
        )
        .unwrap();
        assert!(deep.contains("// src/cli.rs, src/cli/nouns.rs do not exist"), "{deep}");

        // …and it names the build script that ACTUALLY runs. `--alongside` leaves no `build =` key in
        // the manifest, so "the shared build script" would send the next reader hunting for a line that
        // is not there — the same invisibility that made the collision this route exists for so hard to
        // see in the first place.
        let along = rewrite_lib(
            "pub mod cli;\n",
            &[decl("cli", "pub")],
            &[node(&["cli"], "cli.rs", Some(""))],
            "demo",
            Route::Alongside,
        )
        .unwrap();
        assert!(!along.contains("the shared build script"), "{along}");
        assert!(along.contains("crate's own build.rs") && along.contains(CALL), "{along}");
        assert!(one.contains("the shared build script"), "…and the other route still says so: {one}");
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
            decl: decl(path.last().expect("a module has a name"), "pub"),
            children: vec![],
            source: source.map(str::to_string),
        }
    }

    fn shape<'a>(cargo: &'a str, modules: &'a [ModuleNode]) -> CrateShape<'a> {
        CrateShape {
            cargo_toml: cargo,
            build_rs: None,
            root_name: "lib.rs",
            marker: MARKER,
            dep: DEP,
            modules,
            unreadable: &[],
        }
    }

    #[test]
    fn refuses_every_shape_it_cannot_complete_and_says_which() {
        let cli = vec![node(&["cli"], "cli.rs", Some("pub fn run() {}\n"))];

        let already = format!("[package]\nedition = \"2021\"\n{MARKER}\n");
        assert!(refuse_reason(&shape(&already, &cli), Route::Shared).unwrap().contains("already migrated"));

        let plain = "[package]\nedition = \"2021\"\n";
        assert!(refuse_reason(&shape(plain, &[]), Route::Shared).unwrap().contains("declares no modules"));

        let gone = vec![node(&["gone"], "gone.rs", None)];
        let missing = refuse_reason(&shape(plain, &gone), Route::Shared).unwrap();
        assert!(missing.contains("gone") && missing.contains("no matching file"), "{missing}");

        // A `*_test/*_tests` module is NO LONGER refused (`a-test-only-module-is-not-an-algorithm`) —
        // pinned positively by `a_test_named_module_no_longer_refuses_the_crate`.

        // …and a crate it CAN do is not refused.
        assert!(refuse_reason(&shape(plain, &cli), Route::Shared).is_none());
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
        assert_eq!(refuse_reason(&shape(plain, &two_level), Route::Shared), None, "the 2018-style directory module");

        // …and `bsc-news`'s: the body inside the directory, as `mod.rs`.
        let mod_rs = vec![
            node(&["signals"], "signals/mod.rs", Some("pub struct S;\n")),
            node(&["signals", "framing"], "signals/framing.rs", Some("pub fn f() {}\n")),
        ];
        assert_eq!(refuse_reason(&shape(plain, &mod_rs), Route::Shared), None, "the mod.rs directory module");
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
            cargo_toml: plain, build_rs: None, root_name: "lib.rs", marker: MARKER, dep: DEP, modules: &sources,
            unreadable: &[],
        };
        let why = refuse_reason(&shape, Route::Shared).expect("a self-read must be refused");
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
            cargo_toml: plain, build_rs: None, root_name: "lib.rs", marker: MARKER, dep: DEP, modules: &survives,
            unreadable: &[],
        };
        assert!(refuse_reason(&ok, Route::Shared).is_none(), "a data file that survives is not a refusal");
    }

    /// REGRESSION, and the one that cost the most: a raw TEXT scan cannot tell a LIVE `include_str!`
    /// from text that merely NAMES one, and both halves of that mistake were paid for in a day.
    ///
    /// `bsc-graph` itself — 19,804 lines, the largest crate left — was refused over the FIXTURE STRING
    /// on the first line below, which is the fixture for
    /// `refuses_a_module_that_reads_a_file_the_migration_deletes`: the rule refusing the crate that
    /// implements it, over its own test data. The mirror image cost a rewrite — an agent removed
    /// `bsc-secret`'s genuine self-read and explained WHY in prose, and the refusal fired again, with
    /// identical wording, on a file that no longer had a live call.
    ///
    /// Every case here is TEXT ABOUT the macro. None is a call, so none may be refused.
    #[test]
    fn text_about_an_include_str_is_not_a_live_call() {
        let plain = "[package]\nedition = \"2021\"\n";
        let not_a_call = [
            // The real `bsc-graph` blocker, verbatim from this very file.
            "let sources = vec![(\"cli\".to_string(), \"fn t() { let s = include_str!(\\\"cli.rs\\\"); }\".to_string())];",
            // The `bsc-secret` shape: the read is GONE and only the explanation of it remains.
            "// the test used to call include_str!(\"cli.rs\") on its own source; it reads the record now",
            "/// Was `include_str!(\"cli.rs\")` before the migration.",
            "/* include_str!(\"cli.rs\") — kept here only to say what was removed */",
            // A raw string is a string too, and its escapes do not work the way a naive scan assumes.
            "const F: &str = r#\"fn t() { let s = include_str!(\"cli.rs\"); }\"#;",
        ];
        // Collected rather than asserted one at a time: the two shapes fail for different reasons, and a
        // report that stops at the first says nothing about whether the others were ever fixed.
        let mut wrong: Vec<String> = Vec::new();
        for src in not_a_call {
            let modules = vec![node(&["cli"], "cli.rs", Some(src))];
            let shape = CrateShape {
                cargo_toml: plain,
                build_rs: None,
                root_name: "lib.rs",
                marker: MARKER,
                dep: DEP,
                modules: &modules,
                unreadable: &[],
            };
            let targets = include_str_targets(src);
            if !targets.is_empty() {
                wrong.push(format!("read {targets:?} out of TEXT: {src}"));
            }
            if let Some(why) = refuse_reason(&shape, Route::Shared) {
                wrong.push(format!("REFUSED over text: {src}\n      → {why}"));
            }
        }
        assert!(wrong.is_empty(), "text about include_str! counted as a live call:\n  - {}", wrong.join("\n  - "));

        // …and the discrimination is not "never refuse": a LIVE call sitting in the same file as all of
        // that text is still found, so the fix cannot have been a blanket exemption.
        let mixed = format!("{}\n{}\nfn t() {{ let s = include_str!(\"cli.rs\"); }}\n", not_a_call[1], not_a_call[0]);
        assert_eq!(include_str_targets(&mixed), vec!["cli.rs".to_string()], "exactly the live call");
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
        let once = opt_in(before, Route::Shared, MARKER);
        assert!(once.contains(MARKER));
        assert!(once.contains("[build-dependencies]"));
        // Idempotent: a re-run must not double-add either.
        let twice = opt_in(&once, Route::Shared, MARKER);
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
        let why = refuse_reason(&s, Route::Shared).expect("an existing build.rs must be refused");
        assert!(why.contains("crates/data/build.rs"), "names the file: {why}");
        assert!(why.contains("cargo:rustc-link-lib"), "names what it does: {why}");
        assert!(why.contains("5 lines"), "names how much there is to lose: {why}");
        assert!(why.contains(MARKER), "names what would replace it: {why}");

        // A script emitting nothing still refuses, and says so rather than printing an empty list.
        let mut quiet = shape(plain, &cli);
        quiet.build_rs = Some(("crates/x/build.rs", "fn main() {}\n"));
        let why = refuse_reason(&quiet, Route::Shared).expect("a silent build.rs is still a build.rs");
        assert!(why.contains("emits no cargo: directives"), "{why}");

        // The DECLARED twin: `opt_in` would leave two `build` keys in one manifest, and only after the
        // records had been written.
        let declared = "[package]\nedition = \"2021\"\nbuild = \"gen.rs\"\n";
        let why = refuse_reason(&shape(declared, &cli), Route::Shared).expect("a declared build script too");
        assert!(why.contains("gen.rs") && why.contains("ONE build"), "{why}");

        // …and a crate with no build script of its own is still not refused.
        assert!(refuse_reason(&shape(plain, &cli), Route::Shared).is_none());
    }

    /// The two crates the audit found GREEN on 2026-09-04, driven through the REAL `run` against this
    /// repo — and they are no longer refused, because they were MIGRATED.
    ///
    /// # This test INVERTED, and the inversion is the deliverable
    ///
    /// It used to assert that `crates/data` and `crates/bsc-config` are refused for owning their own
    /// build script, and that was the correct verdict for as long as there was no route to them.
    /// `the-two-build-rs-crates-adopt-the-materializer-alongside-their-own` built that route: both keep
    /// their script and CALL the materializer from it, so `calls_materializer`'s carve-out now lets them
    /// through and the next refusal reached is the ordinary one — they have no modules left to migrate.
    ///
    /// What the old assertion protected is not lost, it MOVED, and both halves are stronger where they
    /// went: the refusal's verdict, message and exit are pinned byte-for-byte in
    /// `the_refusal_is_unchanged_and_the_dry_run_now_shows_its_plan_too`, and the state of these two
    /// crates is pinned in `the_two_build_rs_crates_reach_the_materializer_alongside_their_own`, which
    /// also asserts `crates/data`'s Windows-only link directive survived.
    ///
    /// `crates/data` is still checked by READING, never by building: its directive fires only on
    /// Windows, so on this box a replacement compiles, links and tests clean while the Windows link is
    /// broken. A test that tried to observe the breakage would observe nothing.
    #[test]
    fn the_two_crates_with_their_own_build_script_migrated_and_are_no_longer_refused() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        for krate in ["bsc-config", "data"] {
            let dir = repo.join("crates").join(krate);
            assert!(dir.join("build.rs").is_file(), "crates/{krate}/build.rs SURVIVED — the whole point");
            let cargo = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();
            assert!(!cargo.contains(MARKER), "…and was never replaced by the shared script");
            assert!(
                declared_build_script(&cargo).is_none(),
                "crates/{krate} still declares no build = — cargo auto-detects it, which is what would \
                 have made the replacement silent"
            );

            let mut out: Vec<u8> = Vec::new();
            let err = run(&[krate.into(), "--root".into(), repo.to_string_lossy().to_string()], &mut out)
                .expect_err("an already-migrated crate has nothing left to migrate");
            assert!(err.contains(&format!("REFUSED {krate}")), "{err}");
            // THE REASON MOVED, and that is the assertion. It is no longer the build-script collision —
            // that premise is false now — it is that lib.rs declares no modules, because they are all
            // records. Asserting the NEW reason rather than deleting the test is what keeps this from
            // passing for some third reason nobody looked at.
            assert!(err.contains("declares no modules"), "the reason moved to the ordinary one: {err}");
            assert!(!err.contains("gets exactly ONE build script"), "…and is NOT the collision: {err}");
            let text = String::from_utf8_lossy(&out);
            assert!(text.contains(&format!("would migrate {krate}")), "the plan is shown: {text}");
            assert!(text.contains("DRY RUN — nothing was written"), "…and said to be inert: {text}");
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

    /// A `#[cfg(test)]` module is a TEST, and after `a-test-only-module-is-not-an-algorithm` it
    /// migrates as one — `role: test`, not `role: algorithm`.
    ///
    /// This is the write path that produced the two mis-roled records. `migrate-crate` hardcoded
    /// `--role algorithm` for every module it lifted, so `llm--http-it.rs` (405 lines of localhost
    /// mock-HTTP integration test) and `bsc-ui--test-store.rs` both landed claiming to be production
    /// logic. Nothing broke — `moduleAttrs` still gate them out at materialization — but every
    /// consumer that surveys or ranks implementations counted test code as production logic.
    #[test]
    fn a_cfg_test_declaration_migrates_as_role_test() {
        // Built through `module_decls` rather than a struct literal, so the test drives the same
        // parse the migration does.
        let decls = module_decls(
            "//! demo\n\
             pub mod cli;\n\
             #[cfg(test)]\n\
             mod surface_tests;\n\
             #[ cfg ( test ) ]\n\
             mod spaced_tests;\n\
             #[cfg(feature = \"duckdb-store\")]\n\
             pub mod meta;\n",
        );
        let role = |n: &str| role_for(decls.iter().find(|d| d.name == n).expect("declared"));

        assert_eq!(role("surface_tests"), "test");
        // Whitespace inside the attribute is not significant — a record must not change role because
        // somebody reformatted the declaration.
        assert_eq!(role("spaced_tests"), "test");
        // A FEATURE gate is not a test gate. `crates/data` gates three modules on
        // `#[cfg(feature = "duckdb-store")]`; those are production logic that happens to be optional.
        assert_eq!(role("meta"), "algorithm");
        // And a plain declaration is production, which is every other module in the workspace.
        assert_eq!(role("cli"), "algorithm");
    }

    /// The MIRROR IMAGE of the mis-roling: a `*_test.rs` / `*_tests.rs` module used to be refused
    /// outright, so no record could be created and the file could not be retired. That refusal is gone
    /// — `bsc-json-store`'s `surface_tests` and `bsc-graph`'s `rust_test` are both migratable shapes.
    ///
    /// The refusal was never wrong about ITS crate, it was wrong about the RULE: it read a filename as
    /// a verdict. `crates/bsc-graph/src/rust_test.rs` is production logic (nine `pub fn` and a
    /// `pub struct` — the Rust half of `bsc graph test`) that the suffix called a test.
    /// The MIGRATION ITSELF sends `--role test`, not merely `role_for` returning it.
    ///
    /// `a_cfg_test_declaration_migrates_as_role_test` pins the derivation and CANNOT see this: reverting
    /// the call site to a hardcoded `"algorithm"` leaves it green, which was measured while resolving
    /// the merge with `graph-materialize-takes-nested-modules-and-mod-rs`. The hardcoded constant at
    /// this exact call site is the original defect, so it is the thing that has to be pinned — and it
    /// travels through `delegate`, a free function no test can capture, which is why the argv is built
    /// by `impl_set_argv` instead of inline.
    #[test]
    fn the_migration_sends_the_role_it_derived() {
        let pair = |argv: &[String], flag: &str| {
            argv.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone()).unwrap_or_default()
        };

        let mut test_node = node(&["surface_tests"], "surface_tests.rs", Some("#[test]\nfn t() {}\n"));
        test_node.decl.attrs = vec!["#[cfg(test)]".into()];
        let argv = impl_set_argv("demo--surface-tests.rs", &test_node);
        assert_eq!(pair(&argv, "--role"), "test", "a `#[cfg(test)]` module is SENT as a test: {argv:?}");
        assert_eq!(pair(&argv, "--name"), "surface_tests");
        assert_eq!(pair(&argv, "--id"), "demo--surface-tests.rs");

        // …and an ordinary module is still sent as production, so the pin cannot be satisfied by
        // hardcoding the other constant.
        let plain = node(&["cli"], "cli.rs", Some("pub fn run() {}\n"));
        assert_eq!(pair(&impl_set_argv("demo--cli.rs", &plain), "--role"), "algorithm");
    }

    /// The DRY RUN says a module will land as a test, before `--apply` writes anything.
    #[test]
    fn the_dry_run_names_the_role_a_test_module_will_land_with() {
        let root = std::env::temp_dir().join(format!("bsc-migrate-role-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("crates").join("demo").join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(root.join("crates/demo/Cargo.toml"), "[package]\nname = \"demo\"\nedition = \"2021\"\n").unwrap();
        std::fs::write(src.join("lib.rs"), "//! demo\npub mod cli;\n#[cfg(test)]\nmod surface_tests;\n").unwrap();
        std::fs::write(src.join("cli.rs"), "pub fn run() {}\n").unwrap();
        std::fs::write(src.join("surface_tests.rs"), "#[test]\nfn t() {}\n").unwrap();

        let mut out: Vec<u8> = Vec::new();
        run(&["demo".into(), "--root".into(), root.to_string_lossy().to_string()], &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();

        assert!(text.contains("src/surface_tests.rs  ->  record demo--surface-tests.rs  (role: test)"), "{text}");
        // An ordinary module carries no role suffix — naming the default on every line would be noise.
        assert!(text.contains("src/cli.rs  ->  record demo--cli.rs\n"), "{text}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_test_named_module_no_longer_refuses_the_crate() {
        // Both real shapes, at BOTH depths develop's `module_tree` now walks: `surface_tests` is the
        // genuinely test-only module that was blocked, `rust_test` the production module the suffix
        // libelled, and `cli::inner_tests` the same question one level down — a nested `*_tests` must
        // not refuse the crate either, or the tree walk simply relocates the blocker.
        let modules = vec![
            node(&["cli"], "cli.rs", Some("pub fn run() {}\n")),
            node(&["cli", "inner_tests"], "cli/inner_tests.rs", Some("#[test]\nfn t() {}\n")),
            node(&["surface_tests"], "surface_tests.rs", Some("#[test]\nfn t() {}\n")),
            node(&["rust_test"], "rust_test.rs", Some("pub fn crate_name() {}\n")),
        ];
        assert_eq!(
            refuse_reason(&shape("[package]\nedition = \"2021\"\n", &modules), Route::Shared),
            None,
            "a *_test/*_tests module must not refuse the crate, at any depth — the filename is not evidence"
        );
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
                graph_materialize::module_path(&n.file),
                "migrate-crate and build.rs must agree on which module src/{} is",
                n.file
            );
            assert_eq!(n.record_id("demo"), graph_materialize::expected_id("demo", &n.file));
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

    /// This repo's own root, for the tests below that must run against the REAL tree.
    fn repo() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf()
    }

    /// THE MEMBERS LIST IS THE AUTHORITY, and it disagrees with a listing of `crates/` in both
    /// directions — the exact reason `bsc`'s own crate roster reads it rather than `read_dir`.
    #[test]
    fn the_members_list_is_read_from_the_real_workspace_and_carries_src_tauri() {
        let manifest = std::fs::read_to_string(repo().join("Cargo.toml")).expect("the workspace manifest");
        let members = workspace_members(&manifest);
        // POPULATION, so a scan that silently stopped matching fails loudly rather than passing over
        // nothing — the same guard `workspace_members` in `bsc` makes with its `< 20` hard error.
        assert!(members.len() > 60, "the members scan found only {} entries", members.len());
        assert!(members.contains(&"src-tauri".to_string()), "src-tauri is a member: {members:?}");
        assert!(members.contains(&"crates/bsc-graph".to_string()), "{members:?}");
        // …and it is NOT under crates/, which is the whole point.
        assert!(
            !members.iter().any(|m| m == "crates/src-tauri"),
            "there is no crates/src-tauri — that path was the bug"
        );

        // A member is found by its last segment (what the tool's argument has always meant) and by its
        // full path (so `crates/data` can be typed literally).
        assert_eq!(member_dirs(&members, "src-tauri"), vec!["src-tauri".to_string()]);
        assert_eq!(member_dirs(&members, "data"), vec!["crates/data".to_string()]);
        assert_eq!(member_dirs(&members, "crates/data"), vec!["crates/data".to_string()]);
        assert!(member_dirs(&members, "not-a-crate").is_empty());
    }

    /// EVERY EXISTING `crates/<name>` TARGET RESOLVES EXACTLY AS BEFORE — proved over the real
    /// workspace, not asserted. 58 crates have already migrated through this path, and a resolution
    /// that moved even one of them would rename every record it writes.
    #[test]
    fn every_crates_member_still_resolves_to_the_path_the_old_derivation_hardcoded() {
        let root = repo();
        let manifest = std::fs::read_to_string(root.join("Cargo.toml")).expect("the workspace manifest");
        let mut checked = 0usize;
        for m in workspace_members(&manifest) {
            let Some(name) = m.strip_prefix("crates/") else { continue };
            assert_eq!(
                resolve_crate_dir(&root, name).unwrap_or_else(|e| panic!("{name}: {e}")),
                format!("crates/{name}"),
                "the old `root.join(\"crates\").join(krate)` answer must be preserved for {name}"
            );
            checked += 1;
        }
        assert!(checked > 60, "only {checked} crates/* members walked");
        // …and the one member that is NOT under crates/ resolves to itself rather than to a path that
        // does not exist. This is the assertion that goes red against the old derivation.
        assert_eq!(resolve_crate_dir(&root, "src-tauri").expect("src-tauri resolves"), "src-tauri");
    }

    /// A NAME THAT NAMES NOTHING, and one that names two things, are both errors that SAY SO.
    ///
    /// Picking a candidate by declaration order would be a coin flip, and this tool deletes source
    /// files — so ambiguity is reported rather than resolved.
    #[test]
    fn an_unknown_or_ambiguous_crate_name_is_a_named_error() {
        let err = resolve_crate_dir(&repo(), "definitely-not-a-crate").expect_err("unknown");
        assert!(err.contains("definitely-not-a-crate"), "names what was asked for: {err}");
        assert!(err.contains("Cargo.toml"), "says what it looked for: {err}");

        let members = ["crates/demo".to_string(), "vendor/demo".to_string()];
        assert_eq!(member_dirs(&members, "demo").len(), 2, "both members end in `demo`");
    }

    /// THE DEPTH TEST — a workspace member that is NOT under `crates/`, driven through the REAL `run`.
    ///
    /// This is the assertion that fails against the old code, and it fails in the most literal way
    /// possible: `root.join("crates").join(krate)` resolves to a directory that does not exist, so
    /// `crate_root` finds no `lib.rs` and the tool reports `crates/app-shell/src has neither lib.rs nor
    /// main.rs` — the verbatim message `bsc graph migrate-crate src-tauri` printed.
    ///
    /// It is deliberately a SCRATCH workspace rather than the real one, so the depth being tested is a
    /// property of the resolution rather than a property of this repo's layout: `app-shell` sits at
    /// depth 1 and `pkgs/inner` at depth 2 under a directory that is not called `crates`.
    #[test]
    fn a_workspace_member_outside_crates_is_resolved_and_dry_runs() {
        let root = std::env::temp_dir().join(format!("bsc-migrate-depth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("Cargo.toml"),
            "[workspace]\nmembers = [\"app-shell\", \"crates/demo\", \"pkgs/inner\"]\nresolver = \"2\"\n",
        )
        .unwrap();

        for (dir, krate) in [("app-shell", "app-shell"), ("crates/demo", "demo"), ("pkgs/inner", "inner")] {
            let src = root.join(dir).join("src");
            std::fs::create_dir_all(&src).unwrap();
            std::fs::write(
                root.join(dir).join("Cargo.toml"),
                format!("[package]\nname = \"{krate}\"\nedition = \"2021\"\n"),
            )
            .unwrap();
            std::fs::write(src.join("lib.rs"), "//! c\npub mod cli;\n").unwrap();
            std::fs::write(src.join("cli.rs"), "pub fn run() {}\n").unwrap();
        }

        // Depth 1 — the `src-tauri` shape.
        let mut out: Vec<u8> = Vec::new();
        run(&["app-shell".into(), "--root".into(), root.to_string_lossy().to_string()], &mut out)
            .expect("a member outside crates/ must resolve");
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("would migrate app-shell — 1 module(s)"), "{text}");
        // THE ID IS PREFIXED BY THE REAL DIRECTORY, with no `crates` segment invented and none dropped.
        assert!(text.contains("src/cli.rs  ->  record app-shell--cli.rs"), "{text}");
        assert!(text.contains("DRY RUN"), "{text}");

        // Depth 2 under a directory that is not `crates` — so the resolution is about the MANIFEST, not
        // about the word.
        let mut out: Vec<u8> = Vec::new();
        run(&["inner".into(), "--root".into(), root.to_string_lossy().to_string()], &mut out)
            .expect("depth 2 under pkgs/ resolves too");
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("src/cli.rs  ->  record pkgs--inner--cli.rs"), "{text}");

        // …and the ordinary case is untouched: `crates/demo` still yields `demo--cli.rs`, with the
        // `crates` segment dropped exactly as `extract::module_id` has always dropped it.
        let mut out: Vec<u8> = Vec::new();
        run(&["demo".into(), "--root".into(), root.to_string_lossy().to_string()], &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("src/cli.rs  ->  record demo--cli.rs"), "{text}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// THE `build =` KEY IS RELATIVE TO THE CRATE, so it is a fact about DEPTH rather than a constant.
    ///
    /// All 58 adopters sit at `crates/<name>` and must keep getting [`MARKER`] back byte-for-byte —
    /// that is the regression half. The other half is that a crate one level up needs a different path,
    /// and writing `MARKER` there would produce a manifest cargo cannot resolve.
    #[test]
    fn the_build_key_is_derived_from_the_crates_own_depth() {
        assert_eq!(marker_for("crates/plandb"), MARKER, "the 58 adopters are unchanged");
        assert_eq!(marker_for("crates/graph-materialize"), "build = \"build.rs\"");
        // From INSIDE `src-tauri/`, `..` pops to the repo root — so the shared script is one level up
        // and then back down, not a bare `crates/…`. Getting this backwards is exactly the silent
        // manifest cargo cannot resolve that `marker_for` exists to prevent.
        assert_eq!(marker_for("src-tauri"), "build = \"../crates/graph-materialize/build.rs\"");
        assert_eq!(marker_for("pkgs/a/b"), "build = \"../../../crates/graph-materialize/build.rs\"");

        // …and `opt_in` writes what it is given, still exactly once.
        let before = "[package]\nname = \"x\"\nedition = \"2021\"\n";
        let deep = marker_for("src-tauri");
        let once = opt_in(before, Route::Shared, &deep);
        assert_eq!(once.matches(&deep).count(), 1, "{once}");
        assert!(!once.contains(MARKER), "a depth-1 crate must NOT get the crates/<name> path: {once}");
        assert_eq!(opt_in(&once, Route::Shared, &deep), once, "opt_in is idempotent at any depth");
    }

    /// A BUILD SCRIPT THAT ALREADY CALLS THE MATERIALIZER IS NOT A COLLISION.
    ///
    /// The refusal exists because `opt_in` would SILENTLY REPLACE the crate's own script. That premise
    /// is false for a crate wired through the build-DEPENDENCY route — the one
    /// `graph-materialize-becomes-a-real-build-dependency` added so `src-tauri`, whose build script
    /// already does four other jobs, could materialize without giving any of them up.
    #[test]
    fn a_build_script_that_already_calls_the_materializer_is_not_refused() {
        let plain = "[package]\nedition = \"2021\"\n";
        let cli = vec![node(&["cli"], "cli.rs", Some("pub fn run() {}\n"))];

        let mut calls = shape(plain, &cli);
        calls.build_rs = Some(("src-tauri/build.rs", "fn main() {\n    tauri_build::build();\n    graph_materialize::emit_when_adopted();\n}\n"));
        assert!(refuse_reason(&calls, Route::Shared).is_none(), "the call-site route is already opted in");

        // …and one that does something ELSE still refuses, so the carve-out is exactly this case.
        let mut other = shape(plain, &cli);
        other.build_rs = Some(("src-tauri/build.rs", "fn main() {\n    tauri_build::build();\n}\n"));
        assert!(refuse_reason(&other, Route::Shared).is_some(), "a build script doing other work is still a collision");

        assert!(calls_materializer("graph_materialize::emit();"));
        assert!(!calls_materializer("// mentions graph-materialize in prose only"));

        // THE REAL FALSE POSITIVE, verbatim from the shared script's own module docs. A bare
        // `contains` matched this and quietly changed `crates/graph-materialize`'s refusal from its own
        // build script to "declares no modules" — caught by diffing all 70 crates, not by a test that
        // existed. It does now.
        let shared_docs = "//! a `[build-dependencies]` entry and calls as `graph_materialize::emit()` — runs this exact source\n\ninclude!(\"plan.rs\");\n\nfn main() {\n    emit();\n}\n";
        assert!(!calls_materializer(shared_docs), "a doc comment is not a call site");
        assert!(!calls_materializer("/*\n * graph_materialize::emit()\n */\nfn main() {}\n"), "nor a block comment");
        // …nor a STRING LITERAL, which a line-based comment strip would have missed. This is what
        // reusing `CodeMask` buys over the version this test was first written against.
        assert!(!calls_materializer("fn main() { let s = \"graph_materialize::emit()\"; }\n"), "nor a string");
        assert!(!calls_materializer("fn main() { let s = r#\"graph_materialize::emit()\"#; }\n"), "nor a raw string");

        // …and the REAL call site, verbatim from `src-tauri/build.rs`, still reads as one.
        let real = "//! runs the materializer as a fifth job\nfn main() {\n    tauri_build::build();\n    graph_materialize::emit_when_adopted();\n}\n";
        assert!(calls_materializer(real), "the src-tauri call site");
    }

    /// THE REFUSAL IS UNCHANGED — verdict, message and exit — and the dry run now shows its plan too.
    ///
    /// Splitting the verdict from the plan is the one behaviour change outside the resolution, so it is
    /// pinned rather than described. Driven over the two REAL crates the audit found refusing for their
    /// own build script (`data`, `bsc-config`), because a synthetic shape would not prove the message a
    /// caller actually sees is byte-identical.
    #[test]
    fn the_refusal_is_unchanged_and_the_dry_run_now_shows_its_plan_too() {
        let root = repo();
        // THE REFUSAL ARM MOVED TO A FIXTURE, and the reason is worth stating rather than hiding: this
        // test used to drive `data` and `bsc-config`, the two REAL crates the audit found refusing for
        // their own build script. `the-two-build-rs-crates-adopt-the-materializer-alongside-their-own`
        // migrated both, so **the repo now holds no crate in that state at all** — the population is
        // empty, and `the_two_build_rs_crates_reach_the_materializer_alongside_their_own` below asserts
        // that as a fact rather than leaving it as this test's silent absence.
        //
        // A synthetic crate is the honest replacement: the contract being pinned is the VERDICT, its
        // MESSAGE and its EXIT, and `run` reaches all three the same way whatever tree it is pointed at.
        let fixture = std::env::temp_dir().join(format!("bsc-migrate-refusal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&fixture);
        let src = fixture.join("crates").join("demo").join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("lib.rs"), "//! demo\npub mod cli;\n").unwrap();
        std::fs::write(src.join("cli.rs"), "pub fn run() {}\n").unwrap();
        std::fs::write(fixture.join("crates/demo/Cargo.toml"), "[package]\nname = \"demo\"\nedition = \"2021\"\n").unwrap();
        // `crates/data`'s script in shape: a WINDOWS-ONLY link directive, the one whose loss is
        // invisible on Linux. That asymmetry is why this refusal has to be reached up front.
        std::fs::write(
            fixture.join("crates/demo/build.rs"),
            "fn main() {\n    if std::env::var(\"CARGO_CFG_TARGET_OS\").as_deref() == Ok(\"windows\") {\n        println!(\"cargo:rustc-link-lib=dylib=rstrtmgr\");\n    }\n}\n",
        )
        .unwrap();

        let mut out: Vec<u8> = Vec::new();
        let err = run(&["demo".into(), "--root".into(), fixture.to_string_lossy().to_string()], &mut out)
            .expect_err("its own build.rs is still a refusal");
        // THE VERDICT, verbatim — this is what stderr and the exit code carry, and it must not move.
        assert!(err.starts_with("REFUSED demo: "), "{err}");
        assert!(err.contains("demo/build.rs already exists"), "{err}");
        assert!(err.contains("this crate gets exactly ONE build script"), "{err}");
        assert!(err.contains("cargo:rustc-link-lib"), "it names what would be lost: {err}");
        // …and the plan the reader was previously not shown.
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("would migrate demo"), "the plan is printed too: {text}");
        assert!(text.contains("DRY RUN — nothing was written"), "{text}");
        assert!(!text.contains("pass --apply to write"), "a refused crate is not invited to apply: {text}");

        // …and the SAME crate is accepted with `--alongside`, which is the way out the message names.
        let mut out: Vec<u8> = Vec::new();
        run(&["demo".into(), "--alongside".into(), "--root".into(), fixture.to_string_lossy().to_string()], &mut out)
            .expect("--alongside keeps that build script instead of replacing it");
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("route: ALONGSIDE"), "{text}");
        assert!(text.contains("crates/demo/build.rs is KEPT"), "{text}");
        let _ = std::fs::remove_dir_all(&fixture);

        // A crate with NOTHING in the way still reports exactly as it always did — the clean arm, so
        // this test cannot pass by making every dry run look refused.
        let mut out: Vec<u8> = Vec::new();
        run(&["bsc-json-store".into(), "--root".into(), root.to_string_lossy().to_string()], &mut out)
            .expect("bsc-json-store is clean");
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("would migrate bsc-json-store — 3 module(s):"), "{text}");
        assert!(text.contains("src/cli.rs  ->  record bsc-json-store--cli.rs"), "{text}");
        assert!(text.ends_with("DRY RUN — pass --apply to write.\n"), "byte-for-byte the old ending: {text}");
    }

    /// The mirror of the build-script refusal: `--alongside` is the route FOR a crate that already owns
    /// a build script, so the same shape that stops [`Route::Shared`] is its precondition.
    #[test]
    fn the_alongside_route_takes_exactly_the_crate_the_shared_route_refuses() {
        let plain = "[package]\nedition = \"2021\"\n";
        let cli = vec![node(&["cli"], "cli.rs", Some("pub fn run() {}\n"))];
        let windows_link = "fn main() {\n    if std::env::var(\"CARGO_CFG_TARGET_OS\").as_deref() == Ok(\"windows\") {\n        println!(\"cargo:rustc-link-lib=dylib=rstrtmgr\");\n    }\n}\n";

        let mut s = shape(plain, &cli);
        s.build_rs = Some(("crates/data/build.rs", windows_link));
        let why = refuse_reason(&s, Route::Shared).expect("the premise: Shared still refuses it");
        assert!(why.contains("--alongside"), "and the refusal NAMES the way out: {why}");
        assert_eq!(refuse_reason(&s, Route::Alongside), None, "…which takes it");

        // …and refuses the OPPOSITE crate, rather than quietly creating a build.rs where one manifest
        // line would have done. That direction matters: `--alongside` on a script-less crate adds a
        // FILE, which is the net-zero outcome the shared script exists to avoid.
        let why = refuse_reason(&shape(plain, &cli), Route::Alongside)
            .expect("--alongside needs a build script to add the call to");
        assert!(why.contains("no build.rs"), "{why}");

        // A build script that ALREADY calls the materializer is NOT refused on this route either — that
        // is `calls_materializer`'s carve-out, and it is the same answer here: the wiring half is done,
        // `add_emit_call` and `opt_in` are idempotent, and the modules still migrate. Refusing it would
        // block `--alongside` on `src-tauri`, the very crate the carve-out was written for.
        let mut again = shape(plain, &cli);
        again.build_rs = Some(("src-tauri/build.rs", "fn main() {\n    graph_materialize::emit_when_adopted();\n}\n"));
        assert_eq!(refuse_reason(&again, Route::Alongside), None, "already wired is not a redo, it is a no-op");

        // A DECLARED script at some other path: the write path edits `<crate_dir>/build.rs` by name, so
        // the call would land in a file cargo never runs. Refused, with the hand-edit spelled out.
        let elsewhere = "[package]\nedition = \"2021\"\nbuild = \"gen.rs\"\n";
        let mut odd = shape(elsewhere, &cli);
        odd.build_rs = Some(("crates/x/build.rs", "fn main() {}\n"));
        let why = refuse_reason(&odd, Route::Alongside).expect("a build key elsewhere must refuse");
        assert!(why.contains("gen.rs") && why.contains(CALL), "{why}");

        // …but `build = "build.rs"` spelled out explicitly is the same file, and is fine.
        let explicit = "[package]\nedition = \"2021\"\nbuild = \"build.rs\"\n";
        let mut same = shape(explicit, &cli);
        same.build_rs = Some(("crates/x/build.rs", "fn main() {}\n"));
        assert_eq!(refuse_reason(&same, Route::Alongside), None);
    }

    /// The two routes wire DIFFERENT dependencies, and swapping them is silently wrong rather than a
    /// compile error: the shared script parses the store itself (`serde_json`), while a crate that CALLS
    /// the materializer needs the package and never touches JSON.
    #[test]
    fn opt_in_wires_the_dependency_the_route_actually_needs() {
        let before = "[package]\nname = \"demo\"\nedition = \"2021\"\n\n[dependencies]\nserde_json = \"1\"\n";

        let along = opt_in(before, Route::Alongside, DEP);
        assert!(along.contains(DEP), "{along}");
        assert!(!along.contains(MARKER), "--alongside must NOT add a build key: {along}");
        assert_eq!(along.matches("[build-dependencies]").count(), 1, "{along}");
        // Idempotent — and note the crate already has `serde_json` in `[dependencies]`, which is why the
        // "is it already there" question is asked of the SECTION and not of the whole file.
        let twice = opt_in(&along, Route::Alongside, DEP);
        assert_eq!(twice.matches(DEP).count(), 1, "{twice}");
        assert_eq!(twice.matches("[build-dependencies]").count(), 1, "{twice}");

        // An EXISTING `[build-dependencies]` gains a LINE, never a second header — two tables of one
        // name is a hard cargo error, and it would land after the records were written. `src-tauri` is
        // exactly this shape: it already declares `tauri-build` there.
        let has = "[package]\nname = \"demo\"\nedition = \"2021\"\n\n[build-dependencies]\ntauri-build = \"2\"\n";
        let out = opt_in(has, Route::Alongside, DEP);
        assert_eq!(out.matches("[build-dependencies]").count(), 1, "{out}");
        assert!(out.contains(DEP) && out.contains("tauri-build"), "{out}");

        // DEPTH, the same fact `marker_for` carries: `src-tauri` reaches the package one level up, and
        // writing the `crates/<name>` form there is a manifest cargo cannot resolve.
        assert_eq!(dep_for("crates/data"), DEP, "the depth-1 form is the constant");
        assert_eq!(dep_for("src-tauri"), "graph-materialize = { path = \"../crates/graph-materialize\" }");
        assert_eq!(dep_for("pkgs/a/b"), "graph-materialize = { path = \"../../../crates/graph-materialize\" }");
        let deep = dep_for("src-tauri");
        let out = opt_in("[package]\nname = \"x\"\nedition = \"2021\"\n", Route::Alongside, &deep);
        assert!(out.contains(&deep) && !out.contains(DEP), "a depth-1 path must not be written there: {out}");
    }

    /// The call goes in as the FIRST statement of `main`, because finding the LAST one means matching
    /// braces and a build script here is full of `{}` inside format strings — `bsc-config`'s own has
    /// `"could not create the staged config seed at {}: {e}"`. A brace count closes `main` inside that
    /// literal and splices the call into the middle of a string.
    #[test]
    fn the_emit_call_is_added_to_main_and_survives_braces_in_string_literals() {
        let bracey = "use std::fs;\n\nfn main() {\n    let d = \"x\";\n    panic!(\"could not stage {}: {e}\", d);\n}\n";
        let out = add_emit_call(bracey).expect("a build script with a main");
        assert!(out.contains(CALL), "{out}");
        assert!(out.contains("panic!(\"could not stage {}: {e}\", d);"), "the literal is untouched: {out}");
        let at_call = out.find(CALL).unwrap();
        assert!(at_call > out.find("fn main() {").unwrap(), "{out}");
        assert!(at_call < out.find("let d = ").unwrap(), "{out}");

        // Idempotent, so a re-run cannot emit twice — and it asks `calls_materializer`, not a bare
        // `contains`, so a build script whose DOC COMMENT names the call is still wired by this.
        assert_eq!(add_emit_call(&out).unwrap().matches(CALL).count(), 1);
        let doc_only = "//! calls `graph_materialize::emit()` as a fifth job\nfn main() {}\n";
        assert!(add_emit_call(doc_only).unwrap().contains(CALL), "prose is not a call: {doc_only}");

        // …and it REFUSES rather than appending to nothing.
        assert!(add_emit_call("// no main here\n").is_err());
    }

    /// THE POPULATION, against the real tree — and it is what
    /// `the_refusal_is_unchanged_and_the_dry_run_now_shows_its_plan_too` points at when it explains why
    /// its refusal arm is a fixture now.
    ///
    /// `crates/data` is the crate this whole route exists for: its `build.rs` emits
    /// `cargo:rustc-link-lib=dylib=rstrtmgr` on Windows ONLY, so replacing it is invisible on every
    /// machine that could test it and breaks the Windows link. `crates/bsc-config` stages
    /// `$OUT_DIR/config-seed` for an `include_dir!`. Both keep their script AND materialize.
    #[test]
    fn the_two_build_rs_crates_reach_the_materializer_alongside_their_own() {
        let root = repo();
        for krate in ["data", "bsc-config"] {
            let dir = root.join("crates").join(krate);
            let build = std::fs::read_to_string(dir.join("build.rs"))
                .unwrap_or_else(|e| panic!("crates/{krate}/build.rs is the premise of this test: {e}"));
            let cargo = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();

            assert!(calls_materializer(&build), "crates/{krate}/build.rs must CALL the materializer");
            assert!(cargo.contains(DEP), "…and take it as a build-dependency: {cargo}");
            assert!(!cargo.contains(MARKER), "…and NOT point `build =` at the shared script: {cargo}");
            assert!(
                declared_build_script(&cargo).is_none(),
                "crates/{krate} still declares no `build =` — cargo AUTO-DETECTS build.rs, which is what \
                 makes a replacement silent and is why this route exists"
            );
            // The crate root is a file holding the `include!`, and nothing else of its source is.
            let lib = std::fs::read_to_string(dir.join("src").join("lib.rs")).unwrap();
            assert!(lib.contains(r#"include!(concat!(env!("OUT_DIR"), "/crate.rs"));"#), "{krate}");
            let rs = std::fs::read_dir(dir.join("src")).unwrap().flatten().count();
            assert_eq!(rs, 1, "crates/{krate}/src holds only lib.rs");
        }

        // `crates/data`'s directive, ASSERTED HERE TOO rather than only in that crate's own tests.
        // Nothing on a non-Windows box can exercise it, so the guard has to be textual — and having it
        // in the migration tool as well is deliberate: this is the tool that would have destroyed it.
        let build = std::fs::read_to_string(root.join("crates/data/build.rs")).unwrap();
        assert!(build.contains(r#"println!("cargo:rustc-link-lib=dylib=rstrtmgr");"#), "{build}");
        assert!(build.contains(r#"std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")"#), "{build}");

        // AND THE POPULATION IS EXHAUSTIVE. No crate under `crates/` owns a build script that does NOT
        // call the materializer any more, which is precisely why the refusal above needs a fixture.
        let unwired: Vec<String> = std::fs::read_dir(root.join("crates"))
            .unwrap()
            .flatten()
            .filter_map(|e| {
                let src = std::fs::read_to_string(e.path().join("build.rs")).ok()?;
                // `crates/graph-materialize`'s own build.rs IS the shared script — it calls the local
                // `emit()`, not `graph_materialize::emit()`, and materializes nothing of its own.
                let name = e.file_name().to_string_lossy().into_owned();
                (name != "graph-materialize" && !calls_materializer(&src)).then_some(name)
            })
            .collect();
        assert!(
            unwired.is_empty(),
            "a crate owns an un-wired build script again ({unwired:?}) — the refusal arm of \
             `the_refusal_is_unchanged_and_the_dry_run_now_shows_its_plan_too` could drive it for real"
        );
    }

    /// THE GATE THIS FIX OWES, over the REAL workspace: no crate holds a `mod` declaration the parser
    /// cannot read.
    ///
    /// The invariant is not "`pub(crate)` works now" — it is that a declaration this tool cannot read is
    /// never SILENT. The fix repaired one instance; this is what stops the next, because the next one
    /// will be spelled some way nobody has thought of and the only thing that generalizes is the
    /// refusal. Reading it off the real tree rather than a fixture matters: `bsc-graph`'s own `cli.rs`
    /// is a directory module holding `pub mod cli;` fixture strings, which is exactly the false positive
    /// that would make this gate unusable and be quietly demoted.
    ///
    /// SCOPED to the files the tool actually READS — the crate roots and the directory-module sources
    /// the walk reaches — not every `.rs` in the repo, because a leaf module's source is never parsed
    /// for declarations and scanning it would report fixtures nothing acts on.
    #[test]
    fn no_workspace_crate_holds_a_mod_declaration_this_parser_cannot_read() {
        let root = repo();
        let manifest = std::fs::read_to_string(root.join("Cargo.toml")).expect("the workspace manifest");
        let members = workspace_members(&manifest);
        assert!(members.len() >= 60, "only {} members — the member list is not being read", members.len());

        let mut walked = 0usize;
        let mut decls = 0usize;
        let mut restricted = 0usize;
        let mut bad: Vec<String> = Vec::new();
        for m in &members {
            let src = root.join(m).join("src");
            let Some(root_name) = ["lib.rs", "main.rs"].into_iter().find(|f| src.join(f).is_file()) else {
                continue;
            };
            let Ok(root_src) = std::fs::read_to_string(src.join(root_name)) else { continue };
            let walk = module_walk(&src, &root_src, root_name);
            walked += 1;
            decls += walk.nodes.len();
            restricted += walk.nodes.iter().filter(|n| n.decl.vis.starts_with("pub(")).count();
            bad.extend(walk.unreadable.into_iter().map(|l| format!("{m}: {l}")));
        }
        assert!(
            bad.is_empty(),
            "a `mod` declaration in this workspace cannot be read, so its crate's plan would be short: \
             {bad:?}"
        );
        // POPULATION, because a walk that stopped finding anything would satisfy the assertion above in
        // silence — which is the failure mode this whole item is about.
        assert!(walked >= 60, "only {walked} crates walked");
        assert!(decls >= 150, "only {decls} declarations read across the workspace");
        // MEASURED 2026-09-04: 175 declarations across 71 walked crates, 16 of them file-backed `pub(crate) mod` — 13 in `src-tauri`, 3 in
        // `bsc-component`. A floor rather than an equality so an ordinary backend change does not
        // redden it, but a parser that stopped reading the form goes to 0 and fails here.
        assert!(restricted >= 16, "only {restricted} restricted-visibility modules — the parser regressed");
    }

    /// The OTHER crate the gap stranded, against the real tree. `bsc-component` is already migrated, so
    /// `--apply` still refuses it — but the DRY RUN's plan went from 0 modules to its three
    /// `pub(crate)` ones, which is why that crate ends at four files instead of one.
    #[test]
    fn bsc_component_no_longer_strands_its_three_pub_crate_modules() {
        let root = repo();
        let mut out: Vec<u8> = Vec::new();
        let why = run(&["bsc-component".into(), "--root".into(), root.to_string_lossy().to_string()], &mut out)
            .expect_err("an already-migrated crate is still refused");
        let text = String::from_utf8(out).unwrap();
        assert!(why.contains("already migrated"), "the verdict is unchanged: {why}");
        assert!(text.contains("would migrate bsc-component — 3 module(s):"), "{text}");
        for m in ["closure", "import-symbols", "usage-sources"] {
            assert!(text.contains(&format!("record bsc-component--{m}.rs")), "{m} is planned: {text}");
        }
    }

    /// THE DELIVERABLE, against the REAL tree: `bsc graph migrate-crate src-tauri` is a real DRY RUN.
    ///
    /// The shape is checked rather than a golden list — 137 nested modules would make this test a second
    /// copy of the directory tree, and it would go red for every legitimate backend change. What is
    /// pinned is what the item promised: the direct children, the depth-2 population, `mod.rs` mapping
    /// to its DIRECTORY, and the two crate roots staying files.
    ///
    /// AND THAT IT WRITES NOTHING. A dry run of a 55,843-line crate that quietly touched the store or
    /// the manifest would be the worst possible outcome of this change, so the manifest bytes and a
    /// sample of the source files are compared before and after.
    #[test]
    fn the_real_src_tauri_dry_runs_and_writes_nothing() {
        let root = repo();
        let manifest_path = root.join("src-tauri").join("Cargo.toml");
        let lib_path = root.join("src-tauri").join("src").join("lib.rs");
        let deep_path = root.join("src-tauri").join("src").join("console").join("pty").join("mod.rs");
        let before: Vec<Vec<u8>> = [&manifest_path, &lib_path, &deep_path]
            .iter()
            .map(|p| std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())))
            .collect();

        let mut out: Vec<u8> = Vec::new();
        // The crate RESOLVES and is PLANNED. `--apply` would still refuse it, for a reason that has
        // nothing to do with where the directory is: three of its modules (`console/pty/launch.rs`,
        // `console/pty/pump.rs`, `tests.rs`) `include_str!` their OWN source, which a record cannot do
        // because the file is the thing being retired. That is a real blocker and out of scope here —
        // this item's deliverable is that the tool can TARGET src-tauri, and the plan below is that.
        let verdict = run(&["src-tauri".into(), "--root".into(), root.to_string_lossy().to_string()], &mut out);
        let text = String::from_utf8(out).unwrap();

        assert!(text.contains("would migrate src-tauri"), "{text}");
        assert!(text.contains("DRY RUN — nothing was written"), "{text}");
        let why = verdict.expect_err("the self-reads still refuse --apply");
        assert!(why.contains("include_str!"), "the blocker is the self-read, not the layout: {why}");
        assert!(
            !why.contains("has neither lib.rs nor main.rs"),
            "the DIRECTORY must resolve — that failure is what this item removed: {why}"
        );

        let planned: Vec<&str> = text
            .lines()
            .filter_map(|l| l.trim().strip_prefix("src/"))
            .filter_map(|l| l.split("  ->  ").next())
            .collect();
        // MEASURED 2026-09-04 against the real tree, by diffing this plan against every `.rs` file
        // under `src-tauri/src`: 142 files, 136 planned, 6 not — and each of the 6 is accounted for
        // below rather than left as a remainder.
        //
        // It was 123 of 142 until `parse_mod_line` learned to read a restricted visibility. The
        // thirteen it gained are not a tidy-up: four of them are the whole `planner` subtree, whose
        // `mod.rs` declares every child `pub(crate) mod`.
        let direct = planned.iter().filter(|f| !f.contains('/')).count();
        let deep = planned.iter().filter(|f| f.contains('/')).count();
        let mod_rs = planned.iter().filter(|f| f.ends_with("mod.rs")).count();
        assert_eq!(planned.len(), 136, "every module of src-tauri, at every depth: {}", planned.len());
        assert_eq!(direct, 2, "`prelude.rs` and `testutil.rs` are the direct children: {planned:?}");
        assert!(
            planned.contains(&"planner/prompts.rs") && planned.contains(&"testutil.rs"),
            "a `pub(crate) mod` declaration is planned like any other: {planned:?}"
        );
        assert!(deep > 100, "only {deep} modules at depth >= 2 — the body this change exists for");
        assert_eq!(mod_rs, 24, "the 24 directory modules");

        // WHAT THE PLAN DOES NOT NAME, and why — because "123 of 142" is the kind of shortfall this
        // repo keeps shipping green. Every file under `src-tauri/src` is either planned or in one of
        // these four buckets; the assertion is that the buckets are EXHAUSTIVE.
        let all: Vec<String> = super::materialize_plan_tests::rs_files(&root.join("src-tauri").join("src"), "");
        let missing: Vec<&String> = all.iter().filter(|f| !planned.contains(&f.as_str())).collect();
        let roots = ["lib.rs", "main.rs"];
        // `mod tests` is never migrated — an inline-or-file test module has nothing to lift.
        let test_mods = ["tests.rs", "console/shell_rc/tests.rs", "mobile/tunnel/tests.rs"];
        // Declared by NOTHING, so not a module of this crate at all — the same verdict rustc reaches.
        let orphans = ["mobile/push.rs"];
        // …AND THE BUCKET THAT WAS A TOOL GAP RATHER THAN A DECISION, now EMPTY. It held the 13
        // `pub(crate) mod` declarations `parse_mod_line` could not read, pinned here by the branch that
        // found them so that fixing the parser would turn this assertion red rather than let the count
        // and the comment rot. It did, and this is the other half of that agreement.
        //
        // It stays as an EMPTY list rather than being deleted: the assertion below is that the buckets
        // are EXHAUSTIVE, and a named empty bucket says the gap was closed where a missing one would
        // just look like it never existed.
        let restricted_vis: [&str; 0] = [];
        let unexplained: Vec<&&String> = missing
            .iter()
            .filter(|f| {
                let f = f.as_str();
                !roots.contains(&f) && !test_mods.contains(&f) && !orphans.contains(&f)
                    && !restricted_vis.contains(&f)
            })
            .collect();
        assert!(unexplained.is_empty(), "a file is neither planned nor explained: {unexplained:?}");
        assert_eq!(
            missing.len(),
            roots.len() + test_mods.len() + orphans.len() + restricted_vis.len(),
            "every bucket must still describe a REAL file — a stale name here would hide a new gap"
        );
        assert_eq!(restricted_vis.len(), 0, "the `pub(crate) mod` hole is closed, not merely smaller");
        assert_eq!(missing.len(), 6, "only the roots, the `mod tests` and the orphan are unplanned: {missing:?}");
        // A CRATE ROOT IS NEVER A MODULE. Migrating `lib.rs` would delete the file the `include!` lands
        // in, which is not a recoverable state.
        assert!(!planned.contains(&"lib.rs"), "lib.rs is a crate root: {planned:?}");
        assert!(!planned.contains(&"main.rs"), "main.rs is a crate root: {planned:?}");

        // The ids are prefixed by the REAL directory — no `crates` segment invented.
        assert!(text.contains("record src-tauri--prelude.rs"), "{text}");
        assert!(!text.contains("crates--src-tauri"), "no invented crates segment: {text}");
        // A depth-3 path and a `mod.rs`, named explicitly so a walk that flattened either goes red.
        assert!(
            text.contains("src/console/pty/mod.rs  ->  record src-tauri--console--pty--mod.rs"),
            "the mod.rs shape at depth 3: {text}"
        );
        assert!(
            text.contains("src/mobile/tunnel/transport.rs  ->  record src-tauri--mobile--tunnel--transport.rs"),
            "a depth-3 leaf: {text}"
        );

        // NOTHING WAS WRITTEN.
        let after: Vec<Vec<u8>> = [&manifest_path, &lib_path, &deep_path]
            .iter()
            .map(|p| std::fs::read(p).expect("still there"))
            .collect();
        assert_eq!(before, after, "a dry run must not touch a single byte of src-tauri");
    }
}

/// The PLANNING CORE of the materializer, reached as a real dependency.
///
/// `crates/graph-materialize` used to be a bare `build.rs` (plus a `plan.rs`) that 54 crates pointed
/// their `build =` key at, and not a package at all — so it had no test target and this module had to
/// `include!("../../graph-materialize/plan.rs")` to assert anything about it.
/// `graph-materialize-becomes-a-real-build-dependency` made it a package, so the `include!` is gone and
/// these tests drive the SHIPPED symbols. The reason the coupling exists at all is unchanged: the id
/// derivation the build selects on has to equal the one `migrate-crate` names what it writes with, and
/// a restatement of either would drift invisibly.
#[cfg(test)]
mod materialize_plan_tests {
    use graph_materialize::{expected_id, module_path, render, Unit, PREAMBLE};
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
            "crates/plandb/src/",
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
            "crates/bsc-news/src/",
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
            "crates/k/src/",
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
            "crates/plandb/src/",
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
            "crates/k/src/",
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
            "crates/k/src/",
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
        let root = repo();
        let mut check = |krate: &str, file: &str| {
            let full = format!("crates/{krate}/src/{file}");
            assert_eq!(
                expected_id(krate, file),
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
        };
        // The modules still on disk…
        let mut on_disk: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(root.join("crates")).expect("crates/") {
            let dir = entry.expect("entry").path();
            let Some(krate) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
            let src = dir.join("src");
            if !src.is_dir() {
                continue;
            }
            for file in rs_files(&src, "") {
                on_disk.insert(format!("crates/{krate}/src/{file}"));
                check(&krate, &file);
            }
        }
        // …AND the ones that are no longer files. A migrated crate's modules live in the committed
        // store, and the id join this test guards is exactly what selects them at build time — so
        // walking only the disk would quietly shrink the population every time a crate migrates,
        // and would stop checking the ids that matter MOST, the ones a build.rs actually resolves.
        // (`bsc-news` and `research` moved 13 nested modules and 3 `mod.rs` off disk in one commit,
        // which is what first took this walk under its own floors.)
        let store = crate::repo_store::read_at(&crate::repo_store::path_under(&root))
            .expect("the committed store parses")
            .expect("the committed store exists");
        let impls = store.get("implementations").and_then(|v| v.as_array()).expect("implementations");
        for i in impls {
            let Some(src) = i.get("src").and_then(|v| v.as_str()) else { continue };
            if on_disk.contains(src) {
                continue; // a record whose file also exists — counted once, above
            }
            let Some(rest) = src.strip_prefix("crates/") else { continue };
            let Some((krate, file)) = rest.split_once("/src/") else { continue };
            if !file.ends_with(".rs") || file == "lib.rs" || file == "main.rs" {
                continue;
            }
            check(krate, file);
        }
        // POPULATION, so a walker that silently stopped matching fails loudly rather than passing over
        // nothing. Measured 2026-09-04: 216 modules, 30 nested, 4 mod.rs — counted across BOTH homes,
        // so migrating a crate MOVES a module between them rather than deleting it from the census.
        assert!(checked > 120, "the walk found only {checked} modules under crates/*/src");
        assert!(nested >= 20, "only {nested} nested modules — the case this change exists for");
        assert!(mod_rs >= 4, "only {mod_rs} mod.rs modules");
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

    /// …AND THE THIRD PARTY TO THAT AGREEMENT: what `migrate-crate` would actually NAME.
    ///
    /// The two tests above pin `expected_id` against `extract::module_id` over paths read off the disk.
    /// Neither runs `ModuleNode::record_id`, which is the id the DRY RUN prints and the apply path
    /// expects the harvest to return — so both stayed green while `record_id` pasted the crate name into
    /// `crates/{}` and produced `crates--src-tauri--…` for every one of these files. This walks the real
    /// `module_tree` of `src-tauri` (the declarations, not a `read_dir`) and demands all three agree.
    ///
    /// `migrate-crate-can-target-a-crate-outside-the-crates-directory` is where that third party joined:
    /// before it, `record_id` could not be asked this question at all, because the crate could not be
    /// resolved far enough to build a tree.
    #[test]
    fn record_id_agrees_with_both_derivations_for_every_src_tauri_module() {
        let root = repo();
        let crate_dir = crate::migrate::resolve_crate_dir(&root, "src-tauri").expect("src-tauri resolves");
        assert_eq!(crate_dir, "src-tauri", "the derivation under test");
        let src = root.join(&crate_dir).join("src");
        let lib = std::fs::read_to_string(crate::migrate::crate_root(&src).expect("a crate root")).expect("lib.rs");

        let nodes = crate::migrate::module_tree(&src, &lib);
        let mut mod_rs = 0usize;
        let mut deep = 0usize;
        for n in &nodes {
            let got = n.record_id(&crate_dir);
            assert_eq!(got, expected_id(&crate_dir, &n.file), "record_id vs the build's selection: {}", n.file);
            assert_eq!(
                got,
                crate::extract::module_id(&format!("{crate_dir}/src/{}", n.file), "rs"),
                "record_id vs what `bsc graph emit` calls a whole module: {}",
                n.file
            );
            // The bug this replaces, named so it cannot come back quietly.
            assert!(got.starts_with("src-tauri--"), "no invented `crates` segment: {got}");
            if n.file.ends_with("mod.rs") {
                mod_rs += 1;
            }
            if n.file.contains('/') {
                deep += 1;
            }
        }
        // POPULATION — a walk that stopped matching would otherwise pass over nothing.
        assert!(nodes.len() > 100, "the tree found only {} modules of src-tauri", nodes.len());
        assert!(deep > 100, "only {deep} nested modules");
        assert!(mod_rs >= 20, "only {mod_rs} mod.rs modules");
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
            let prefix = format!("crates/{krate}/src/");
            crates += 1;


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
                let got = render(units, &krate, &prefix, PREAMBLE)
                    .unwrap_or_else(|e| panic!("crates/{krate}: {e}"));
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

            // …and the same crate through the SHIPPED selection, reached as a dependency rather than
            // reproduced here. `graph-materialize` is a package now
            // (`graph-materialize-becomes-a-real-build-dependency`), so this side of the comparison is
            // the code the build actually runs; before, it was a restatement that could drift from it
            // in exactly the direction this test exists to rule out.
            let plan = graph_materialize::plan_for(&dir, Some(&root)).unwrap_or_else(|e| panic!("{e}"));
            assert_eq!(plan.src_prefix, prefix, "the derived prefix must equal the one hard-coded before");
            let units: Vec<Unit> = plan.select(impls);
            let got = render(units, &krate, &prefix, PREAMBLE).unwrap_or_else(|e| panic!("crates/{krate}: {e}"));
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

    /// THE ROUND TRIP, PROVED BY RENDERING rather than asserted: a `pub(crate) mod x;` declaration
    /// materializes as `pub(crate) mod x { … }`.
    ///
    /// Every link is the SHIPPED one. The declaration is read by `module_decls`, the `--module-vis`
    /// value is the one `impl_set_argv` actually sends, the record is a store on disk, and the output
    /// comes from `graph_materialize::Plan::render_store` — the code the build runs. A test that
    /// asserted `decl.vis == "pub(crate)"` would have passed just as happily with an emit side that
    /// dropped the restriction on the floor, and dropping it is not a formatting difference: it widens
    /// what the crate exports.
    ///
    /// The private and `pub` arms ride along so the change is proved to be an ADDITION — the two
    /// visibilities that already worked must render exactly as they did.
    #[test]
    fn a_restricted_visibility_materializes_as_the_declaration_it_came_from() {
        let dir = std::env::temp_dir().join(format!("bsc-vis-render-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("graph")).expect("temp repo");
        std::fs::create_dir_all(dir.join("crates").join("demo").join("src")).expect("temp crate");
        std::fs::write(dir.join("crates/demo/Cargo.toml"), "[package]\nname = \"demo\"\n").expect("manifest");

        // The declarations, read by the real parser…
        let decls = super::module_decls("pub(crate) mod hidden;\npub mod open;\nmod shut;\n");
        assert_eq!(decls.len(), 3, "the parser reads all three: {decls:?}");

        // …turned into records carrying the `--module-vis` value the migration actually sends.
        let impls: Vec<serde_json::Value> = decls
            .iter()
            .map(|d| {
                let mut n = super::ModuleNode {
                    path: vec![d.name.clone()],
                    file: format!("{}.rs", d.name),
                    decl: d.clone(),
                    children: vec![],
                    source: None,
                };
                n.decl = d.clone();
                let argv = super::impl_set_argv(&format!("demo--{}.rs", d.name), &n);
                let at = argv.iter().position(|a| a == "--module-vis").expect("sent");
                serde_json::json!({
                    "id": format!("demo--{}.rs", d.name),
                    "src": format!("crates/demo/src/{}.rs", d.name),
                    "code": format!("pub fn {}() {{}}", d.name),
                    "moduleVis": argv[at + 1].clone(),
                })
            })
            .collect();
        std::fs::write(
            dir.join("graph/algorithms.json"),
            serde_json::to_string(&serde_json::json!({ "implementations": impls })).expect("json"),
        )
        .expect("store");

        let plan = graph_materialize::plan_for(&dir.join("crates/demo"), None).expect("the temp repo resolves");
        let raw = std::fs::read_to_string(&plan.store_path).expect("store reads");
        let out = plan
            .render_store(&raw, graph_materialize::Adoption::Required)
            .expect("renders")
            .expect("three records is not nothing");
        let _ = std::fs::remove_dir_all(&dir);

        assert!(out.contains("pub(crate) mod hidden {\n"), "the restriction SURVIVES materialization:\n{out}");
        assert!(out.contains("\npub mod open {\n"), "`pub` is unchanged:\n{out}");
        assert!(out.contains("\nmod shut {\n"), "a private module is still a bare `mod`:\n{out}");
        assert!(!out.contains("pub mod hidden"), "and is NOT widened to `pub`:\n{out}");
    }

    /// Every `.rs` under `dir`, as a path relative to it, skipping dot-directories.
    pub(super) fn rs_files(dir: &Path, prefix: &str) -> Vec<String> {
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
