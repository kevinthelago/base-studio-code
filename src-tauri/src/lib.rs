//! base-studio-code Tauri backend. The crate root is module declarations + the `run` entry point + the
//! internal `prelude` (#1918). Domain modules are referenced by their full path
//! (`crate::console::pty`, `crate::observability::logs`, `crate::mobile::tunnel`, …) so a reference
//! always names its domain; the common leaf helpers come from `crate::prelude` (`use crate::prelude::*;`).
//! (This replaced the #1300 crate-root re-export shim that aliased every subsystem under flat
//! `crate::<name>` paths.)


// The leaf-helper prelude is re-exported at the crate root so the common helpers stay reachable as
// `crate::<helper>` (and via `use crate::prelude::*;`). This is the ONLY crate-root re-export — the
// misleading #1300 module aliases (`crate::pty` = console::pty, `crate::data` = sources::data, …) are
// gone; domain modules are now referenced by their full path.
pub(crate) use prelude::*;

pub use app::run::run;

#[cfg(test)]
mod tests;

// This crate's modules are IN THE GRAPH, not in this directory.
// src/planner/mod.rs, src/planner/prompts.rs, src/planner/directives.rs, src/planner/workspace.rs, src/planner/injection_scan.rs, src/platform/mod.rs, src/platform/paths.rs, src/platform/git.rs, src/platform/http.rs, src/platform/shell/mod.rs, src/platform/shell/ptybridge.rs, src/platform/process.rs, src/platform/fsx.rs, src/platform/errs.rs, src/platform/docstore.rs, src/platform/pkgcache.rs, src/platform/config.rs, src/platform/path_expose.rs, src/platform/offmain.rs, src/app/mod.rs, src/app/ack.rs, src/app/run.rs, src/app/single_instance.rs, src/app/state.rs, src/app/recovery.rs, src/app/dialog.rs, src/console/mod.rs, src/console/pty/mod.rs, src/console/pty/busy.rs, src/console/pty/env.rs, src/console/pty/launch.rs, src/console/pty/pump.rs, src/console/pty/stops.rs, src/console/pty/reap.rs, src/console/pty/scrollback.rs, src/console/pty/job.rs, src/console/ledger.rs, src/console/discovery.rs, src/console/shell_rc/mod.rs, src/console/bsc.rs, src/console/bsc_warm.rs, src/session/mod.rs, src/session/harness.rs, src/session/claude_config.rs, src/session/launch.rs, src/session/fresh_only.rs, src/session/resume_cmd.rs, src/session/launch_cmd.rs, src/session/settings.rs, src/session/sandbox/mod.rs, src/session/sandbox/bridge.rs, src/session/sandbox/provision.rs, src/session/sandbox/readiness.rs, src/session/sandbox/users.rs, src/session/llm.rs, src/session/studio_ws.rs, src/session/designer.rs, src/session/architect.rs, src/session/librarian.rs, src/session/sound_designer.rs, src/session/integrator.rs, src/session/debug.rs, src/session/persona_use.rs, src/session/system.rs, src/session/deliver.rs, src/github/mod.rs, src/github/api.rs, src/github/oauth.rs, src/github/git_hooks.rs, src/github/repos.rs, src/github/readiness.rs, src/sources/mod.rs, src/sources/data/mod.rs, src/sources/data/data_csv.rs, src/sources/data/data_scan.rs, src/sources/oauth.rs, src/sources/credentials.rs, src/observability/mod.rs, src/observability/attest.rs, src/observability/boot_watch.rs, src/observability/renderer_watch.rs, src/observability/collector.rs, src/observability/graph_log.rs, src/observability/log_watch.rs, src/observability/logs.rs, src/observability/perf.rs, src/observability/pty_faults.rs, src/observability/tokens/mod.rs, src/observability/tokens/cost.rs, src/observability/tokens/messages.rs, src/mobile/mod.rs, src/mobile/fcm.rs, src/mobile/tunnel/mod.rs, src/mobile/tunnel/transport.rs, src/mobile/tunnel/state.rs, src/mobile/tunnel/commands.rs, src/project/mod.rs, src/project/plan_db.rs, src/project/files.rs, src/project/hub.rs, src/project/plan_files.rs, src/project/dead_code.rs, src/project/ui_skeleton.rs, src/project/preview.rs, src/project/graph_layout.rs, src/project/integrations.rs, src/fleet/mod.rs, src/fleet/wake.rs, src/fleet/commons.rs, src/fleet/director_new.rs, src/fleet/start.rs, src/fleet/worktree.rs, src/fleet/teardown.rs, src/fleet/worktree_reconcile.rs, src/fleet/disk.rs, src/fleet/director.rs, src/fleet/protocols.rs, src/fleet/inspect.rs, src/fleet/worker_end.rs, src/fleet/warden.rs, src/extensions/mod.rs, src/extensions/mcp.rs, src/extensions/mcp_resolution.rs, src/extensions/hooks.rs, src/extensions/skills.rs, src/extensions/skill_resolution.rs, src/extensions/cfg.rs, src/shot/mod.rs, src/shot/crop.rs, src/appchan/mod.rs, src/navigate/mod.rs, src/lan/mod.rs, src/lan/subscribe.rs, src/debug/mod.rs, src/prelude.rs, src/testutil.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by `graph_materialize::emit();`, called from this
// crate's own build.rs (a package gets exactly ONE build script, and this one was taken).
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get src-tauri--<module>.rs
//     bsc graph impl set --id src-tauri--<module>.rs --code-file <f>
//     bsc graph promote --id src-tauri--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));