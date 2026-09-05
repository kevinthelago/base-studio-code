//! `bsc-files` core — gitignore-aware folder/tree structure with file **metrics**, plus single-path
//! `stat`. Pure logic (no CLI, no Tauri) so it's unit-testable and reusable; the binary in
//! `src/bin/bsc-files.rs` is a thin arg-parsing shell over this.
//!
//! Design notes:
//! - The walk uses the `ignore` crate, so `.gitignore`/`.ignore` are respected and `node_modules`,
//!   `target`, `dist`, hidden dirs, and `.git` fall out for free (with `--all` to override). Symlinks
//!   are never followed (closes the junction-traversal hazard the app's own walker guards, #1650).
//! - A directory node's `size`/`files` are the **aggregate** of everything under it, computed
//!   bottom-up — so `tree --depth 1` still reports accurate totals for collapsed subtrees.
//!
//! The agent-facing CLI lives in [`cli`] (`bsc files …`), dispatched by the unified `bsc` binary
//! (#1877) and by the legacy `bsc-files` shim.


use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

/// Whether a node is a directory or a file (serialized lowercase as the JSON `"type"`).
#[derive(Serialize, PartialEq, Eq, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Dir,
    File,
}

/// One node in the folder tree. For a file, `size` is its byte length and `files` is 1; for a
/// directory, both are the aggregate over its subtree. `lines`/`lang` are file-only and optional.
#[derive(Serialize, Debug)]
pub struct Node {
    pub name: String,
    /// Path relative to the tree root, forward-slash normalized ("" for the root itself).
    pub path: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    /// Bytes — own size for a file, aggregate for a directory.
    pub size: u64,
    /// File count — 1 for a file, aggregate for a directory.
    pub files: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}

impl Node {
    fn dir(name: String, path: String) -> Node {
        Node { name, path, kind: Kind::Dir, size: 0, files: 0, lines: None, lang: None, children: Vec::new() }
    }
}

/// Single-path metrics (the `stat` command).
#[derive(Serialize, Debug)]
pub struct FileStat {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// Last-modified time as a Unix epoch (seconds), when the platform reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_epoch: Option<u64>,
}

impl FileStat {
    /// Human one-liner: `<type>  <size>  <lang>[, <n> lines]`.
    pub fn lean(&self) -> String {
        let mut s = format!("{}  {}", if self.kind == Kind::Dir { "dir" } else { "file" }, human_size(self.size));
        if let Some(l) = &self.lang {
            s.push_str(&format!("  {l}"));
        }
        if let Some(n) = self.lines {
            s.push_str(&format!(", {n} lines"));
        }
        s
    }
}

/// One `path:line` reference hit (the `refs` command). `text` is the trimmed source line for context
/// (omitted from JSON when empty — e.g. a file-level entry that carries no single line).
#[derive(Serialize, Debug, Clone)]
pub struct Hit {
    pub path: String,
    pub line: usize,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
}

/// Files sharing the queried file's basename — the "probably dies with it" set. Test files
/// (`*.test.*` / `*.spec.*`) are split out as their own sub-group.
#[derive(Serialize, Debug, Default)]
pub struct Siblings {
    pub files: Vec<String>,
    pub tests: Vec<String>,
}

/// The grouped cross-file impact/delete map for one file (the `refs` command). All groups are
/// **heuristic/textual** (regex-free scans over the gitignore-aware tree) and may over-report — the
/// safe bias for a deletion-impact tool.
#[derive(Serialize, Debug, Default)]
pub struct Refs {
    /// The queried file, relative to the root (forward-slash normalized).
    pub path: String,
    /// The narrowing symbol, when one was given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// Same-basename sibling files (`Foo.css`, `Foo.module.css`, `Foo.test.tsx`, …).
    pub siblings: Siblings,
    /// Files importing this module (or, when narrowed, the named symbol) → the import line.
    pub importers: Vec<Hit>,
    /// Every occurrence of the symbol across the tree → each line (only when a symbol is given).
    pub symbol_usages: Vec<Hit>,
    /// CSS class links, both directions: classes the component references → their `.css`/`.scss`
    /// definitions, and classes defined in the component's own stylesheet → where they're used.
    pub style_links: Vec<Hit>,
}

