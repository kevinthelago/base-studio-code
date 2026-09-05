//! Shared test helpers (#758), reachable as crate::testutil::* from every module's tests.
    use std::path::{Path, PathBuf};
    use std::sync::Mutex as StdMutex;

    /// Serializes the env-mutating tests (they all repoint HOME/USERPROFILE, which
    /// `home_dir()` reads) so they can't race each other.
    pub static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    /// Fresh unique temp dir with HOME/USERPROFILE pointed at it so `bsc_base_dir()`
    /// resolves inside it. Caller removes it when done.
    pub fn temp_home(tag: &str) -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("bsc-test-{tag}-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
        std::env::set_var("USERPROFILE", &dir);
        dir
    }

    pub fn write_file(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// A fresh, unique temp PATH `<temp>/<prefix>-<tag>-<pid>-<nanos>` (NOT created on disk —
    /// callers `create_dir_all`/remove it). The pid+nanos suffix keeps parallel test processes and
    /// cases from colliding. `prefix` names the caller domain (e.g. `"bsc-wt"`), `tag` the case.
    pub fn unique_dir(prefix: &str, tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("{prefix}-{tag}-{}-{nanos}", std::process::id()))
    }

/// The source text of one of THIS crate's own modules, WHEREVER that source currently lives.
///
/// `rel` is the module's path under `src/`, forward-slashed and with its extension:
/// `"console/pty/launch.rs"`, `"shot/mod.rs"`.
///
/// # Why this exists rather than `include_str!("launch.rs")`
///
/// Five modules of this crate used to read their own source to assert something about the code that
/// SHIPS — a raw ESC byte that readline would eat, the signal decode `child_outcome` really uses, a
/// call site that a pure unit test cannot reach. Every one of those is a real guarantee and none of
/// them is expressible as a runtime assertion.
///
/// But `include_str!("launch.rs")` names the one file `bsc graph migrate-crate src-tauri` DELETES: the
/// module becomes a record in `graph/algorithms.json` and is materialized into `$OUT_DIR/crate.rs` by
/// `build.rs`. `migrate-crate` refuses `--apply` over exactly this, and it was the last blocker in
/// front of 136 modules and 55,843 lines — the largest un-migrated body in the repo.
///
/// # What it reads, in order, and why that order
///
/// 1. `$CARGO_MANIFEST_DIR/src/<rel>` while the module is still a FILE.
/// 2. the module's own section of `$OUT_DIR/crate.rs` once it is a RECORD, split on the
///    ``// record `<id>`` marker `graph-materialize` emits at each module head.
///
/// THE FILE WINS, for the same reason `tests.rs::source_units` gives: while a file is on disk it is
/// what rustc compiles, and a record sharing its path is an edit nobody has materialized yet.
///
/// Reading the materialized output is not a workaround — it is STRICTLY BETTER EVIDENCE than either
/// spelling of a self-read, because it is the text the compiler compiled. It also names an offender by
/// RECORD ID, which is what a reader edits (`bsc graph impl get <id>`) once the file is gone.
///
/// # It cannot silently scan nothing
///
/// Neither home resolving is a panic naming BOTH of them and the record id. A guard handed an empty
/// string finds no offenders and passes, which is the failure this whole family exists to prevent —
/// and the reason `env!("OUT_DIR")` is used rather than `option_env!`: this crate has a build script,
/// so `OUT_DIR` is always set, and an `Option` here would turn "the materializer stopped emitting"
/// into a silent skip.
pub fn module_source(rel: &str) -> String {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(rel);
    if let Ok(text) = std::fs::read_to_string(&file) {
        return text;
    }
    // NEVER a restatement of the id derivation: the build SELECTED records by
    // `graph_materialize::expected_id`, so a second copy could disagree with what it actually emitted
    // and this resolver would report a module missing that is right there in the file.
    let id = graph_materialize::expected_id("src-tauri", rel);
    let generated = Path::new(env!("OUT_DIR")).join("crate.rs");
    let materialized = std::fs::read_to_string(&generated).unwrap_or_default();
    if let Some(body) = record_section(&materialized, &id) {
        return body;
    }
    panic!(
        "module `{rel}` of this crate has no source in either home — not at {} (a FILE), and no \
         `// record `{id}`` section in {} (a RECORD). A guard reading nothing does not fail, it \
         passes over an empty string, so this is a hard error. If the module migrated under a \
         different id, `bsc graph migrate-crate src-tauri` prints the one it writes.",
        file.display(),
        generated.display(),
    )
}

/// One record's body out of a materialized `crate.rs`.
///
/// The generated file is a nest of `mod <name> { // record `<id>` … }` blocks and CHILDREN GO INSIDE,
/// after the parent's own body — so a section runs from its marker to the next marker, and a
/// directory module (`shot/mod.rs`) still yields its whole body before its children begin.
pub fn record_section(materialized: &str, id: &str) -> Option<String> {
    const MARKER: &str = "// record `";
    let mut body: Option<String> = None;
    for line in materialized.lines() {
        if let Some(rest) = line.trim_start().strip_prefix(MARKER) {
            if body.is_some() {
                break; // the next record starts here
            }
            if rest.split('`').next() == Some(id) {
                body = Some(String::new());
            }
            continue;
        }
        if let Some(b) = body.as_mut() {
            b.push_str(line);
            b.push('\n');
        }
    }
    body
}

/// The shared import preamble for the per-module `relocated_tests` blocks (#2077). Every one of
/// those ~18 modules copy-pasted the identical glob dance; they now do just `use super::*;` (their
/// own module's items) + `use crate::testutil::prelude::*;`.
pub mod prelude {
    // The aggregated globs mirror the old per-module preamble, which was itself
    // `#![allow(unused_imports)]` — not every consuming test touches every re-export.
    #![allow(unused_imports)]
    pub(crate) use crate::extensions::{cfg::*, mcp::*};
    pub(crate) use crate::fleet::{director::*, inspect::*, worktree::*};
    pub(crate) use crate::prelude::*;
    pub(crate) use crate::project::{
        dead_code::*, files::*, hub::*, plan_db::*, plan_files::*, ui_skeleton::*,
    };
    pub(crate) use super::{temp_home, unique_dir, write_file, ENV_LOCK};
}
