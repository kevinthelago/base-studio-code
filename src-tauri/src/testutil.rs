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
    pub(crate) use super::{temp_home, write_file, ENV_LOCK};
}