/// What to include when walking (mirrors the CLI flags).
#[derive(Default, Clone, Copy)]
pub struct TreeOpts {
    /// Include gitignored + hidden entries (the `ignore` filters are turned off).
    pub include_all: bool,
    /// Include dotfiles/dot-dirs but still honor .gitignore.
    pub include_hidden: bool,
    /// Compute per-file line counts (reads each text file — slower).
    pub count_lines: bool,
}

/// Format a byte count as a short human string (`512 B`, `1.4 KB`, `3.2 MB`, …). Binary units.
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut f = bytes as f64;
    let mut i = 0;
    while f >= 1024.0 && i < UNITS.len() - 1 {
        f /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} B")
    } else {
        format!("{f:.1} {}", UNITS[i])
    }
}

/// The language label for a path by extension, or None for an unrecognized/extensionless file.
pub fn lang_for(path: &str) -> Option<String> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    let lang = match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "json" => "json",
        "md" | "markdown" => "markdown",
        "toml" => "toml",
        "css" => "css",
        "scss" | "sass" => "scss",
        "html" | "htm" => "html",
        "py" => "python",
        "sh" | "bash" => "shell",
        "yml" | "yaml" => "yaml",
        "sql" => "sql",
        "go" => "go",
        _ => return None,
    };
    Some(lang.to_string())
}

/// Line count of a UTF-8 text file; None for a binary/unreadable file (so it's simply omitted).
fn count_lines_of(path: &Path) -> Option<u64> {
    std::fs::read_to_string(path).ok().map(|s| s.lines().count() as u64)
}

/// Build the folder tree under `root` with per-file metrics and bottom-up directory aggregates.
/// Honors `opts` (gitignore/hidden/line-counts). Errors only if `root` can't be walked at all.
pub fn build_tree(root: &Path, opts: &TreeOpts) -> Result<Node, String> {
    let root_name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let mut tree = Node::dir(root_name, String::new());

    let walker = ignore::WalkBuilder::new(root)
        .hidden(!(opts.include_hidden || opts.include_all)) // skip dotfiles unless asked
        .git_ignore(!opts.include_all)
        .git_global(!opts.include_all)
        .git_exclude(!opts.include_all)
        .ignore(!opts.include_all)
        .parents(!opts.include_all)
        // Honor .gitignore even when the dir isn't a git repo (a sub-worktree, or a standalone run on
        // a non-git folder) — otherwise the `ignore` crate only applies it inside a `.git` repo.
        .require_git(false)
        .follow_links(false)
        .build();

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue, // an unreadable entry is skipped, not fatal
        };
        if entry.depth() == 0 {
            continue; // the root itself; its children populate the tree
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = if is_dir { 0 } else { entry.metadata().map(|m| m.len()).unwrap_or(0) };
        let lines = if !is_dir && opts.count_lines { count_lines_of(entry.path()) } else { None };
        let lang = if is_dir { None } else { lang_for(&rel) };
        let comps: Vec<&str> = rel.split('/').collect();
        insert(&mut tree, &comps, is_dir, size, lines, lang);
    }

    aggregate(&mut tree);
    Ok(tree)
}

/// Insert one walked entry into the tree, creating intermediate directory nodes as needed. A file
/// or directory whose node was already created (as a parent of an earlier-seen descendant) is filled
/// in rather than duplicated.
fn insert(parent: &mut Node, comps: &[&str], is_dir: bool, size: u64, lines: Option<u64>, lang: Option<String>) {
    let name = comps[0];
    let child_path = if parent.path.is_empty() { name.to_string() } else { format!("{}/{}", parent.path, name) };

    if comps.len() == 1 {
        // Leaf entry. If a placeholder dir node already exists (created by a deeper descendant), only
        // a FILE leaf needs to overwrite it; a dir leaf is already correct.
        if let Some(existing) = parent.children.iter_mut().find(|c| c.name == name) {
            if !is_dir {
                existing.kind = Kind::File;
                existing.size = size;
                existing.lines = lines;
                existing.lang = lang;
            }
            return;
        }
        parent.children.push(Node {
            name: name.to_string(),
            path: child_path,
            kind: if is_dir { Kind::Dir } else { Kind::File },
            size,
            files: 0,
            lines,
            lang,
            children: Vec::new(),
        });
        return;
    }

    // Intermediate directory: find or create it, then recurse.
    let idx = match parent.children.iter().position(|c| c.name == name) {
        Some(i) => i,
        None => {
            parent.children.push(Node::dir(name.to_string(), child_path));
            parent.children.len() - 1
        }
    };
    insert(&mut parent.children[idx], &comps[1..], is_dir, size, lines, lang);
}

/// Sort children (directories first, then files, each alphabetical) and roll up directory
/// `size`/`files` from the leaves. Returns this node's `(size, files)`.
fn aggregate(node: &mut Node) -> (u64, u64) {
    if node.kind == Kind::File {
        node.files = 1;
        return (node.size, 1);
    }
    node.children.sort_by(|a, b| {
        (a.kind == Kind::File).cmp(&(b.kind == Kind::File)).then_with(|| a.name.cmp(&b.name))
    });
    let (mut size, mut files) = (0u64, 0u64);
    for child in &mut node.children {
        let (s, f) = aggregate(child);
        size += s;
        files += f;
    }
    node.size = size;
    node.files = files;
    (size, files)
}

/// Render the tree as indented human text with sizes — directories as `name/  (<size>, <n> files)`,
/// files as `name  <size>[, <n> lines]`. `max_depth` collapses deeper subtrees (their aggregate is
/// still shown on the directory line). Two-space indent per level; easy for both humans and a model.
pub fn render_tree(node: &Node, max_depth: Option<usize>) -> String {
    let mut out = String::new();
    render_node(node, 0, max_depth, &mut out);
    out
}

fn render_node(node: &Node, depth: usize, max_depth: Option<usize>, out: &mut String) {
    let indent = "  ".repeat(depth);
    match node.kind {
        Kind::Dir => {
            out.push_str(&format!("{indent}{}/  ({}, {} files)\n", node.name, human_size(node.size), node.files));
            if max_depth.is_none_or(|m| depth < m) {
                for child in &node.children {
                    render_node(child, depth + 1, max_depth, out);
                }
            }
        }
        Kind::File => {
            let extra = node.lines.map(|n| format!(", {n} lines")).unwrap_or_default();
            out.push_str(&format!("{indent}{}  {}{}\n", node.name, human_size(node.size), extra));
        }
    }
}

/// Metrics for a single path (the `stat` command). Errors if the path doesn't exist.
pub fn stat(path: &Path, count_lines: bool) -> Result<FileStat, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let is_dir = md.is_dir();
    let display = path.to_string_lossy().replace('\\', "/");
    let modified_epoch = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    Ok(FileStat {
        path: display.clone(),
        kind: if is_dir { Kind::Dir } else { Kind::File },
        size: if is_dir { 0 } else { md.len() },
        lines: if !is_dir && count_lines { count_lines_of(path) } else { None },
        lang: if is_dir { None } else { lang_for(&display) },
        modified_epoch,
    })
}

/// A file's text (the `read` command), plus the metadata that makes a windowed read honest about what
/// it left out.
#[derive(Serialize, Debug)]
pub struct FileText {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// Total lines IN THE FILE — not in the returned window, so a caller can tell it got a slice.
    pub lines: u64,
    /// First line returned, 1-indexed inclusive.
    pub from: u64,
    /// Last line returned, 1-indexed inclusive. Equals `lines` for a whole-file read.
    pub to: u64,
    /// True when the window omits part of the file — the signal to ask for the rest.
    pub windowed: bool,
    pub text: String,
}

/// A file's text, optionally windowed to lines `from..=to` (both 1-indexed, inclusive).
///
/// The counterpart to [`stat`]: `stat` says how big a file is, this hands back what is in it. Exists so
/// a session confined to the `bsc` surface can read a module that no harvest lifts — const/type modules
/// like a `STATUS_META` table, which the component harvest skips (not a component) and the algorithms
/// harvest skips (not a function), leaving them unreadable through any other verb (#4161).
///
/// # Errors
/// Errors when `path` does not exist, is a directory, is not valid UTF-8, or holds NUL bytes (a binary
/// file, whose bytes would be garbage in a caller's context — refused rather than dumped). Also errors
/// when `from` exceeds `to`, or when `from` is past the end of the file: an empty result for an
/// out-of-range window would read as "this file is empty".
pub fn read(path: &Path, from: Option<u64>, to: Option<u64>) -> Result<FileText, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if md.is_dir() {
        return Err(format!("{} is a directory — `bsc files tree` lists it", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes.contains(&0) {
        return Err(format!(
            "{} looks binary (contains NUL bytes) — refusing to print it; `bsc files stat` reports its size",
            path.display()
        ));
    }
    let body = String::from_utf8(bytes)
        .map_err(|_| format!("{} is not valid UTF-8 — refusing to print it", path.display()))?;

    let all: Vec<&str> = body.lines().collect();
    let total = all.len() as u64;
    let start = from.unwrap_or(1).max(1);
    let end = to.unwrap_or(total).min(total);
    if let (Some(f), Some(t)) = (from, to) {
        if f > t {
            return Err(format!("--from {f} is past --to {t}"));
        }
    }
    // A window that starts past the end is an error, not an empty read: silently returning "" would be
    // indistinguishable from an empty file, which is the misread this whole surface exists to avoid.
    if start > total && total > 0 {
        return Err(format!("--from {start} is past the end of the file ({total} lines)"));
    }
    let slice: Vec<&str> = if total == 0 {
        Vec::new()
    } else {
        all[(start - 1) as usize..end as usize].to_vec()
    };
    let display = path.to_string_lossy().replace('\\', "/");
    Ok(FileText {
        lang: lang_for(&display),
        path: display,
        lines: total,
        from: if total == 0 { 0 } else { start },
        to: if total == 0 { 0 } else { end },
        windowed: total > 0 && (start > 1 || end < total),
        text: slice.join("\n"),
    })
}

/// Which import syntax to look for. TS/JS/JSX/TSX share the ES-module family; a `.rs` query uses
/// Rust's `use`/`mod`. Anything else (e.g. a `.css` module imported from JS) falls back to the
/// ES-module rules, since that's how a stylesheet is referenced.
#[derive(Clone, Copy, PartialEq)]
enum RefLang {
    Rust,
    EsModule,
}

fn ref_lang(path: &str) -> RefLang {
    match lang_for(path).as_deref() {
        Some("rust") => RefLang::Rust,
        _ => RefLang::EsModule,
    }
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// True if `needle` occurs in `hay` bounded by non-identifier chars on both sides (a whole-word
/// match), so `handleClick` matches `handleClick()` but not `handleClickHandler`.
fn contains_word(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(rel) = hay[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        let before_ok = hay[..start].chars().next_back().is_none_or(|c| !is_ident_char(c));
        let after_ok = hay[end..].chars().next().is_none_or(|c| !is_ident_char(c));
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn is_test_file(name: &str) -> bool {
    name.contains(".test.") || name.contains(".spec.") || name.contains("_test.")
}

fn is_style_file(path: &str) -> bool {
    matches!(lang_for(path).as_deref(), Some("css") | Some("scss"))
}

fn is_code_file(path: &str) -> bool {
    matches!(lang_for(path).as_deref(), Some("typescript" | "tsx" | "javascript" | "jsx" | "html"))
}

/// Does `line` look like it imports `needle` (a module stem or a symbol) in `lang`'s syntax?
fn is_importer_line(line: &str, lang: RefLang, needle: &str) -> bool {
    match lang {
        RefLang::Rust => {
            let l = line.trim_start();
            let uses = l.starts_with("use ")
                || l.starts_with("pub use ")
                || l.starts_with("mod ")
                || l.starts_with("pub mod ")
                || line.contains(" mod ");
            uses && contains_word(line, needle)
        }
        RefLang::EsModule => {
            let imports = line.contains("import") || line.contains("require(") || line.contains("from ") || line.contains("export");
            imports && contains_word(line, needle)
        }
    }
}

/// All class names defined by `.class` selectors on one CSS/SCSS line (bounded so `.foo-btn` and
/// `.foo-btn-lg` are distinct, and numeric fragments like `1.5` are skipped).
fn classes_in_css_line(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '.' {
            let before_ok = i == 0 || {
                let c = chars[i - 1];
                !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            };
            let mut j = i + 1;
            let mut name = String::new();
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '-' || chars[j] == '_') {
                name.push(chars[j]);
                j += 1;
            }
            if before_ok && !name.is_empty() && !name.starts_with(|c: char| c.is_ascii_digit()) {
                out.push(name);
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

/// The class tokens a component references: `className=`/`class=` string literals plus CSS-module
/// `styles.<ident>` accesses.
fn class_tokens_used(text: &str) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    for kw in ["className=", "class="] {
        let mut from = 0;
        while let Some(rel) = text[from..].find(kw) {
            let after = from + rel + kw.len();
            from = after;
            let rest = text[after..].trim_start_matches(|c: char| c == '{' || c.is_whitespace());
            let mut chars = rest.chars();
            if let Some(q) = chars.next() {
                if q == '"' || q == '\'' || q == '`' {
                    let body: String = chars.take_while(|&c| c != q).collect();
                    for tok in body.split_whitespace() {
                        if !tok.is_empty() && tok.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                            set.insert(tok.to_string());
                        }
                    }
                }
            }
        }
    }
    let mut from = 0;
    while let Some(rel) = text[from..].find("styles.") {
        let start = from + rel + "styles.".len();
        from = start;
        let ident: String = text[start..].chars().take_while(|&c| is_ident_char(c) || c == '-').collect();
        if !ident.is_empty() {
            set.insert(ident);
        }
    }
    set
}

/// Walk `root` gitignore-aware (skipping hidden/.git, never following symlinks — same filters as
/// [`build_tree`]'s default), returning each readable text file as `(relative_path, contents)`.
fn walk_text_files(root: &Path) -> Vec<(String, String)> {
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .require_git(false)
        .follow_links(false)
        .build();

    let mut out = Vec::new();
    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.depth() == 0 || entry.file_type().is_none_or(|t| t.is_dir()) {
            continue;
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(entry.path()) {
            out.push((rel, content));
        }
    }
    out
}

fn basename(rel: &str) -> &str {
    &rel[rel.rfind('/').map_or(0, |i| i + 1)..]
}

fn dirname(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

fn hit(path: &str, idx: usize, line: &str) -> Hit {
    Hit { path: path.to_string(), line: idx + 1, text: line.trim().to_string() }
}

/// Cross-file dependency/impact finder (the `refs` command). Given `path` (relative to `root`) and an
/// optional `symbol`, returns the grouped, line-numbered impact map — siblings, importers, symbol
/// usages, and CSS style links. Heuristic/textual over the gitignore-aware tree (may over-report).
///
/// # Errors
/// If `root/path` is not an existing file.
pub fn refs(root: &Path, path: &str, symbol: Option<&str>) -> Result<Refs, String> {
    let rel_owned = path.replace('\\', "/");
    let rel = rel_owned.strip_prefix("./").unwrap_or(&rel_owned).to_string();
    let full = root.join(&rel);
    if !full.is_file() {
        return Err(format!("not a file: {}", full.display()));
    }
    let self_content = std::fs::read_to_string(&full).unwrap_or_default();

    let file_name = basename(&rel).to_string();
    let dir = dirname(&rel).to_string();
    let base = file_name.split('.').next().unwrap_or(&file_name).to_string();
    let module = Path::new(&file_name).file_stem().and_then(|s| s.to_str()).unwrap_or(&base).to_string();
    let lang = ref_lang(&rel);
    let needle = symbol.unwrap_or(&module);

    let files = walk_text_files(root);

    // 1 — Siblings: same directory, same first-dot basename, not the file itself.
    let mut siblings = Siblings::default();
    for (p, _) in &files {
        if p == &rel || dirname(p) != dir {
            continue;
        }
        let pname = basename(p);
        if pname.split('.').next().unwrap_or(pname) == base {
            if is_test_file(pname) {
                siblings.tests.push(p.clone());
            } else {
                siblings.files.push(p.clone());
            }
        }
    }
    siblings.files.sort();
    siblings.tests.sort();

    // 2 + 3 — Importers (module- or symbol-scoped) and, when a symbol is given, its usages.
    let mut importers = Vec::new();
    let mut symbol_usages = Vec::new();
    for (p, content) in &files {
        for (idx, line) in content.lines().enumerate() {
            if p != &rel && is_importer_line(line, lang, needle) {
                importers.push(hit(p, idx, line));
            }
            if let Some(sym) = symbol {
                if contains_word(line, sym) {
                    symbol_usages.push(hit(p, idx, line));
                }
            }
        }
    }

    // 4 — Style links, both directions.
    let mut style_links = Vec::new();
    // (a) classes the component references → their `.css`/`.scss` definitions.
    let used = class_tokens_used(&self_content);
    if !used.is_empty() {
        for (p, content) in &files {
            if !is_style_file(p) {
                continue;
            }
            for (idx, line) in content.lines().enumerate() {
                if classes_in_css_line(line).iter().any(|c| used.contains(c)) {
                    style_links.push(hit(p, idx, line));
                }
            }
        }
    }
    // (b) classes defined in the component's own stylesheet (a same-basename sibling) → where used.
    let mut sib_classes: BTreeSet<String> = BTreeSet::new();
    for (p, content) in &files {
        if p == &rel || !is_style_file(p) {
            continue;
        }
        let pname = basename(p);
        if pname.split('.').next().unwrap_or(pname) != base {
            continue;
        }
        for line in content.lines() {
            sib_classes.extend(classes_in_css_line(line));
        }
    }
    if !sib_classes.is_empty() {
        for (p, content) in &files {
            if !is_code_file(p) {
                continue;
            }
            for (idx, line) in content.lines().enumerate() {
                let attr = line.contains("className") || line.contains("class=") || line.contains("styles.");
                if attr && sib_classes.iter().any(|c| contains_word(line, c)) {
                    style_links.push(hit(p, idx, line));
                }
            }
        }
    }
    style_links.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    style_links.dedup_by(|a, b| a.path == b.path && a.line == b.line);

    Ok(Refs { path: rel, symbol: symbol.map(str::to_string), siblings, importers, symbol_usages, style_links })
}

/// Render a [`Refs`] as grouped human text — a header (with the heuristic caveat) then each group
/// with its `path:line` hits. Style/importers/usages carry the source line for context.
pub fn render_refs(r: &Refs) -> String {
    let mut s = match &r.symbol {
        Some(sym) => format!("refs: {} [symbol: {sym}]  (heuristic — may over-report)\n", r.path),
        None => format!("refs: {}  (heuristic — may over-report)\n", r.path),
    };
    s.push_str(&format!("\nSiblings ({}):\n", r.siblings.files.len() + r.siblings.tests.len()));
    for p in &r.siblings.files {
        s.push_str(&format!("  {p}\n"));
    }
    if !r.siblings.tests.is_empty() {
        s.push_str("  Tests:\n");
        for p in &r.siblings.tests {
            s.push_str(&format!("    {p}\n"));
        }
    }
    push_hits(&mut s, "Importers", &r.importers);
    if r.symbol.is_some() {
        push_hits(&mut s, "Symbol usages", &r.symbol_usages);
    }
    push_hits(&mut s, "Style links", &r.style_links);
    s
}

fn push_hits(s: &mut String, label: &str, hits: &[Hit]) {
    s.push_str(&format!("\n{label} ({}):\n", hits.len()));
    for h in hits {
        if h.text.is_empty() {
            s.push_str(&format!("  {}:{}\n", h.path, h.line));
        } else {
            s.push_str(&format!("  {}:{}  {}\n", h.path, h.line, h.text));
        }
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs does not exist — it is a record in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-files--<module>.rs
//     bsc graph impl set --id bsc-files--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-files--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-files--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
