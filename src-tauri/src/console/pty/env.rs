// Session environment for a PTY: the terminal-type defaults (`session_env`), the
// per-project db-path helpers (`plan_db_for_cwd` / `data_db_for_cwd`), the bundled
// `bsc-*` sidecar resolvers (`sidecar_bin_path` / `sidecar_candidates` / `bsc_bin_path`
// / `sidecar_status`), and the `BSC_*` env-var wiring the `bsc-*` shell helpers read
// (`wire_bsc_env`). Split out of `mod.rs` (#1864) so `pty_create` stays readable
// orchestration; behavior is unchanged.

use crate::console::shell_rc::bsc_rc_body;
use crate::{bsc_base_dir, to_bash_path};
use portable_pty::CommandBuilder;
use std::collections::HashMap;

/// The sanitized project key owning `cwd`, or None when `cwd` is empty or belongs to no project.
///
/// A project session lives under ONE OF TWO roots, and both must resolve to the same key:
///   · the hub          — `~/.base-studio-code/projects/<key>/...`   (the director and the planner)
///   · the worktree tree — `~/.base-studio-code/worktrees/<key>/...` (every fleet WORKER)
///
/// The second root is why this exists. It used to strip only `projects_root()`, and the comment
/// claimed "workers run in `projects/<key>/.worktrees/...`" — a layout #844 deliberately abandoned
/// when it moved worktrees OUT of the hub so the planner's `CLAUDE.md` would stop being an ancestor
/// of every worker (`worktrees_dir`, and the test `worktrees_dir_is_outside_the_project_hub`). After
/// that move the strip failed for every worker, so `BSC_PLAN_DB` — and with it `error.db`, `usage.db`
/// and the project DuckDB, which all share this derivation — was never set for one. A worker could
/// not read its own items, file a `bsc plan request`, open a `bsc plan change`, or mark anything
/// complete; `bsc-ask` (a bare coord.log append needing no DB) was the only channel left, which is
/// exactly what the ask queue filled up with.
///
/// Shared by [`plan_db_for_cwd`], [`error_db_for_cwd`], [`usage_db_for_cwd`] and [`data_db_for_cwd`]
/// so every per-project store a session reaches resolves to the same key.
fn project_key_from_cwd(cwd: &str) -> Option<std::ffi::OsString> {
    if cwd.is_empty() {
        return None;
    }
    let path = std::path::Path::new(cwd);
    // Both roots, most-specific-first is not needed (they are siblings and cannot both match), but a
    // non-project session must still resolve to None — so this is an allow-list of the two project
    // roots rather than "anything under the base dir".
    let roots = [crate::projects_root(), crate::worktrees_root()];
    roots
        .iter()
        .find_map(|root| path.strip_prefix(root).ok())
        .and_then(|rel| rel.components().next())
        .map(|c| c.as_os_str().to_os_string())
}

/// The workspace dir of an app-owned STUDIO session, or None for every other pane.
///
/// Derived from the cwd exactly like [`plan_db_for_cwd`], rather than plumbed down from the frontend,
/// so the rule lives in ONE place: a studio workspace is a DIRECT child of the bsc base dir whose name
/// ends in `-studio` (`~/.base-studio-code/design-studio/`, `…/sound-studio/`, …).
///
/// Everything a restricted studio needs on disk hangs off this — the scratch dir (#3373) and the shots
/// dir (#3468) — so a studio's working files all sit under the one root `bsc-confine` confines it to
/// (`$BSC_REPO_ROOT` is the session cwd). Adding a sibling dir OUTSIDE this root is how the shots
/// became unreadable in the first place.
fn studio_dir_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    let native = cwd.to_string();
    let dir = std::path::Path::new(&native);
    // A DIRECT child of the base dir — not a nested path that merely starts with it.
    if dir.parent() != Some(bsc_base_dir().as_path()) {
        return None;
    }
    let name = dir.file_name()?.to_string_lossy().into_owned();
    name.ends_with("-studio").then(|| dir.to_path_buf())
}

/// The sealed scratch dir for an app-owned STUDIO session (#3373), or None for every other pane.
///
/// A restricted studio session is confined to one store CLI by Bash allow-list rules, and a heredoc
/// cannot be allow-listed (newlines are command separators), so it authors by WRITING a payload here
/// and passing `--file <bare-name>`. Only the studio workspaces get one: a plain console in some repo
/// has no confinement to work around and would just accumulate stray dirs.
fn scratch_dir_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    studio_dir_for_cwd(cwd).map(|d| d.join("scratch"))
}

/// The shots dir for an app-owned STUDIO session (#3468), or None for every other pane.
///
/// `bsc shot` defaults to `~/.base-studio-code/shots` — a SIBLING of a studio's workspace, and
/// therefore outside `$BSC_REPO_ROOT`. `bsc-confine` matches `Read` as well as the write tools, so a
/// studio session could TAKE a shot and then be blocked from reading it back: write-only with respect
/// to its own ground truth, which is exactly backwards for a loop whose premise is that the shot — not
/// the description of it — is the check.
///
/// Pointing the shots INSIDE the workspace fixes that without widening the cage for anything else.
fn shot_dir_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    studio_dir_for_cwd(cwd).map(|d| d.join("shots"))
}

/// The project hub's `plan.db` for a session whose cwd lives under a project hub
/// (`~/.base-studio-code/projects/<key>/...`), or None for a non-project session (#plan-db).
/// Workers run in `projects/<key>/.worktrees/...` and the director/planner in `projects/<key>/` —
/// both resolve to the same hub db, so the whole fleet shares one canonical plan store.
pub(super) fn plan_db_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    let key = project_key_from_cwd(cwd)?;
    Some(crate::plan_db_path(&key.to_string_lossy()))
}

/// The project hub's `error.db` (the runtime-fault store, #2260) for a session under a project hub —
/// same key derivation as [`plan_db_for_cwd`], so the whole fleet shares one error.db per project.
/// None for a non-project session.
fn error_db_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    let key = project_key_from_cwd(cwd)?;
    Some(crate::error_db_path(&key.to_string_lossy()))
}

/// The project's per-project usage-events store (`projects/<key>/usage.db`) for `cwd`, or None for a
/// non-project session (#3812, epic #3809).
fn usage_db_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    let key = project_key_from_cwd(cwd)?;
    Some(crate::usage_db_path(&key.to_string_lossy()))
}

/// The project's per-project DuckDB **data store** (`~/.base-studio-code/data/<key>.duckdb`) for a
/// session under a project hub — the Data Model + PlatformScan the planner reads via `bsc data`
/// (#1446). Same key derivation as [`plan_db_for_cwd`]; None for a non-project session.
fn data_db_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    let key = project_key_from_cwd(cwd)?;
    Some(crate::data_db_path(&key.to_string_lossy()))
}

/// The absolute path of a bundled `bsc-*` binary named `stem` — the binary sitting beside the running
/// app exe (the cargo target dir in dev; a bundled sidecar in a release), or None if it isn't there.
/// `stem` is the bare name without the platform extension (`.exe` is appended on Windows). The app
/// ships just two binaries now (#1877): the unified `bsc` umbrella (every state CLI + the two MCP
/// servers are its subcommands) and the `bsc-agent` runtime. Sessions get `bsc` as `$BSC_BIN` and
/// `bsc-agent` as `$BSC_AGENT_BIN`; the MCP servers are rewritten into `.mcp.json` as `bsc mcp <sub>`
/// (which Claude Code spawns directly, no shell-rc) via the `pub(crate)` wrapper below.
fn sidecar_bin_path(stem: &str) -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { format!("{stem}.exe") } else { stem.to_string() };
    let cur = std::env::current_exe().ok()?;
    // Dev (running from `target/<profile>/`): prefer the stable staged copy (`stage_dev_sidecars`, run
    // at boot) so a live session's long-lived `bsc` — chiefly the MCP servers — locks THAT copy, leaving
    // the build output cargo relinks free. Without this a running sidecar holds `target/<profile>/bsc.exe`
    // open and every relink fails (`LNK1104: cannot open … bsc.exe` on Windows) (#3457). A release bundle
    // is NOT a build output, so the staged dir is skipped — a stale dev copy must never shadow the bundled
    // sidecar; resolution there stays beside-the-exe, unchanged.
    if is_build_output(&cur) {
        let staged = staged_sidecar_dir().join(&exe);
        if staged.exists() {
            return Some(staged);
        }
    }
    sidecar_candidates(&cur, &exe).into_iter().find(|p| p.exists())
}

/// The stable dir the dev sidecars are copied to so a live session never locks the build output
/// (`target/<profile>/<exe>`), which would break cargo's relink (#3457). `~/.base-studio-code/bin/`,
/// beside the rest of the app state.
fn staged_sidecar_dir() -> std::path::PathBuf {
    bsc_base_dir().join("bin")
}

/// True when `exe_path` is a cargo build output — its parent is a `debug`/`release` profile dir sitting
/// directly under a `target` dir (`…/target/{debug,release}/<exe>`). That is the dev condition where the
/// app (hence its sidecars) runs from a dir cargo relinks; a real install runs from a bundle dir, never
/// `target/<profile>`. Pure (no fs/env) so the classification is unit-testable.
fn is_build_output(exe_path: &std::path::Path) -> bool {
    let Some(profile_dir) = exe_path.parent() else { return false };
    let is_profile = matches!(
        profile_dir.file_name().and_then(|s| s.to_str()),
        Some("debug" | "release")
    );
    let under_target =
        profile_dir.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str()) == Some("target");
    is_profile && under_target
}

/// The ordered candidate paths for a sidecar named `exe_name`, given the running app exe `cur_exe`.
/// The bundled sidecar sits BESIDE the app exe (a release bundle stages it there; in dev that dir is
/// `target/<profile>/`). But the sidecars are built by a SEPARATE step (`npm run build:plan`) from the
/// app, so any build path that skips it — or running the app exe from elsewhere — would leave the
/// beside-the-exe copy missing and silently unset `$BSC_BIN`, the gap that left sessions unable to find
/// `bsc`. So we ALSO probe both workspace profile dirs (`target/debug`, `target/release`) relative to
/// the exe, so a sidecar built at all is found regardless of which profile built it (#1988 resilience).
/// Pure (no fs/env) so the ordering is unit-testable; `sidecar_bin_path` applies `.exists()`.
fn sidecar_candidates(cur_exe: &std::path::Path, exe_name: &str) -> Vec<std::path::PathBuf> {
    let mut v = Vec::new();
    let Some(exe_dir) = cur_exe.parent() else { return v };
    v.push(exe_dir.join(exe_name)); // beside the app exe — release bundle + dev target/<profile>
    if let Some(target_dir) = exe_dir.parent() {
        for profile in ["debug", "release"] {
            let cand = target_dir.join(profile).join(exe_name);
            if !v.contains(&cand) {
                v.push(cand);
            }
        }
    }
    v
}

/// The absolute path of the bundled unified `bsc` binary (#1877), or None if absent. Used by
/// `extensions/mcp.rs` to rewrite the built-in Research/Compliance MCP servers' `.mcp.json` commands
/// to `<bsc> mcp <sub>`, since Claude Code spawns `.mcp.json` commands directly (no PATH/shell-rc).
/// Thin wrapper over [`sidecar_bin_path`].
pub(crate) fn bsc_bin_path() -> Option<std::path::PathBuf> {
    sidecar_bin_path("bsc")
}

/// The `bsc-hook` binary — the PreToolUse gates a session inside a mount namespace can actually
/// reach, bound read-only at `/bsc-hook` (`bsc_sandbox::HOOK_GUEST_PATH`).
///
/// It is a SEPARATE binary from the umbrella `bsc` on purpose, and that is not an accident of
/// packaging: inside a cage there is no `bsc`, no `BASH_ENV` and an environment cleared to
/// HOME/TERM, so the pure-shell gates never load and `bsc hook` has nothing to exec. Binding the
/// umbrella instead would mean binding DuckDB and a writable store into the cage — the ambient
/// authority the isolation exists to remove (see `crates/bsc-hook/Cargo.toml`). So this carries
/// exactly the two checks the kernel cannot express (`scope`, `bash-deny`) and nothing else.
///
/// `None` when it has not been built — the launch then proceeds with path confinement only, which
/// is what every namespace session got before this was wired at all.
pub(crate) fn bsc_hook_bin_path() -> Option<std::path::PathBuf> {
    sidecar_bin_path("bsc-hook")
}

/// The agent harness's own per-session state directory for a session running in `cwd` —
/// `~/.claude/projects/<slug>/`, where `<slug>` is the cwd with `:` `\` `/` `.` each replaced by `-`.
///
/// That is where the harness keeps this session's `memory/` and `tool-results/`. It sits outside the
/// repo root, so FS confinement (#158) blocked it and memory failed SILENTLY — the read was refused
/// and the session continued without it (#4084).
///
/// `None` when the home dir is unresolvable or `cwd` is empty, in which case `$BSC_AGENT_STATE_DIR` is
/// simply not set and confinement behaves exactly as it did before.
///
/// The slug rule is the harness's, mirrored here — verified against the real on-disk directories for a
/// studio session, a fleet worker, and the desktop repo itself.
pub(crate) fn agent_state_dir(cwd: &str) -> Option<std::path::PathBuf> {
    if cwd.trim().is_empty() {
        return None;
    }
    let slug: String = cwd
        .chars()
        .map(|c| if matches!(c, ':' | '\\' | '/' | '.') { '-' } else { c })
        .collect();
    let home = crate::platform::paths::home_dir();
    if home.as_os_str().is_empty() {
        return None;
    }
    Some(home.join(".claude").join("projects").join(slug))
}

/// Startup self-check (#1988): each bundled sidecar and where it resolved (`None` ⇒ missing). Logged
/// loudly at boot (`app::run`) so a missing `bsc`/`bsc-agent` surfaces immediately, instead of only
/// when a live session silently can't find `bsc` because `$BSC_BIN` was never set.
pub(crate) fn sidecar_status() -> [(&'static str, Option<std::path::PathBuf>); 2] {
    [
        ("bsc", sidecar_bin_path("bsc")),
        ("bsc-agent", sidecar_bin_path("bsc-agent")),
    ]
}

/// Copy the dev build-output sidecars (`bsc`, `bsc-agent`) to the stable [`staged_sidecar_dir`] so a
/// live session's long-lived `bsc` processes (the Research/Compliance MCP servers) lock the STAGED copy,
/// not the build output cargo relinks — the fix for #3457 (`LNK1104: cannot open …\target\debug\deps\bsc.exe`).
/// Call once at boot (`app::run`), BEFORE [`sidecar_status`], so the status log reports the staged paths
/// [`sidecar_bin_path`] will hand out.
///
/// - **Dev only.** Gated on the app exe being a build output ([`is_build_output`]); a release bundle runs
///   from an install dir where beside-the-exe resolution is already stable, so nothing is staged.
/// - **Fail-soft.** A copy that fails because the staged file is locked (a leftover session from a prior
///   run) is logged and skipped — the existing staged copy stays valid, so resolution still finds a `bsc`.
///   Never panics, never blocks boot. A sidecar not yet built is left for `sidecar_status` to report.
pub(crate) fn stage_dev_sidecars() {
    let Ok(cur) = std::env::current_exe() else { return };
    if !is_build_output(&cur) {
        return; // release bundle: beside-the-exe is already stable — do not stage
    }
    let dir = staged_sidecar_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("[startup] could not create sidecar staging dir {}: {e}", dir.display());
        return;
    }
    // `bsc-hook` rides along: it is the PreToolUse floor a SANDBOXED session reaches (`/bsc-hook`),
    // and it is bound from wherever this resolves it. Staged like the others so a dev session gets
    // the stable copy rather than the build output cargo relinks under it.
    for stem in ["bsc", "bsc-agent", "bsc-hook"] {
        let exe = if cfg!(windows) { format!("{stem}.exe") } else { stem.to_string() };
        let Some(src) = sidecar_candidates(&cur, &exe).into_iter().find(|p| p.exists()) else {
            continue; // not built yet — sidecar_status reports it missing
        };
        let dst = dir.join(&exe);

        // REFUSE A SOURCE THAT CANNOT BE A BINARY, before anything is copied over the live path.
        //
        // `target/<profile>/bsc` is unlinked and rewritten by every `cargo build`, so at boot it can be
        // a zero-byte placeholder mid-link. `fs::copy` reproduces it faithfully — including its 0644
        // mode — and `verify_staged` then compares source length to staged length, agrees at 0, and logs
        // SUCCESS. Observed 2026-08-24: both sidecars staged 0 bytes and non-executable, and every `bsc`
        // call from every session failed `Permission denied` until they were replaced by hand. The
        // symptom appears wherever a session next execs `$BSC_BIN`, which looks nothing like staging.
        if let Err(why) = source_is_plausible(&src) {
            log::error!(
                "[startup] refusing to stage `{stem}` from {}: {why}. Keeping whatever is already staged \
                 — a stale sidecar is recoverable, a truncated one is not. Rebuild with \
                 `npm run build:plan` and restart.",
                src.display()
            );
            continue;
        }

        // NEVER STAGE BACKWARDS. Detection at boot (`stale_sidecars`) reports the damage after it is
        // done; this refuses to do it. Skipping leaves the NEWER staged binary in place, which is the
        // one sessions should be running anyway — and the log names the fix, because the real problem
        // in that state is that THIS tree's sidecar is stale.
        let mtime = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        if let Some(src_at) = mtime(&src) {
            if staging_would_downgrade(src_at, mtime(&dst)) {
                log::error!(
                    "[startup] refusing to stage `{stem}`: {} is OLDER than the staged copy at {}. \
                     Keeping the newer staged binary. This tree's sidecar is stale — run \
                     `npm run build:plan` here to rebuild it.",
                    src.display(),
                    dst.display()
                );
                continue;
            }
        }

        match stage_one(&src, &dst) {
            // #the-sidecar-swap-is-silent-in-both-directions: a successful `fs::copy` is NOT evidence
            // that the staged binary matches the source. Observed 2026-08-16: this line logged success
            // while the staged `bsc` stayed a Jul 20 build of 49 MB and the source was 74 MB — and the
            // only symptom, weeks later, was `bsc: unknown command 'change'` in an agent session, which
            // looks nothing like a staging problem. So assert the outcome instead of trusting the call.
            Ok(_) => match verify_staged(&src, &dst) {
                Ok(()) => {
                    ensure_executable(&dst);
                    log::info!("[startup] staged dev sidecar `{stem}` → {}", dst.display());
                }
                Err(why) => log::error!(
                    "[startup] staged `{stem}` to {} but it does NOT match the source ({why}) — sessions \
                     will run a DIFFERENT binary than this build. Source: {}",
                    dst.display(),
                    src.display()
                ),
            },
            // #3959: ERROR, not warn. A failed stage does not degrade gracefully — `$BSC_BIN` keeps
            // pointing at the STALE binary and every hook that names a newer subcommand is rejected by
            // a `bsc` that has never heard of it (`bsc: unknown hook 'bash-supply'`), which surfaces
            // much later and looks nothing like a staging problem.
            Err(e) => log::error!(
                "[startup] could not stage `{stem}` to {} — sessions will run a STALE sidecar: {e}",
                dst.display()
            ),
        }
    }
    sweep_superseded(&dir);
}

/// Copy `src` over `dst`, renaming a LOCKED `dst` out of the way first (#3959).
///
/// The staged copy exists precisely so a live session locks IT rather than `target/<profile>/bsc.exe`,
/// which would break cargo's relink (#3457). That protection is also a deadlock: on Windows
/// `fs::copy` cannot overwrite a file any process holds open, so the very lock the staging dir is
/// designed to attract is what prevents the staging dir from ever being refreshed. A long-lived
/// `bsc mcp` server guarantees it.
///
/// Windows lets you RENAME an open file — the handle follows the file — so the running session keeps
/// its old copy (valid until it exits) while a fresh binary lands at the canonical path.
/// Could `src` be a usable binary at all? The check [`verify_staged`] structurally cannot make.
///
/// `verify_staged` asks "does the staged copy MATCH the source" — a relative question, and a truncated
/// source satisfies it trivially. This asks the absolute one. Zero bytes is the unambiguous line and the
/// shape actually observed; a partially-written binary of nonzero length still slips through, and saying
/// so is better than implying this closes every window.
fn source_is_plausible(src: &std::path::Path) -> Result<(), String> {
    let md = std::fs::metadata(src).map_err(|e| format!("unreadable: {e}"))?;
    if !md.is_file() {
        return Err("not a regular file".to_string());
    }
    if md.len() == 0 {
        return Err("it is 0 bytes — a build is probably writing it right now".to_string());
    }
    Ok(())
}

/// Make the staged copy executable. `fs::copy` carries the SOURCE's mode, so a build artifact caught
/// mid-write at 0644 lands unrunnable — which is the second half of what was observed on 2026-08-24:
/// not just empty, but `-rw-rw-r--`, so even a correct binary at that path would have failed to exec.
#[cfg(unix)]
fn ensure_executable(dst: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(md) = std::fs::metadata(dst) {
        let mode = md.permissions().mode();
        if mode & 0o111 != 0o111 {
            let _ = std::fs::set_permissions(dst, std::fs::Permissions::from_mode(mode | 0o755));
        }
    }
}

#[cfg(not(unix))]
fn ensure_executable(_dst: &std::path::Path) {}

/// Stage `src` onto `dst` WITHOUT the destination ever being a partial file.
///
/// ## Why not `fs::copy` straight onto `dst`
///
/// It used to be exactly that, and it is the same defect the surrounding guards exist to prevent,
/// inside the code that prevents it. `fs::copy` TRUNCATES the destination and then streams into it, so
/// for as long as a 261 MB binary takes to copy, `$BSC_BIN` is a growing fragment — and a session that
/// execs it in that window gets the failure this module's own comments describe from the other side:
/// a `bsc` that is 0 bytes and unrunnable. `source_is_plausible` guards the source and `verify_staged`
/// guards the result; neither can guard the destination DURING the copy.
///
/// So: copy into a temp file **in the destination's own directory** (same dir ⇒ same filesystem ⇒ the
/// rename cannot fail with `EXDEV`), then `rename` it onto `dst`. A rename is atomic — a reader sees
/// the whole old file or the whole new one, never a fragment — and on POSIX renaming over a binary
/// that is currently being EXECUTED is legal: the running process keeps its inode. Only truncating in
/// place would give `ETXTBSY`, which is what the old code risked.
///
/// The mode is set on the TEMP file before the rename, for the same reason: a copy carries the
/// source's mode, so a rename that published a 0644 file would publish something unrunnable.
///
/// ## Windows still needs the dance
///
/// `rename` there fails while the destination is open for execution, so the `.old-<stamp>` park-and-
/// replace fallback stays for exactly that case. It is a fallback now rather than the path, and on
/// POSIX it is unreachable.
fn stage_one(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    let dir = dst.parent().unwrap_or_else(|| std::path::Path::new("."));
    let tmp = dir.join(format!(
        ".{}.staging-{}",
        dst.file_name().and_then(|n| n.to_str()).unwrap_or("sidecar"),
        std::process::id()
    ));
    // A leftover from a killed run must never be mistaken for this one's work.
    let _ = std::fs::remove_file(&tmp);
    if let Err(e) = std::fs::copy(src, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    ensure_executable(&tmp);

    match std::fs::rename(&tmp, dst) {
        Ok(()) => return Ok(()),
        // Only the "in use" case earns the rename dance; a permissions/disk error should surface as-is
        // rather than leave a parked-away binary behind.
        Err(e) if !is_in_use(&e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        Err(_) => {}
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let parked = dst.with_extension(format!("old-{stamp}"));
    if let Err(e) = std::fs::rename(dst, &parked) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    match std::fs::rename(&tmp, dst) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Put it back — a missing sidecar is worse than a stale one.
            let _ = std::fs::rename(&parked, dst);
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn is_in_use(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(32) || e.kind() == std::io::ErrorKind::PermissionDenied
}

/// Assert that `dst` is actually a copy of `src`, by size. `Ok(())` or a reason to log.
///
/// Size, not a hash: the failure this exists to catch is a whole different BUILD sitting at the staged
/// path (49 MB against 74 MB, observed), and hashing 74 MB on every boot to catch a byte-level
/// corruption nobody has ever seen would be paying the boot path for the wrong risk.
fn verify_staged(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let sl = std::fs::metadata(src).map_err(|e| format!("source unreadable: {e}"))?.len();
    let dl = std::fs::metadata(dst).map_err(|e| format!("staged copy unreadable: {e}"))?.len();
    // MATCHING IS NOT ENOUGH. Two zero-byte files match perfectly, and that is exactly the state this
    // function reported as healthy on 2026-08-24. `source_is_plausible` refuses it earlier now; this is
    // the same question asked of the OUTCOME, so neither check depends on the other having run.
    if dl == 0 {
        return Err("the staged copy is 0 bytes — it cannot be executed".to_string());
    }
    if sl == dl {
        return Ok(());
    }
    Err(format!("source is {sl} bytes, staged copy is {dl}"))
}

/// True when staging `src` over `dst` would REPLACE A NEWER BINARY WITH AN OLDER ONE.
///
/// This is the guard for the failure the whole item is about. `stage_dev_sidecars` copies whatever
/// [`sidecar_candidates`] finds first, so booting the app from a tree whose `target/<profile>/bsc.exe`
/// is weeks old faithfully clobbers a good staged copy with that one. Observed 2026-08-16: the staged
/// `bsc` became a Jul 20 build of 46.8 MB while the workspace's was Aug 16 and 66.0 MB, and the only
/// symptom was `bsc: unknown command 'change'` in an agent session — a whole class of local-PR records
/// silently not written, which looks nothing like a staging problem.
///
/// mtime is the right comparison here even though it is a poor liveness signal elsewhere: on Windows
/// `fs::copy` uses `CopyFileExW`, which PRESERVES the source timestamp, so a staged copy carries the
/// mtime of the build it came from. Comparing the two is therefore comparing build times, not copy
/// times — and a genuine rebuild (including checking out an older branch and rebuilding) always
/// produces a NEWER source, so this never blocks a legitimate downgrade.
///
/// `None` for `dst` means nothing is staged yet, which can never be a downgrade.
/// Pure (takes the timestamps) so the rule is unit-testable without touching a filesystem.
fn staging_would_downgrade(src: std::time::SystemTime, dst: Option<std::time::SystemTime>) -> bool {
    dst.is_some_and(|staged| staged > src)
}

/// True when a sidecar built at `sidecar` predates the app built at `app` — meaning the app is running
/// against a sidecar from an OLDER build of the same workspace.
///
/// `bsc` and the app are built from one tree by one workflow, so the sidecar being older than the app
/// is never intentional. It is, however, easy to arrive at: cargo HARDLINKS `target/<profile>/bsc.exe`
/// to `target/<profile>/deps/bsc-<hash>.exe`, so which artifact that path resolves to shifts as builds
/// land, and with several worktrees building concurrently the one sitting there at boot can be weeks
/// old. Staging then faithfully copies the wrong thing.
///
/// Pure (takes the two timestamps) so the comparison is unit-testable without touching a filesystem.
fn sidecar_predates_app(sidecar: std::time::SystemTime, app: std::time::SystemTime) -> bool {
    sidecar < app
}

/// The sidecars that are OLDER than the running app exe, as `(name, how much older)`. Empty is the
/// healthy case. Called at boot by `app::run` so the mismatch is reported where someone reads it,
/// rather than surfacing later as an unknown-subcommand error in an agent session.
pub(crate) fn stale_sidecars() -> Vec<(&'static str, std::time::Duration)> {
    let Ok(app_exe) = std::env::current_exe() else { return Vec::new() };
    let Ok(app_at) = std::fs::metadata(&app_exe).and_then(|m| m.modified()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, path) in sidecar_status() {
        let Some(p) = path else { continue }; // missing is already reported, and louder
        let Ok(at) = std::fs::metadata(&p).and_then(|m| m.modified()) else { continue };
        if sidecar_predates_app(at, app_at) {
            out.push((name, app_at.duration_since(at).unwrap_or_default()));
        }
    }
    out
}

/// Drop `*.old-*` copies parked by an earlier [`stage_one`]. Best-effort: one still held by a live
/// session simply stays until the next boot, which is the point of parking it rather than deleting.
fn sweep_superseded(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.contains(".old-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ── Bundled host toolchain on the session PATH (#1277) ──────────────────────
//
// Unlike the `bsc-*` sidecars (exec'd by an absolute `$BSC_*_BIN` path, no PATH change), the host
// toolchain a session needs — `gh`, and on Windows a POSIX userland (`git` + `bash` + coreutils) —
// must be ON PATH so the tools find each other (`gh` shells out to `git`; the `bsc-*` rc helpers +
// `BASH_ENV` assume `cat`/`grep`/`sed`/`date`/… present). When we bundle those (issue #1277), we
// PREPEND/APPEND the bundled bin dirs to the session PATH.
//
// CRITICAL (additive-only): a bundled dir is added ONLY when it actually exists on disk. The `bsc`
// shim dir (#3159) follows the same gate — added ONLY when a `bsc` is bundled (`bsc_bin_path()`), which
// a real session always has and the test target never does. So with nothing staged AND no `bsc` (the
// test target), `session_path_prefix`/`session_path_suffix` are empty and `session_env` adds NO `PATH`
// entry at all — byte-identical to inheriting the parent PATH. A regression here breaks every session,
// so the disk gate is the whole safety story.
//
// Layout the resolvers expect (staged at release time; see `scripts/stage-sidecar.mjs`):
//   <exe_dir>/gh[.exe]                      — `gh` (Tauri externalBin stages sidecars beside the exe)
//   <exe_dir>/portable-git/{cmd,bin,usr/bin,mingw64/bin}   — trimmed PortableGit (Windows only)

/// Windows-only: the trimmed-PortableGit bin dirs to PREPEND to the session PATH, given the app exe
/// dir. Prepending makes the KNOWN-GOOD bundled `git`/`bash`/coreutils win over any system Git Bash
/// or the WSL `bash.exe` stub — the resolution policy for git/bash on Windows (correctness; kills the
/// #109 WSL/Git-Bash ambiguity). Pure (no fs); `session_path_prefix` applies `.exists()`. `windows`
/// is injected so the candidate ordering is unit-testable off-Windows.
fn portable_git_bin_candidates(exe_dir: &std::path::Path, windows: bool) -> Vec<std::path::PathBuf> {
    if !windows {
        return Vec::new(); // macOS/Linux use the system shell + coreutils — nothing bundled.
    }
    let pg = exe_dir.join("portable-git");
    vec![
        pg.join("cmd"),                    // git.exe (the primary git launcher)
        pg.join("mingw64").join("bin"),    // git core + libs
        pg.join("bin"),                    // bash.exe + a few core utils
        pg.join("usr").join("bin"),        // the full coreutils userland (cat/grep/sed/date/…)
    ]
}

/// The bundled `gh` binary's dir, to APPEND to the session PATH — a bundled `gh` is a FALLBACK, so a
/// user-installed `gh` earlier on PATH still wins (the resolution policy for `gh`, unlike git/bash).
/// `gh` is staged BESIDE the app exe by Tauri externalBin, so its dir is the exe dir. Returned only
/// when a bundled `gh` actually sits there, so we never gratuitously add the exe dir to PATH. Pure;
/// `windows` picks the `.exe` suffix.
fn bundled_gh_dir(exe_dir: &std::path::Path, windows: bool) -> Option<std::path::PathBuf> {
    let gh = exe_dir.join(if windows { "gh.exe" } else { "gh" });
    gh.exists().then(|| exe_dir.to_path_buf())
}

// ── The session-local `bsc` shim (#3159) ────────────────────────────────────────────────────────────
// In a session `bsc` is a bash FUNCTION (`bsc() { … "$BSC_BIN" "$@"; }`, console/shell_rc). A function
// lives only inside that shell — it is NOT on PATH and is NOT inherited by non-bash children, so a
// SUBPROCESS (`python subprocess.run("bsc")`, a `while read | cmd` pipe) can't find `bsc` and has to
// special-case the absolute `$BSC_BIN`. The shim is a tiny real executable named `bsc` on the SESSION's
// PATH that just forwards to `$BSC_BIN` (an env var, which children DO inherit), so a bare `bsc`
// resolves from subprocesses too. This is the agent's SANDBOX PATH — the user's OS PATH stays behind
// the consent-gated `PathExposeBanner` (#2734) and is never touched here.

/// POSIX shim (bash/sh subprocesses): exec the absolute `$BSC_BIN`, NEVER a bare `bsc` (that would
/// re-enter this shim). LF-only + a `#!/bin/sh` shebang. Guards an unset `$BSC_BIN` with the same 127
/// exit the `bsc()` shell helper uses.
const BSC_SHIM_SH: &str = "#!/bin/sh\n# base-studio-code session shim (#3159): forward `bsc` to the bundled binary so a bare `bsc`\n# resolves from subprocesses (a shell function isn't inherited). Sandbox PATH only; never the OS PATH.\nif [ -z \"${BSC_BIN:-}\" ]; then echo \"bsc: BSC_BIN is unset\" >&2; exit 127; fi\nexec \"$BSC_BIN\" \"$@\"\n";

/// Windows shim (native subprocesses resolve `bsc` → `bsc.cmd` via PATHEXT). CRLF; forwards to
/// `%BSC_BIN%`. The message avoids parens so it needn't be escaped inside the `if (...)` block.
const BSC_SHIM_CMD: &str = "@echo off\r\nrem base-studio-code session shim (#3159): forward `bsc` to %BSC_BIN% for subprocesses.\r\nif \"%BSC_BIN%\"==\"\" ( echo bsc: BSC_BIN is unset 1>&2 & exit /b 127 )\r\n\"%BSC_BIN%\" %*\r\n";

/// The shim files to stage: a POSIX `bsc` everywhere, plus a `bsc.cmd` on Windows (native subprocesses
/// resolve the `.cmd` via PATHEXT; git-bash subprocesses use the POSIX `bsc`). Pure — for testing.
fn bsc_shim_files(windows: bool) -> Vec<(&'static str, &'static str)> {
    let mut files = vec![("bsc", BSC_SHIM_SH)];
    if windows {
        files.push(("bsc.cmd", BSC_SHIM_CMD));
    }
    files
}

/// Stage the `bsc` shim into `<base>/shim` and return that dir — but ONLY when a real `bsc` is bundled
/// (`bsc_bin_path().is_some()`), since the shim has nothing to forward to otherwise. Idempotent (writes
/// only on a content change, so it doesn't churn every session). `None` ⇒ no bundled `bsc` or a write
/// failure ⇒ the shim dir is not added to PATH (disk-gated, like the bundled-toolchain folding).
fn session_shim_dir() -> Option<std::path::PathBuf> {
    bsc_bin_path()?; // no bundled bsc → nothing to forward to → no shim
    let dir = bsc_base_dir().join("shim");
    std::fs::create_dir_all(&dir).ok()?;
    for (name, body) in bsc_shim_files(cfg!(windows)) {
        let path = dir.join(name);
        let stale = std::fs::read(&path).map(|b| b != body.as_bytes()).unwrap_or(true);
        if stale && std::fs::write(&path, body).is_err() {
            return None;
        }
        #[cfg(unix)]
        if !name.ends_with(".cmd") {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }
    }
    Some(dir)
}

/// The existing bundled dirs to PREPEND to a session PATH: the `bsc` shim (#3159) — so a bare `bsc`
/// resolves from subprocesses — then Windows PortableGit. Disk-gated: each dir is added only when it
/// actually exists (the shim only when a `bsc` is bundled), so a bundle-less/test session adds neither.
fn session_path_prefix() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Some(shim) = session_shim_dir() {
        dirs.push(shim); // the bsc shim wins for a bare `bsc`
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        dirs.extend(
            portable_git_bin_candidates(&exe_dir, cfg!(windows))
                .into_iter()
                .filter(|p| p.is_dir()),
        );
    }
    dirs
}

/// The existing bundled dirs to APPEND to a session PATH (a bundled `gh`, as a fallback), or empty.
fn session_path_suffix() -> Vec<std::path::PathBuf> {
    let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()))
    else {
        return Vec::new();
    };
    bundled_gh_dir(&exe_dir, cfg!(windows)).into_iter().collect()
}

/// Compose a session `PATH` value from `prefix` (winning) dirs + the inherited `base` + `suffix`
/// (fallback) dirs, joined by the platform separator and de-duplicated (first occurrence wins).
/// Returns `None` when there's nothing to add (`prefix` AND `suffix` empty) — the signal for the
/// caller to leave `PATH` untouched, so a no-bundle session inherits the parent PATH unchanged. Pure
/// + testable; `sep` is injected (`;` on Windows, `:` elsewhere).
fn compose_path(
    prefix: &[std::path::PathBuf],
    base: Option<&str>,
    suffix: &[std::path::PathBuf],
    sep: char,
) -> Option<String> {
    if prefix.is_empty() && suffix.is_empty() {
        return None; // nothing bundled → don't touch PATH (byte-identical to inheriting it)
    }
    let mut parts: Vec<String> = Vec::new();
    let push = |s: String, parts: &mut Vec<String>| {
        if !s.is_empty() && !parts.iter().any(|p| p == &s) {
            parts.push(s);
        }
    };
    for p in prefix {
        push(p.to_string_lossy().into_owned(), &mut parts);
    }
    if let Some(b) = base {
        for seg in b.split(sep) {
            push(seg.to_string(), &mut parts);
        }
    }
    for p in suffix {
        push(p.to_string_lossy().into_owned(), &mut parts);
    }
    Some(parts.join(&sep.to_string()))
}

/// Build the environment for a session shell.
///
/// The embedded xterm is a full xterm-256color terminal, but `TERM`/`COLORTERM`
/// were previously never set on the spawned shell — so `claude` (and other TUIs)
/// could fall back to a degraded terminal type, breaking inline features like the
/// ghost-text autocomplete and truecolor output. We advertise sensible defaults
/// here; caller-supplied vars (e.g. `GH_TOKEN`, or an explicit `TERM`) win.
///
/// When a bundled host toolchain is staged on disk (#1277), its bin dirs are folded into `PATH`
/// (bundled git/bash prepended, bundled `gh` appended as a fallback). With no bundle present — every
/// build today and dev — NO `PATH` entry is added, so behavior is byte-identical to inheriting the
/// parent PATH. The added `PATH` is applied like any other var: a caller-supplied `PATH` becomes the
/// base the bundled dirs wrap.
pub(crate) fn session_env(caller: &HashMap<String, String>) -> Vec<(String, String)> {
    // The bundled toolchain dirs are PROBED here — disk-reading, and `session_shim_dir` may CREATE the
    // shim under `~/.base-studio-code`. The pure env assembly is `session_env_with`, so a test injects
    // its own bundle premise (`&[]` = no bundle) instead of consulting — and mutating — the real home
    // (#3271: the old test's "no bundle" premise silently broke the moment `bsc` was resolvable).
    session_env_with(caller, &session_path_prefix(), &session_path_suffix())
}

/// Assemble a session shell environment given the ALREADY-PROBED bundled `prefix`/`suffix` dirs. The
/// PATH is folded in ONLY when a bundle is staged (`prefix`|`suffix` non-empty) — the #1277 additive-only
/// guarantee: an empty bundle leaves `PATH` untouched (byte-identical to inheriting it). It reads the
/// ambient `PATH` only as the fold base, and only when a bundle would use it — so a test states its own
/// premise deterministically with `session_env_with(caller, &[], &[])`, touching no real state.
fn session_env_with(
    caller: &HashMap<String, String>,
    prefix: &[std::path::PathBuf],
    suffix: &[std::path::PathBuf],
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ];
    for (k, v) in caller {
        if let Some(slot) = env.iter_mut().find(|(ek, _)| ek == k) {
            slot.1 = v.clone(); // caller overrides a default
        } else {
            env.push((k.clone(), v.clone()));
        }
    }
    // Fold the bundled host toolchain into PATH — additive-only: nothing is added unless a bundle dir is
    // present. The base is any caller PATH, else the app's inherited PATH.
    let caller_path = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone());
    let owned_env = caller_path.is_none().then(|| std::env::var("PATH").ok()).flatten();
    let base = caller_path.as_deref().or(owned_env.as_deref());
    let sep = if cfg!(windows) { ';' } else { ':' };
    if let Some(path) = compose_path(prefix, base, suffix, sep) {
        match env.iter_mut().find(|(k, _)| k == "PATH") {
            Some(slot) => slot.1 = path,
            None => env.push(("PATH".to_string(), path)),
        }
    }
    env
}

/// The per-project session skill group id for a pane, or None for non-planner panes (#1419). Only
/// the planner pane (`planning_<key>`) authors session skills, so only it gets `BSC_SESSION_SKILL_GROUP`
/// — workers/director/manual panes don't. The id is deterministic from the (already-sanitized) key so
/// the Planning pane and the `bsc skill` CLI resolve the same group. Pure for testing.
pub(crate) fn session_skill_group_for_pane(pane_id: &str) -> Option<String> {
    pane_id.strip_prefix("planning_").map(|key| format!("grp-session-{key}"))
}

/// Wire the per-session `BSC_*` environment the `bsc-*` shell helpers read into `cmd`, and write the
/// rc file that defines them. Covers: the triage checkpoint doc, the `BASH_ENV` rc (which installs the
/// helpers into the agent's non-interactive `bash -c` subshells), the app-wide analytics logs
/// (audit / skill / hook / mcp / tokens / activity / done / coord), the FS-confinement repo root,
/// the per-project plan + data stores and their CLIs, the global skills store + CLI, the planner's
/// per-project session skill group, and the `bsc-agent` sidecar + per-cwd session file. `cwd` is the
/// already-native session cwd; `pane_id` tags the logs; `provider_id` gates the bsc-agent vars.
///
/// Returns the bash-style path of the rc file so the caller can `source` it into the interactive
/// shell too (BASH_ENV only covers non-interactive subshells).
/// The per-project store exports, as a bash fragment to run INSIDE the session's shell.
///
/// WHY, when `wire_bsc_env` already sets these on the spawned process: the PTY runs an INTERACTIVE
/// bash, and an interactive bash sources `~/.bashrc` — which runs AFTER the process env is handed over
/// and can re-export the very same names. This repo's own dev workflow tells a developer to
/// `export BSC_PLAN_DB=.../studio-code.db`, so a machine that followed the docs pointed EVERY session
/// at studio-code's plan store: `pain-point-finder`'s director read — and could write — another
/// project's board, which is how this was found. `#request-128` fixed the INHERITANCE half (a miss now
/// clears the var rather than letting it ride); this is the OVERRIDE half.
///
/// The caller emits it AFTER sourcing the bsc rc into the interactive shell, so the app's per-session
/// answer is the last word. Order is the entire fix. The sandbox path already bakes its env into that
/// line for the same reason (the host rc does not cross the WSL boundary).
///
/// A NON-PROJECT session UNSETS them rather than keeping whatever it inherited: a console opened in an
/// unrelated repo must not silently read or write some project's store, and `bsc plan` failing loudly
/// is the honest outcome.
pub(super) fn store_exports_for_cwd(cwd: &str) -> String {
    let vars = [
        ("BSC_PLAN_DB", plan_db_for_cwd(cwd)),
        ("BSC_ERROR_DB", error_db_for_cwd(cwd)),
        ("BSC_USAGE_DB", usage_db_for_cwd(cwd)),
        ("BSC_DATA_DB", data_db_for_cwd(cwd)),
    ];
    let mut out = String::new();
    for (name, path) in vars {
        match path {
            // Single-quoted: the path is app-derived, never user text, and quoting keeps a space in a
            // home directory from splitting the export into two words.
            Some(p) => out.push_str(&format!("export {name}='{}'; ", to_bash_path(&p.to_string_lossy()))),
            None => out.push_str(&format!("unset {name}; ")),
        }
    }
    out
}

pub(super) fn wire_bsc_env(
    cmd: &mut CommandBuilder,
    pane_id: &str,
    cwd: &str,
    checkpoint_doc: Option<&str>,
    provider_id: Option<&str>,
) -> String {
    // Install the bsc-* shell helpers via an rc file pointed to by BASH_ENV (so the
    // agent's non-interactive `bash -c` subshells get them) and sourced into the
    // interactive shell by the caller. The rc is universal — bsc-checkpoint (triage) and
    // bsc-note (the fleet's assume-and-log journal) cost nothing in sessions that
    // don't use them. Per-session doc paths the helpers read are exposed as env
    // vars when applicable; bsc-note defaults to a DECISIONS.md in cwd.
    let base = bsc_base_dir();
    let _ = std::fs::create_dir_all(&base);
    // Expose the triage checkpoint doc (resolved to an absolute, bash-style path) so the
    // `bsc-checkpoint` helper can write "where we left off" to it. The helper itself is installed via
    // the rc below; it must be reachable from the agent's OWN bash subprocesses (Claude's Bash tool
    // runs a non-interactive `bash -c`, which sources BASH_ENV at startup), and the hyphenated name
    // can't be `export -f`'d (bash won't import non-identifier function names).
    if let Some(rel) = checkpoint_doc.filter(|s| !s.is_empty()) {
        let abs = base.join(rel);
        cmd.env("BSC_CHECKPOINT_DOC", to_bash_path(&abs.to_string_lossy()));
    }
    let rc = base.join("bsc-env.sh");
    let _ = std::fs::write(&rc, bsc_rc_body());
    let rc_bash = to_bash_path(&rc.to_string_lossy());
    cmd.env("BASH_ENV", &rc_bash);
    // Shared package-manager caches/stores so the fleet's per-repo worktrees don't each keep a full
    // copy of node_modules / target/ (#worktree-disk). App-native, every package manager; NATIVE OS
    // paths (read by cargo/npm/etc., not the bash shell). A no-op for non-worktree sessions.
    for (k, v) in crate::platform::pkgcache::package_cache_env(&base, cwd) {
        cmd.env(k, v);
    }
    // Observability log streams (#1847): every per-pane TSV a `bsc-*` hook appends to is a row in the
    // canonical `bsc_util::LOG_STREAMS` registry — the ONE list shared with the unified `bsc logs`
    // reader (`crates/logs`); each row's doc comment is the stream's spec (which hook writes it + the
    // line shape). Point each `$BSC_*_LOG` at the app-wide file under `base`; setting them for every
    // pane is harmless (only a pane whose settings.json installs the hook actually writes). `pane_id`
    // is the id every line is tagged with (via `$BSC_AUDIT_PANE`).
    cmd.env("BSC_AUDIT_PANE", pane_id);
    for s in bsc_util::LOG_STREAMS {
        cmd.env(s.env_var, to_bash_path(&base.join(s.filename).to_string_lossy()));
    }
    // bsc logs (#1716): point every session at the log directory the unified `bsc logs` query CLI
    // reads (the `logs::log_dir` resolver honors $BSC_LOG_DIR, else `~/.base-studio-code`). It's the
    // same `base` dir that holds all the *_LOG TSVs above + `perf.db`, so a live agent can drill into
    // its own audit/coord/tokens/perf streams from its own shell. Set for every pane (read-only).
    cmd.env("BSC_LOG_DIR", to_bash_path(&base.to_string_lossy()));
    // FS confinement (#158): the session's repo root (bash-style), against which the
    // `bsc-confine` hook (installed on gated panes) checks file-tool paths. The cwd is
    // the repo root. Set for every pane; only gated panes install the hook.
    if !cwd.is_empty() {
        cmd.env("BSC_REPO_ROOT", to_bash_path(cwd));
        // #4084 — the session's OWN agent-harness state dir, which lives OUTSIDE the repo root by
        // construction and was therefore confined away from the session it belongs to. Every agent had
        // memory silently disabled: the read was refused and the session carried on without it (15
        // blocks across 11 sessions in one perm.log, plus 12 on `tool-results/`).
        //
        // Scoped to THIS session's directory, never the whole `projects/` tree — the broad version is
        // shorter and lets any agent read every other project's memory and transcripts.
        if let Some(dir) = agent_state_dir(cwd) {
            cmd.env("BSC_AGENT_STATE_DIR", to_bash_path(&dir.to_string_lossy()));
        }
    }
    // bsc plan (#plan-db): point this session at its project's canonical plan store. $BSC_PLAN_DB is
    // the plan.db the `bsc plan` subcommand reads/writes (the unified `bsc` binary is staged once as
    // $BSC_BIN below — no per-CLI binary). The DB is derived from the cwd — every project session runs
    // under `~/.base-studio-code/projects/<key>/...` (the director/planner at the hub, workers in a
    // worktree beneath it) — so the whole fleet shares one plan.db. Non-project sessions (a plain
    // console in some repo) get no BSC_PLAN_DB and never call `bsc plan`.
    //
    // The `else` is not defensive dressing (#request-128): `CommandBuilder` seeds every spawned command
    // from the APP PROCESS's own ambient environment (portable_pty's `get_base_env` = `vars_os()`), and
    // nothing here ever clears it. So `cmd.env(...)` only runs when `cwd` resolves — if it does not, the
    // line above is silently skipped and `BSC_PLAN_DB` is left at whatever the app's own launching shell
    // happened to export (this repo's own dev workflow, above, tells a developer to
    // `export BSC_PLAN_DB=.../studio-code.db` — exactly the kind of value that leaked into a director
    // session for an unrelated project, #request-128). A session scoped to ONE project must never
    // silently read or write a DIFFERENT project's store, so a miss clears the var explicitly instead of
    // leaving it to inherit — turning "wrong project's plan.db used, silently" into "no BSC_PLAN_DB, `bsc
    // plan` fails loudly," which is the behavior every doc comment on this function already claims.
    match plan_db_for_cwd(cwd) {
        Some(db) => cmd.env("BSC_PLAN_DB", to_bash_path(&db.to_string_lossy())),
        None => cmd.env_remove("BSC_PLAN_DB"),
    }
    // The studio scratch dir (#3373): where a restricted studio session stages a payload it then applies
    // with `bsc <store> set --file <name>` — the only authoring channel that is both allow-listable
    // (single line) and unbounded, since a heredoc's newlines parse as separate, unmatchable commands.
    //
    // CLEARED ON EVERY LAUNCH, which is what makes it scratch: a stale payload can never be re-applied
    // by a later session, and nothing accumulates on disk across restarts. A clear/create failure is NOT
    // fatal — the session still launches and `bsc … --file` simply refuses (it fails closed on a missing
    // dir), which is strictly better than blocking the session on a scratch dir it may never use.
    if let Some(scratch) = scratch_dir_for_cwd(cwd) {
        let _ = std::fs::remove_dir_all(&scratch);
        match std::fs::create_dir_all(&scratch) {
            Ok(()) => { cmd.env("BSC_SCRATCH", to_bash_path(&scratch.to_string_lossy())); }
            Err(e) => log::warn!("scratch dir {} unavailable ({e}); --file will refuse", scratch.display()),
        }
    }
    // The studio shot dir (#3468): `bsc shot` otherwise writes to ~/.base-studio-code/shots, a SIBLING
    // of this session's confinement root ($BSC_REPO_ROOT = cwd) — and `bsc-confine` matches `Read`, so
    // the session could take a shot and then be blocked from opening it. Point the shots inside the
    // workspace rather than widening the cage. Studio panes only; every other caller (and the app
    // itself) keeps the global default, since nothing else sets this var.
    //
    // NOT cleared on launch, unlike scratch: a shot is evidence the loop refers back to across turns,
    // so wiping it would destroy the very record the designer is meant to compare against. A create
    // failure is non-fatal — `bsc shot` falls back to its global dir, which is today's behaviour.
    if let Some(shots) = shot_dir_for_cwd(cwd) {
        match std::fs::create_dir_all(&shots) {
            Ok(()) => { cmd.env("BSC_SHOT_DIR", to_bash_path(&shots.to_string_lossy())); }
            Err(e) => log::warn!("shot dir {} unavailable ({e}); shots fall back to the global dir", shots.display()),
        }
    }
    // bsc errors (#2260): point this session at its project's runtime-fault store. $BSC_ERROR_DB is the
    // error.db the `bsc errors` subcommand reads/writes — cwd-derived exactly like BSC_PLAN_DB, so the
    // whole fleet shares one error.db per project; a non-project session gets none and never calls it.
    // Cleared, not left, on a miss — same #request-128 reasoning as BSC_PLAN_DB above.
    match error_db_for_cwd(cwd) {
        Some(db) => cmd.env("BSC_ERROR_DB", to_bash_path(&db.to_string_lossy())),
        None => cmd.env_remove("BSC_ERROR_DB"),
    }
    // bsc usage (#3812, epic #3809): point this session at its project's usage-events store, cwd-derived
    // exactly like BSC_ERROR_DB — a running/generated app records usage, an agent reads via `bsc usage`.
    match usage_db_for_cwd(cwd) {
        Some(db) => cmd.env("BSC_USAGE_DB", to_bash_path(&db.to_string_lossy())),
        None => cmd.env_remove("BSC_USAGE_DB"),
    }
    // Runtime-fault instrumentation (#2262): surface the durable per-project ingest token + the
    // collector's loopback port so a session that (re)generates the fault shim can bake them in. The
    // token lives in the hub (read-only here — minted at generation via `collector_info`); the port is
    // written by the collector at boot. Both optional: absent until a project is generated / the
    // collector is up, so a non-project session (or a pre-generation one) simply gets neither. NATIVE
    // values (a bare port + hex token the shim substitutes), not bash paths.
    if let Some(key) = project_key_from_cwd(cwd) {
        if let Ok(tok) = std::fs::read_to_string(crate::ingest_token_path(&key.to_string_lossy())) {
            let tok = tok.trim();
            if !tok.is_empty() {
                cmd.env("BSC_INGEST_TOKEN", tok);
            }
        }
    }
    if let Ok(port) = std::fs::read_to_string(crate::ingest_port_file()) {
        let port = port.trim();
        if !port.is_empty() && port != "0" {
            cmd.env("BSC_INGEST_PORT", port);
        }
    }
    // bsc skill (#1338, B-global): point EVERY session at the one GLOBAL skills.db so a group authored
    // anywhere is reachable + resolvable from any live session's own shell. $BSC_SKILL_DB is the shared
    // store the `bsc skill` subcommand reads/writes (a no-arg `bsc-skill` fire stays the #406 telemetry
    // hook). Unlike BSC_PLAN_DB (per-project, cwd-derived), this is global — set for every pane.
    cmd.env("BSC_SKILL_DB", to_bash_path(&base.join("skills.db").to_string_lossy()));
    // (The `bsc todo` surface + its $BSC_TODO_DB were removed in #3278 — the local-first consolidation
    // onto the one `bsc plan` issue surface.)
    // bsc data (#1446): the project's per-project DuckDB data store — the canonical Data Model +
    // PlatformScan the planner reads at the UI-kickoff stage via `bsc data`. $BSC_DATA_DB is the
    // project's .duckdb (cwd-derived, like BSC_PLAN_DB). Cleared, not left, on a miss (#request-128).
    match data_db_for_cwd(cwd) {
        Some(db) => cmd.env("BSC_DATA_DB", to_bash_path(&db.to_string_lossy())),
        None => cmd.env_remove("BSC_DATA_DB"),
    }
    // bsc compliance (#1718): point every session at the GLOBAL compliance standards store.
    // $BSC_COMPLIANCE_STORE is the store.db the `bsc compliance` subcommand reads/writes (and which the
    // bundled `bsc mcp compliance` server reads — same `Store::default_path` default). Unlike
    // BSC_PLAN_DB (per-project, cwd-derived), the corpus is global — set for every pane, so any live
    // session can inspect/refresh the standards from its own shell.
    cmd.env(
        "BSC_COMPLIANCE_STORE",
        to_bash_path(&base.join("compliance").join("store.db").to_string_lossy()),
    );
    // The unified `bsc` binary (#1877): every `bsc <sub>` state CLI a session runs (`bsc plan …`,
    // `bsc skill …`, `bsc logs …`, …) resolves through ONE staged binary in $BSC_BIN — the absolute,
    // bash-style path of the bundled umbrella (no PATH changes, no copies; the `bsc` shell helper falls
    // back to a PATH lookup when $BSC_BIN is unset, e.g. in the test target where the sidecar isn't
    // present). The per-CLI store/db vars above (BSC_PLAN_DB / BSC_DATA_DB / BSC_SKILL_DB /
    // BSC_COMPLIANCE_STORE / BSC_LOG_DIR) stay separate — the subcommands still read them — but the
    // binary path is now ONE var, not eight.
    if let Some(bin) = bsc_bin_path() {
        cmd.env("BSC_BIN", to_bash_path(&bin.to_string_lossy()));
    }
    // The model-agnostic agent runtime stays its OWN separate binary in $BSC_AGENT_BIN (#1877): a
    // bsc-agent session relaunches it, and the `bsc-agent` shell helper execs it by this path.
    if let Some(bin) = sidecar_bin_path("bsc-agent") {
        cmd.env("BSC_AGENT_BIN", to_bash_path(&bin.to_string_lossy()));
    }
    // The planner's per-project session skill group (#1419): only the planner pane (`planning_<key>`)
    // gets it. Skills the planner authors with `bsc skill add --group "$BSC_SESSION_SKILL_GROUP"` join
    // this group, which the Planning pane resolves + highlights as "authored this session". The id is
    // deterministic from the (already-sanitized) key so the pane and the CLI agree; the app names the
    // group after the project. Persistent — reopening the planner keeps collecting into it.
    if let Some(group) = session_skill_group_for_pane(pane_id) {
        cmd.env("BSC_SESSION_SKILL_GROUP", group);
    }
    // bsc-agent resume (#1144): hand the sidecar the per-cwd conversation file so it persists the
    // conversation (and, with --continue, resumes it). The app owns the keying; the sidecar just
    // reads/writes this native path via std::fs. Only meaningful for bsc-agent panes.
    if provider_id == Some("bsc-agent") {
        // Hand the runtime the SAME real bash the session shell uses (Git Bash on Windows), so its
        // `bash` tool never falls through to `Command::new("bash")` → the WSL launcher
        // (System32\bash.exe), which fails `execvpe(/bin/bash)` with no WSL distro. `resolve_shell`
        // already locates Git Bash and avoids that stub.
        cmd.env("BSC_AGENT_BASH", crate::platform::shell::resolve_shell());
        if let Some(p) = crate::bsc_agent_session_path(cwd) {
            cmd.env("BSC_AGENT_SESSION", p.to_string_lossy().into_owned());
        }
    }
    rc_bash
}

#[cfg(test)]
mod swap_tests {
    use super::{ensure_executable, sidecar_predates_app, source_is_plausible, staging_would_downgrade, verify_staged};
    use std::time::{Duration, SystemTime};

    /// Which errors earn the rename-aside dance in [`super::stage_one`].
    ///
    /// This classification is what makes re-staging survive a LIVE session: the staged copy exists
    /// precisely so long-running `bsc mcp` servers lock IT rather than the build output, and on
    /// Windows `fs::copy` cannot overwrite a file another process holds open. Getting the
    /// classification wrong in the permissive direction would rename away a binary over a genuine
    /// permissions or disk error, leaving no sidecar at all — worse than a stale one.
    ///
    /// The locked path itself is not unit-testable without holding a real OS handle from another
    /// process, so what is pinned here is the DECISION. The end-to-end behaviour was exercised by
    /// hand on 2026-08-16 with five live `bsc.exe` processes: renaming the staged binary aside and
    /// copying a fresh one in place succeeded, and the running servers kept their old inode.
    #[test]
    fn only_an_in_use_error_earns_the_rename_dance() {
        use std::io::{Error, ErrorKind};
        // ERROR_SHARING_VIOLATION — the actual Windows code for "another process has it open".
        assert!(super::is_in_use(&Error::from_raw_os_error(32)));
        assert!(super::is_in_use(&Error::from(ErrorKind::PermissionDenied)));
        // A missing source or a full disk must surface as-is, NOT trigger a rename.
        assert!(!super::is_in_use(&Error::from(ErrorKind::NotFound)));
        assert!(!super::is_in_use(&Error::from(ErrorKind::UnexpectedEof)));
    }

    /// The PREVENTION half of this item. `verify_staged` and `stale_sidecars` both report the damage
    /// after it is done; only this refuses to do it.
    ///
    /// The scenario is the one that actually happened: the app boots from a tree whose
    /// `target/<profile>/bsc.exe` is weeks old (cargo hardlinks that path to a `deps/bsc-<hash>.exe`
    /// that shifts as builds land, and with several worktrees building concurrently the one sitting
    /// there can be from July), and staging faithfully copies it over a good August build.
    #[test]
    fn staging_refuses_to_replace_a_newer_binary_with_an_older_one() {
        let july = SystemTime::UNIX_EPOCH + Duration::from_secs(1_753_000_000);
        let august = july + Duration::from_secs(27 * 86_400);

        // The incident: a July source over an August staged copy.
        assert!(staging_would_downgrade(july, Some(august)), "must refuse to stage backwards");

        // The normal case: a fresh build replaces an older staged copy.
        assert!(!staging_would_downgrade(august, Some(july)), "a newer build must stage");

        // Nothing staged yet can never be a downgrade — a first run must always stage.
        assert!(!staging_would_downgrade(july, None), "an absent staged copy must stage");

        // Identical timestamps are the same build; staging is a no-op either way, and NOT refusing
        // keeps `verify_staged` in the loop to catch a same-mtime-different-build case.
        assert!(!staging_would_downgrade(july, Some(july)), "an equal timestamp is not a downgrade");
    }

    /// The regression this whole slice exists for. Observed 2026-08-16: staging logged SUCCESS while
    /// the staged `bsc` was a Jul 20 build of 49,027,584 bytes and the source was 74,270,208 — and the
    /// only symptom, weeks later, was `bsc: unknown command 'change'` inside an agent session. A
    /// successful `fs::copy` is not evidence the staged binary matches; the sizes are.
    /// 2026-08-24: both staged sidecars were 0 bytes and `-rw-rw-r--`, and every `bsc` call from every
    /// session failed `Permission denied` until they were replaced by hand. Staging had logged SUCCESS,
    /// because `verify_staged` asks whether the copy MATCHES the source — and two empty files match.
    #[test]
    fn a_truncated_source_is_refused_rather_than_staged_over_a_working_binary() {
        let dir = crate::testutil::unique_dir("bsc-stage", "truncated");
        std::fs::create_dir_all(&dir).unwrap();

        // The shape cargo leaves mid-link: the path EXISTS, so `p.exists()` picks it, and it is empty.
        let empty = dir.join("empty.bin");
        std::fs::write(&empty, b"").unwrap();
        let why = source_is_plausible(&empty).expect_err("a 0-byte source must be refused");
        assert!(why.contains("0 bytes"), "the reason names the shape: {why}");

        // A real artifact passes — the guard must not refuse the ordinary case.
        let real = dir.join("real.bin");
        std::fs::write(&real, vec![0u8; 4096]).unwrap();
        assert!(source_is_plausible(&real).is_ok());
        assert!(source_is_plausible(&dir.join("absent.bin")).is_err(), "a missing source is not plausible");
        assert!(source_is_plausible(&dir).is_err(), "a directory is not a binary");

        // And the OUTCOME is judged on its own: two empty files match perfectly, which is precisely the
        // state that was reported healthy. `verify_staged` must refuse it without relying on the
        // earlier check having run.
        let dst = dir.join("dst.bin");
        std::fs::write(&dst, b"").unwrap();
        let err = verify_staged(&empty, &dst).expect_err("0 == 0 is not a healthy stage");
        assert!(err.contains("0 bytes"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The second half of what was observed: not just empty, but NOT EXECUTABLE. `fs::copy` carries the
    /// source's mode, so a build artifact caught at 0644 lands unrunnable even when its bytes are right.
    #[cfg(unix)]
    #[test]
    fn a_staged_sidecar_is_made_executable_whatever_mode_the_source_carried() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::testutil::unique_dir("bsc-stage", "mode");
        std::fs::create_dir_all(&dir).unwrap();
        let dst = dir.join("bsc");
        std::fs::write(&dst, vec![0u8; 64]).unwrap();
        std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o644)).unwrap();

        ensure_executable(&dst);
        let mode = std::fs::metadata(&dst).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "every exec bit is set, not just the owner's: {mode:o}");

        // Idempotent — an already-executable file is left exactly as it is.
        std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_executable(&dst);
        assert_eq!(std::fs::metadata(&dst).unwrap().permissions().mode() & 0o777, 0o755);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_staged_rejects_a_different_build_at_the_staged_path() {
        let dir = std::env::temp_dir().join(format!("bsc-stage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        let dst = dir.join("dst.bin");

        std::fs::write(&src, vec![0u8; 512]).unwrap();
        std::fs::write(&dst, vec![0u8; 512]).unwrap();
        assert!(verify_staged(&src, &dst).is_ok(), "identical sizes are the healthy case");

        // The observed shape: a whole different build sitting at the staged path.
        std::fs::write(&dst, vec![0u8; 128]).unwrap();
        let err = verify_staged(&src, &dst).expect_err("a size mismatch must be reported");
        assert!(err.contains("512") && err.contains("128"), "the reason must name both sizes: {err}");

        // A missing file is a reason, never a silent pass — the failure mode being fixed is silence.
        std::fs::remove_file(&dst).unwrap();
        assert!(verify_staged(&src, &dst).is_err(), "an unreadable staged copy is not OK");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PRESENT is not CURRENT. `bsc` and the app come from one tree by one workflow, so a sidecar older
    /// than the app is never intentional — but cargo hardlinks `target/<profile>/bsc.exe` to a
    /// `deps/bsc-<hash>.exe`, so with several worktrees building concurrently the artifact sitting there
    /// at boot can be weeks old, and staging copies it faithfully.
    #[test]
    fn a_sidecar_older_than_the_app_is_stale() {
        let app = SystemTime::UNIX_EPOCH + Duration::from_secs(1_760_000_000);
        let older = app - Duration::from_secs(27 * 24 * 3600); // the ~27 days actually observed
        let newer = app + Duration::from_secs(60);

        assert!(sidecar_predates_app(older, app), "a sidecar built before the app is stale");
        assert!(!sidecar_predates_app(newer, app), "a sidecar built after the app is fine");
        // Equal timestamps are the normal case for one build step producing both — never flag it.
        assert!(!sidecar_predates_app(app, app), "same-build timestamps must not be reported stale");
    }
}

#[cfg(test)]
mod tests {
    /// #4084 — the slug must match the harness's own, or `$BSC_AGENT_STATE_DIR` points at a directory
    /// that does not exist and memory stays broken while LOOKING fixed. These three are the REAL
    /// on-disk directory names for a studio session, a fleet worker, and this repo.
    #[test]
    fn agent_state_dir_derives_the_harness_slug() {
        let cases = [
            (r"C:\Users\Kevin\.base-studio-code\design-studio", "C--Users-Kevin--base-studio-code-design-studio"),
            (
                r"C:\Users\Kevin\.base-studio-code\projects\network-monitor\networkmonitor",
                "C--Users-Kevin--base-studio-code-projects-network-monitor-networkmonitor",
            ),
            (r"C:\Users\Kevin\Projects\rust\base-studio-code", "C--Users-Kevin-Projects-rust-base-studio-code"),
        ];
        for (cwd, want) in cases {
            let got = super::agent_state_dir(cwd).expect("home dir resolves in tests");
            assert_eq!(got.file_name().unwrap().to_string_lossy(), want, "slug for {cwd}");
            assert!(got.to_string_lossy().replace('\\', "/").contains("/.claude/projects/"), "{got:?}");
        }
        // Forward slashes reach the same directory — the cwd arrives bash-form on some paths.
        assert_eq!(
            super::agent_state_dir("C:/Users/Kevin/Projects/rust/base-studio-code").unwrap().file_name().unwrap(),
            super::agent_state_dir(r"C:\Users\Kevin\Projects\rust\base-studio-code").unwrap().file_name().unwrap(),
        );
    }

    /// An empty cwd yields None, so `$BSC_AGENT_STATE_DIR` is simply never set and the confinement
    /// behaves exactly as it did before (the hook treats an unset var as "no exemption").
    #[test]
    fn agent_state_dir_is_none_without_a_cwd() {
        assert!(super::agent_state_dir("").is_none());
        assert!(super::agent_state_dir("   ").is_none());
    }

    use super::{
        bsc_shim_files, bundled_gh_dir, compose_path, data_db_for_cwd, error_db_for_cwd,
        is_build_output, plan_db_for_cwd, usage_db_for_cwd,
        portable_git_bin_candidates, scratch_dir_for_cwd, session_env_with, shot_dir_for_cwd,
        session_skill_group_for_pane, sidecar_candidates, staged_sidecar_dir, BSC_SHIM_CMD,
        BSC_SHIM_SH,
        // #3959 — the rename-then-copy staging path.
        is_in_use, stage_one, sweep_superseded,
    };
    use crate::bsc_base_dir;
    use std::collections::HashMap;
    use std::path::PathBuf;

    #[test]
    fn portable_git_candidates_are_windows_only_and_ordered() {
        // Off Windows: nothing bundled — the system shell + coreutils are used.
        assert!(portable_git_bin_candidates(&PathBuf::from("/opt/app"), false).is_empty());
        // On Windows: the trimmed-PortableGit bin dirs, in resolution order (cmd → mingw64 → bin → usr).
        let exe = PathBuf::from(r"C:\app");
        let c = portable_git_bin_candidates(&exe, true);
        assert_eq!(
            c,
            vec![
                exe.join("portable-git").join("cmd"),
                exe.join("portable-git").join("mingw64").join("bin"),
                exe.join("portable-git").join("bin"),
                exe.join("portable-git").join("usr").join("bin"),
            ],
        );
    }

    #[test]
    fn bundled_gh_dir_only_resolves_when_gh_is_staged_beside_the_exe() {
        // A dir with no bundled gh → None (we never gratuitously add the exe dir to PATH).
        let empty = std::env::temp_dir().join("bsc-1277-no-gh");
        let _ = std::fs::create_dir_all(&empty);
        assert_eq!(bundled_gh_dir(&empty, cfg!(windows)), None);
        // Stage a fake gh beside the "exe" → its dir (the exe dir) is returned.
        let dir = std::env::temp_dir().join("bsc-1277-gh");
        let _ = std::fs::create_dir_all(&dir);
        let gh = dir.join(if cfg!(windows) { "gh.exe" } else { "gh" });
        std::fs::write(&gh, b"#!/bin/sh\n").unwrap();
        assert_eq!(bundled_gh_dir(&dir, cfg!(windows)), Some(dir.clone()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn compose_path_returns_none_when_nothing_is_bundled() {
        // The additive-only contract: no prefix AND no suffix ⇒ None ⇒ caller leaves PATH untouched
        // (a no-bundle session inherits the parent PATH byte-for-byte).
        assert_eq!(compose_path(&[], Some("/usr/bin:/bin"), &[], ':'), None);
        assert_eq!(compose_path(&[], None, &[], ':'), None);
    }

    #[test]
    fn compose_path_prepends_prefix_and_appends_suffix_deduped() {
        let prefix = vec![PathBuf::from("/pg/cmd"), PathBuf::from("/pg/bin")];
        let suffix = vec![PathBuf::from("/app")]; // bundled gh dir
        let out = compose_path(&prefix, Some("/usr/bin:/pg/bin"), &suffix, ':').unwrap();
        // Prefix wins (first), base in the middle, suffix last; the duplicate /pg/bin is dropped.
        assert_eq!(out, "/pg/cmd:/pg/bin:/usr/bin:/app");
    }

    #[test]
    fn compose_path_with_only_a_suffix_appends_after_base() {
        // A user-installed gh (already on the base PATH) stays ahead of the bundled fallback.
        let out = compose_path(&[], Some("/usr/local/bin:/usr/bin"), &[PathBuf::from("/app")], ':').unwrap();
        assert_eq!(out, "/usr/local/bin:/usr/bin:/app");
    }

    #[test]
    fn bsc_shim_is_posix_everywhere_plus_a_cmd_on_windows() {
        // POSIX-only platforms stage a single `bsc`; Windows adds a `bsc.cmd` (native subprocesses
        // resolve `bsc` → `bsc.cmd` via PATHEXT; git-bash subprocesses use the POSIX `bsc`).
        assert_eq!(bsc_shim_files(false).iter().map(|(n, _)| *n).collect::<Vec<_>>(), vec!["bsc"]);
        assert_eq!(bsc_shim_files(true).iter().map(|(n, _)| *n).collect::<Vec<_>>(), vec!["bsc", "bsc.cmd"]);
    }

    #[test]
    fn bsc_shim_forwards_to_bsc_bin_and_never_re_enters_itself() {
        // POSIX shim: a real shebang, LF-only (a CRLF shebang breaks on unix), execs the ABSOLUTE
        // $BSC_BIN — never a bare `bsc`, which would recurse back into this on-PATH shim — and guards
        // an unset $BSC_BIN with the same 127 the `bsc()` shell helper uses.
        assert!(BSC_SHIM_SH.starts_with("#!/bin/sh\n"));
        assert!(!BSC_SHIM_SH.contains('\r'), "the POSIX shim must be LF-only");
        assert!(BSC_SHIM_SH.contains("exec \"$BSC_BIN\" \"$@\""));
        assert!(!BSC_SHIM_SH.contains("exec \"bsc\""), "must not re-enter itself");
        assert!(BSC_SHIM_SH.contains("BSC_BIN is unset") && BSC_SHIM_SH.contains("exit 127"));
        // Windows shim: forwards to %BSC_BIN%, guards unset, and is CRLF for cmd.exe.
        assert!(BSC_SHIM_CMD.contains("\"%BSC_BIN%\" %*"));
        assert!(BSC_SHIM_CMD.contains("BSC_BIN is unset") && BSC_SHIM_CMD.contains("exit /b 127"));
        assert!(BSC_SHIM_CMD.contains("\r\n"), "the .cmd shim is CRLF");
    }

    #[test]
    fn session_env_adds_no_path_entry_when_no_bundle_is_staged() {
        // #1277 additive guarantee, stated as the FUNCTION's contract (not the machine's state, #3271):
        // given NO bundled dirs, session_env introduces no PATH — a no-bundle session inherits it
        // unchanged. Injecting empty prefix/suffix keeps this deterministic + touches no real state
        // (the old `session_env(...)` form probed — and CREATED — `~/.base-studio-code/shim`, so the
        // test broke as soon as `bsc` was resolvable and mutated the user's home as a side effect).
        let env = session_env_with(&HashMap::new(), &[], &[]);
        assert!(!env.iter().any(|(k, _)| k == "PATH"), "no bundle ⇒ no synthesized PATH entry");
        // A caller PATH still flows through untouched (nothing bundled to fold in).
        let mut caller = HashMap::new();
        caller.insert("PATH".to_string(), "/only/this".to_string());
        let env = session_env_with(&caller, &[], &[]);
        assert_eq!(
            env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.as_str()),
            Some("/only/this"),
        );
    }

    #[test]
    fn session_env_prepends_a_staged_bundle_dir_to_path() {
        use std::path::PathBuf;
        // The OTHER half of #1277: WHEN a bundle dir is staged it PREPENDS the caller's PATH, so a bare
        // `bsc`/`git` resolves the bundled one. Injected, so no real bundle is needed (#3271).
        let mut caller = HashMap::new();
        caller.insert("PATH".to_string(), "/usr/bin".to_string());
        let env = session_env_with(&caller, &[PathBuf::from("/bundle/shim")], &[]);
        let path = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.as_str()).expect("bundle ⇒ PATH added");
        let sep = if cfg!(windows) { ';' } else { ':' };
        assert_eq!(path, format!("/bundle/shim{sep}/usr/bin"), "the bundled dir wins over the caller PATH");
    }

    #[test]
    fn sidecar_candidates_probe_beside_exe_then_both_profile_dirs() {
        use std::path::PathBuf;
        // A dev exe in target/debug: look beside it (target/debug) first, then the OTHER profile
        // (target/release). The beside-the-exe dir IS target/debug, so it's not duplicated.
        let dev = PathBuf::from("/repo/target/debug/base-studio-code.exe");
        assert_eq!(
            sidecar_candidates(&dev, "bsc.exe"),
            vec![
                PathBuf::from("/repo/target/debug/bsc.exe"),
                PathBuf::from("/repo/target/release/bsc.exe"),
            ],
            "a built sidecar is found whichever profile produced it — not only beside THIS exe"
        );
        // An installed/bundled app: the staged sidecar beside the exe is the first candidate.
        let installed = PathBuf::from("/opt/app/base-studio-code");
        assert_eq!(sidecar_candidates(&installed, "bsc")[0], PathBuf::from("/opt/app/bsc"));
    }

    #[test]
    fn is_build_output_detects_a_cargo_target_dir_only() {
        // Dev: the app exe under target/<profile>/ IS a build output cargo relinks — the case where a
        // live session must run the staged copy so `deps/bsc.exe` stays unlocked (#3457).
        assert!(is_build_output(&PathBuf::from("/repo/target/debug/base-studio-code.exe")));
        assert!(is_build_output(&PathBuf::from("/repo/target/release/base-studio-code")));
        // A nested worktree's own target is still `.../target/<profile>/`.
        assert!(is_build_output(&PathBuf::from("/repo/wt3457/target/debug/base-studio-code.exe")));
        // A release install dir is NOT — staging is skipped there so a stale dev copy can't shadow the
        // bundled sidecar; beside-the-exe resolution stays unchanged.
        assert!(!is_build_output(&PathBuf::from("/opt/app/base-studio-code")));
        assert!(!is_build_output(&PathBuf::from(
            "C:/Program Files/base-studio-code/base-studio-code.exe"
        )));
        // A `debug`/`release` dir NOT directly under `target` must not false-positive.
        assert!(!is_build_output(&PathBuf::from("/home/user/debug/app.exe")));
        assert!(!is_build_output(&PathBuf::from("/srv/release/app")));
        // A bare filename (no parent chain) must not panic.
        assert!(!is_build_output(&PathBuf::from("app.exe")));
    }

    #[test]
    fn staged_sidecar_dir_is_bin_under_the_base_dir() {
        // The stable home the dev sidecars are copied to lives beside the rest of the app state.
        assert_eq!(staged_sidecar_dir(), bsc_base_dir().join("bin"));
    }

    #[test]
    fn session_skill_group_only_for_the_planner_pane() {
        // #1419: only the planner pane carries the per-project session skill group; the id is
        // deterministic from the key so the pane + the bsc skill CLI agree.
        assert_eq!(
            session_skill_group_for_pane("planning_acme-crm"),
            Some("grp-session-acme-crm".to_string()),
        );
        // Workers/director/triage/manual panes get nothing.
        for miss in ["acme-crm:director", "acme-crm:auth-ui", "acme-crm:own/web:triage", "man:t0:p1", "acme-crm"] {
            assert_eq!(session_skill_group_for_pane(miss), None, "{miss} must not get a session group");
        }
    }

    #[test]
    fn session_env_sets_xterm_term_by_default() {
        // TERM/COLORTERM were previously unset on the spawned shell; default them
        // so claude's TUI (ghost-text autocomplete, truecolor) works. No-bundle premise (#3271).
        let env = session_env_with(&HashMap::new(), &[], &[]);
        assert!(env.iter().any(|(k, v)| k == "TERM" && v == "xterm-256color"));
        assert!(env.iter().any(|(k, v)| k == "COLORTERM" && v == "truecolor"));
    }

    #[test]
    fn session_env_lets_caller_override_term_and_appends_extras() {
        let mut caller = HashMap::new();
        caller.insert("TERM".to_string(), "screen-256color".to_string());
        caller.insert("GH_TOKEN".to_string(), "secret".to_string());
        let env = session_env_with(&caller, &[], &[]); // no-bundle premise (#3271)
        // caller TERM wins, with no duplicate entry
        assert_eq!(env.iter().filter(|(k, _)| k == "TERM").count(), 1);
        assert!(env.iter().any(|(k, v)| k == "TERM" && v == "screen-256color"));
        // unrelated caller vars still flow through
        assert!(env.iter().any(|(k, v)| k == "GH_TOKEN" && v == "secret"));
    }

    /// #3373: ONLY an app-owned studio workspace gets a scratch dir. The rule is deliberately narrow —
    /// a scratch dir is a write path, and the sessions that need one are exactly those confined to a
    /// single store CLI. Anything else (a repo console, a fleet worktree, a project hub) must get None,
    /// or `--file` would resolve somewhere the confinement never intended.
    #[test]
    fn scratch_dir_is_granted_to_studio_workspaces_and_nothing_else() {
        for studio in ["design-studio", "algorithms-studio", "teams-studio", "sound-studio"] {
            let cwd = bsc_base_dir().join(studio);
            assert_eq!(
                scratch_dir_for_cwd(&cwd.to_string_lossy()),
                Some(cwd.join("scratch")),
                "{studio} is an app-owned studio workspace",
            );
        }

        // A NESTED path under a studio is not the workspace itself — only the workspace root qualifies,
        // so a session that somehow ran deeper cannot mint a scratch dir of its own.
        assert_eq!(scratch_dir_for_cwd(&bsc_base_dir().join("design-studio").join("sub").to_string_lossy()), None);
        // A project hub / worktree / plain repo console: no confinement to work around, no scratch dir.
        assert_eq!(scratch_dir_for_cwd(&bsc_base_dir().join("projects").join("app").to_string_lossy()), None);
        assert_eq!(scratch_dir_for_cwd("C:/Users/dev/some-repo"), None);
        // A same-named dir OUTSIDE the base dir must not qualify on its suffix alone.
        assert_eq!(scratch_dir_for_cwd("C:/Users/dev/design-studio"), None);
        assert_eq!(scratch_dir_for_cwd(""), None);
    }

    #[test]
    fn shot_dir_is_inside_the_studio_workspace_so_confinement_can_read_it() {
        // #3468: the whole point. `bsc shot`'s global default (~/.base-studio-code/shots) is a SIBLING
        // of the workspace, so it sits outside $BSC_REPO_ROOT and `bsc-confine` (which matches Read)
        // blocks the session from opening its own shot. The per-studio dir must be UNDER the cwd.
        for studio in ["design-studio", "algorithms-studio", "teams-studio", "sound-studio"] {
            let cwd = bsc_base_dir().join(studio);
            let shots = shot_dir_for_cwd(&cwd.to_string_lossy()).expect("a studio gets a shot dir");
            assert_eq!(shots, cwd.join("shots"));
            assert!(shots.starts_with(&cwd), "{studio}: shots must be INSIDE the confinement root");
        }

        // Same gating as the scratch dir — only a studio workspace root qualifies.
        assert_eq!(shot_dir_for_cwd(&bsc_base_dir().join("design-studio").join("sub").to_string_lossy()), None);
        assert_eq!(shot_dir_for_cwd(&bsc_base_dir().join("projects").join("app").to_string_lossy()), None);
        assert_eq!(shot_dir_for_cwd("C:/Users/dev/some-repo"), None);
        assert_eq!(shot_dir_for_cwd("C:/Users/dev/design-studio"), None);
        assert_eq!(shot_dir_for_cwd(""), None);
    }

    #[test]
    fn a_studios_scratch_and_shots_share_one_confinable_root() {
        // Both hang off `studio_dir_for_cwd`, so they can never drift apart — the regression that
        // created #3468 was exactly a studio-adjacent dir living somewhere confinement did not reach.
        let cwd = bsc_base_dir().join("design-studio");
        let s = cwd.to_string_lossy();
        let (scratch, shots) = (scratch_dir_for_cwd(&s).unwrap(), shot_dir_for_cwd(&s).unwrap());
        assert_eq!(scratch.parent(), shots.parent(), "same root");
        assert_eq!(scratch.parent(), Some(cwd.as_path()));
    }

    #[test]
    fn plan_db_for_cwd_resolves_the_central_db_from_a_project_session() {
        // Director/planner at the hub root → the project's central plans/<key>.db (#2996, out of the hub).
        let hub = bsc_base_dir().join("projects").join("my-app");
        assert_eq!(plan_db_for_cwd(&hub.to_string_lossy()), Some(crate::plan_db_path("my-app")));
    }

    /// The regression: a WORKER's cwd must resolve to its project's stores.
    ///
    /// This test previously used `projects/<key>/.worktrees/...` — a layout #844 abandoned when it
    /// moved worktrees OUT of the hub. So it passed against a path no worker has had in a long time,
    /// while every real worker got NO `BSC_PLAN_DB` and could not run a single `bsc plan` verb.
    /// Built from `worktrees_dir` rather than a hand-written path, so it cannot drift from the real
    /// layout again.
    #[test]
    fn every_per_project_store_resolves_from_a_real_worker_worktree() {
        let wt = crate::worktrees_dir("my-app").join("web--auth");
        let cwd = wt.to_string_lossy();

        assert_eq!(plan_db_for_cwd(&cwd), Some(crate::plan_db_path("my-app")));
        // The other three share the derivation, so they broke together and must be fixed together.
        assert_eq!(error_db_for_cwd(&cwd), Some(crate::error_db_path("my-app")));
        assert_eq!(usage_db_for_cwd(&cwd), Some(crate::usage_db_path("my-app")));
        assert!(data_db_for_cwd(&cwd).is_some(), "the project DuckDB must resolve for a worker too");

        // A worker and the hub director share ONE plan.db — that is what makes the fleet's plan a
        // single store rather than a copy per session.
        let hub = crate::project_dir("my-app");
        assert_eq!(plan_db_for_cwd(&cwd), plan_db_for_cwd(&hub.to_string_lossy()));
    }

    /// The guard the widening must not remove: a session that belongs to no project gets no stores.
    #[test]
    fn a_non_project_session_still_resolves_no_stores() {
        for cwd in [
            "",
            "C:/code/some-repo",
            &bsc_base_dir().join("design-studio").to_string_lossy(),
        ] {
            assert_eq!(plan_db_for_cwd(cwd), None, "{cwd} must not resolve a plan db");
        }
    }

    #[test]
    fn wire_bsc_env_exports_the_log_dir_for_bsc_logs() {
        // #1716/#1877: every session must be able to query its own log streams + perf.db via the
        // unified `bsc logs` subcommand, which reads $BSC_LOG_DIR. wire_bsc_env stages it for every
        // pane (the same base dir that holds the *_LOG TSVs). The `bsc` binary isn't present in the
        // test target, so $BSC_BIN is only set when staged — BSC_LOG_DIR is the unconditional contract.
        use super::CommandBuilder;
        let mut cmd = CommandBuilder::new("bash");
        let _ = super::wire_bsc_env(&mut cmd, "t0p1", "", None, None);
        assert!(cmd.get_env("BSC_LOG_DIR").is_some(), "BSC_LOG_DIR must be exported for bsc logs");
    }

    #[test]
    fn wire_bsc_env_exports_every_registry_log_stream() {
        // #1847: the pty writer stages every `bsc_util::LOG_STREAMS` row's $BSC_*_LOG — the same
        // registry the unified `bsc logs` reader resolves filenames from — so the writer + reader
        // can't drift on the stream set. Plus the pane tag every line carries.
        use super::CommandBuilder;
        let mut cmd = CommandBuilder::new("bash");
        let _ = super::wire_bsc_env(&mut cmd, "t0p1", "", None, None);
        for s in bsc_util::LOG_STREAMS {
            assert!(cmd.get_env(s.env_var).is_some(), "{} ({}) must be exported", s.key, s.env_var);
        }
        assert!(cmd.get_env("BSC_AUDIT_PANE").is_some(), "the pane tag must be exported");
    }

    #[test]
    fn plan_db_for_cwd_is_none_outside_a_project_hub() {
        assert_eq!(plan_db_for_cwd(""), None);
        assert_eq!(plan_db_for_cwd(&bsc_base_dir().join("bin").to_string_lossy()), None);
        // A plain repo somewhere on disk is not a project session.
        let elsewhere = std::path::Path::new("C:/code/some-repo");
        assert_eq!(plan_db_for_cwd(&elsewhere.to_string_lossy()), None);
    }

    /// #request-128 — a cwd that resolves to NO project must CLEAR the per-project store vars, not
    /// merely skip setting them.
    ///
    /// This is the whole bug, and it is invisible at the call site. `CommandBuilder::new` seeds
    /// `envs` from `get_base_env()` — a copy of the APP PROCESS's own environment — so an
    /// `if let Some(db) = … { cmd.env(…) }` that does not fire leaves whatever the app's launching
    /// shell exported. This repo's own workflow tells a developer to
    /// `export BSC_PLAN_DB=…/studio-code.db`, so a director opened for an unrelated project
    /// inherited studio-code's plan store and read and wrote the WRONG project's issues, silently.
    ///
    /// The assertion only means something because the var is SET first: a value that was never set
    /// and one that was cleared both read as `None`, so a bare `is_none()` on a clean environment
    /// would pass against the unfixed code. Setting it makes `None` provable evidence of a clear.
    #[test]
    fn a_cwd_with_no_project_clears_the_inherited_store_vars_rather_than_inheriting_them() {
        use super::CommandBuilder;
        let _guard = crate::testutil::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Stand in for the leak: the app's own shell exported another project's stores.
        let leaked = [
            ("BSC_PLAN_DB", "/somewhere/else/plans/studio-code.db"),
            ("BSC_ERROR_DB", "/somewhere/else/error.db"),
            ("BSC_USAGE_DB", "/somewhere/else/usage.db"),
            ("BSC_DATA_DB", "/somewhere/else/data.duckdb"),
        ];
        for (k, v) in leaked {
            std::env::set_var(k, v);
        }
        // A plain repo is not a project session, so none of the four can resolve.
        let mut cmd = CommandBuilder::new("bash");
        let _ = super::wire_bsc_env(&mut cmd, "t0p1", "C:/code/some-unrelated-repo", None, None);
        for (k, v) in leaked {
            assert_eq!(
                cmd.get_env(k),
                None,
                "{k} must be CLEARED for a non-project session — it was inherited as {v:?}, and a \
                 session scoped to one project must never silently read or write another's store",
            );
            std::env::remove_var(k);
        }
    }

    /// The other half of the same contract: when the cwd DOES resolve, the var is set to that
    /// project's store — so the clear above cannot be "clear it always", which would break every
    /// fleet session's `bsc plan`.
    #[test]
    fn a_project_cwd_still_gets_its_own_plan_db() {
        use super::CommandBuilder;
        let _guard = crate::testutil::ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var("BSC_PLAN_DB", "/somewhere/else/plans/studio-code.db");
        let hub = bsc_base_dir().join("projects").join("my-app");
        let mut cmd = CommandBuilder::new("bash");
        let _ = super::wire_bsc_env(&mut cmd, "t0p1", &hub.to_string_lossy(), None, None);
        let got = cmd.get_env("BSC_PLAN_DB").map(|s| s.to_string_lossy().to_string());
        assert!(got.is_some(), "a project session must still get its own BSC_PLAN_DB");
        assert!(
            got.as_deref().is_some_and(|g| g.contains("my-app")),
            "and it must be THIS project's store, not the inherited one: {got:?}",
        );
        std::env::remove_var("BSC_PLAN_DB");
    }

    // ── #3959: staging must survive a locked destination ────────────────────────────────────────
    //
    // The staged dir exists so a live session locks IT instead of `target/<profile>/bsc.exe` (#3457).
    // That protection was also a deadlock: `fs::copy` cannot overwrite a file a process holds open, so
    // the lock the dir is designed to attract prevented the dir from ever being refreshed — and the
    // failure was a WARN, leaving `$BSC_BIN` on a stale binary that rejected newer hooks
    // (`bsc: unknown hook 'bash-supply'`) long after the fact.

    #[test]
    fn stage_one_overwrites_an_unlocked_destination() {
        let dir = crate::testutil::unique_dir("bsc-stage", "plain");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        let dst = dir.join("bsc.exe");
        std::fs::write(&src, b"NEW").unwrap();
        std::fs::write(&dst, b"OLD").unwrap();
        stage_one(&src, &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"NEW", "the fresh binary lands at the canonical path");
        assert!(
            std::fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains(".old-")),
            "no rename dance when the plain copy works",
        );
    }

    #[test]
    fn stage_one_creates_the_destination_when_absent() {
        let dir = crate::testutil::unique_dir("bsc-stage", "absent");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        std::fs::write(&src, b"NEW").unwrap();
        let dst = dir.join("bsc.exe");
        stage_one(&src, &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"NEW");
    }

    /// THE property: the destination is never a partial file.
    ///
    /// Proven the only way it can be proven without racing — by holding an open handle to the OLD
    /// destination across the stage. If staging truncated and rewrote in place (what `fs::copy` onto
    /// `dst` does), that handle would see the new bytes, or an empty file mid-copy. Through a rename
    /// it keeps the whole old inode, which is exactly what a session already exec'ing `$BSC_BIN` gets.
    #[test]
    fn stage_one_replaces_the_destination_atomically_rather_than_truncating_it() {
        use std::io::Read;
        let dir = crate::testutil::unique_dir("bsc-stage", "atomic");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        let dst = dir.join("bsc");
        std::fs::write(&src, b"NEW-BUILD").unwrap();
        std::fs::write(&dst, b"OLD-BUILD").unwrap();

        // A reader that opened the old binary BEFORE the stage — the session already running it.
        let mut held = std::fs::File::open(&dst).unwrap();
        stage_one(&src, &dst).unwrap();

        let mut seen = String::new();
        held.read_to_string(&mut seen).unwrap();
        assert_eq!(seen, "OLD-BUILD", "the open handle kept the whole old file — a rename, not a rewrite");
        assert_eq!(std::fs::read(&dst).unwrap(), b"NEW-BUILD", "…and the path now serves the new one");
    }

    /// No temp file survives a stage, success or failure. A `.bsc.staging-<pid>` left in the staged dir
    /// is a 261 MB leak per boot, and `sidecar_status` would eventually have to explain it.
    #[test]
    fn stage_one_leaves_no_temp_file_behind() {
        let dir = crate::testutil::unique_dir("bsc-stage", "notmp");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        let dst = dir.join("bsc");
        std::fs::write(&src, b"NEW").unwrap();
        stage_one(&src, &dst).unwrap();
        // ...and after a FAILED stage (an absent source), too.
        let _ = stage_one(&dir.join("gone.bin"), &dst);

        let strays: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("staging-"))
            .collect();
        assert!(strays.is_empty(), "temp files left behind: {strays:?}");
    }

    /// The mode is set BEFORE the file is published, not after.
    ///
    /// `a_staged_sidecar_is_made_executable_whatever_mode_the_source_carried` covers
    /// `ensure_executable` on its own; this covers it THROUGH `stage_one`, which is the part the
    /// atomic rewrite changed. Setting the mode after the rename would republish the old problem in
    /// miniature — a window where the path is the right binary and still cannot be exec'd — and only
    /// a test at this level can tell the two orderings apart.
    #[cfg(unix)]
    #[test]
    fn stage_one_publishes_an_executable_file_from_a_non_executable_source() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::testutil::unique_dir("bsc-stage", "stagemode");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        std::fs::write(&src, b"NEW").unwrap();
        std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o644)).unwrap();
        let dst = dir.join("bsc");
        stage_one(&src, &dst).unwrap();
        let mode = std::fs::metadata(&dst).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "staged sidecar is executable (mode {mode:o})");
    }

    #[test]
    fn a_missing_source_is_reported_not_swallowed() {
        // A non-lock error must surface as-is rather than trigger the rename path and park the only
        // good binary out of the way.
        let dir = crate::testutil::unique_dir("bsc-stage", "nosrc");
        std::fs::create_dir_all(&dir).unwrap();
        let dst = dir.join("bsc.exe");
        std::fs::write(&dst, b"OLD").unwrap();
        assert!(stage_one(&dir.join("nope.bin"), &dst).is_err());
        assert_eq!(std::fs::read(&dst).unwrap(), b"OLD", "the existing binary is left intact");
    }

    #[test]
    fn os_error_32_is_classified_as_in_use() {
        // ERROR_SHARING_VIOLATION is the Windows "another process has it open" code — the ONLY case
        // that earns the rename dance.
        assert!(is_in_use(&std::io::Error::from_raw_os_error(32)));
        assert!(is_in_use(&std::io::Error::from(std::io::ErrorKind::PermissionDenied)));
        assert!(!is_in_use(&std::io::Error::from(std::io::ErrorKind::NotFound)));
    }

    #[test]
    fn sweep_drops_parked_copies_and_keeps_the_live_ones() {
        let dir = crate::testutil::unique_dir("bsc-stage", "sweep");
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["bsc.exe", "bsc-agent.exe", "bsc.old-1784595461", "bsc-agent.old-1"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        sweep_superseded(&dir);
        assert!(dir.join("bsc.exe").exists(), "the live sidecar survives");
        assert!(dir.join("bsc-agent.exe").exists(), "so does the agent");
        assert!(!dir.join("bsc.old-1784595461").exists(), "a parked copy is swept");
        assert!(!dir.join("bsc-agent.old-1").exists());
    }

    #[test]
    fn a_parked_name_is_never_a_sidecar_candidate() {
        // The parked file must not be resolvable as `$BSC_BIN`, or the sweep would be racing the
        // resolver. `with_extension` drops `.exe`, so `bsc.old-<ts>` cannot match the `bsc.exe` lookup.
        let parked = std::path::Path::new("/bin/bsc.exe").with_extension("old-123");
        assert_eq!(parked.file_name().unwrap(), "bsc.old-123");
        assert_ne!(parked.file_name().unwrap(), "bsc.exe");
    }

    /// A session's own project stores must survive the user's rc.
    ///
    /// THE BUG: `wire_bsc_env` sets these on the spawned PROCESS, then an INTERACTIVE bash sources
    /// `~/.bashrc` — which this repo's dev workflow tells a developer to fill with
    /// `export BSC_PLAN_DB=.../studio-code.db`. That runs afterwards and wins, so `pain-point-finder`'s
    /// director read, and could write, studio-code's board. The fix is only correct because the caller
    /// emits this AFTER the rc source; `launch.rs` pins that ordering separately.
    #[test]
    fn store_exports_name_the_sessions_own_project() {
        let hub = crate::projects_root().join("pain-point-finder");
        let out = super::store_exports_for_cwd(&hub.to_string_lossy());
        assert!(out.contains("export BSC_PLAN_DB='"), "must EXPORT, to outrank the rc: {out}");
        assert!(out.contains("pain-point-finder"), "names its own project: {out}");
        // Match the STORE, not the substring: the base dir is `.base-studio-code`, so a bare
        // `contains("studio-code")` is true of every correct path on this machine.
        assert!(!out.contains("plans/studio-code.db"), "never another project's plan store: {out}");
        for v in ["BSC_ERROR_DB", "BSC_USAGE_DB", "BSC_DATA_DB"] {
            assert!(out.contains(&format!("export {v}='")), "{v} shares the derivation: {out}");
        }
    }

    /// A WORKER resolves from the worktrees root, not the hub — the strip #844 broke once.
    #[test]
    fn a_worker_worktree_gets_its_projects_stores_too() {
        let wt = crate::worktrees_root().join("pain-point-finder").join("repo--stream");
        let out = super::store_exports_for_cwd(&wt.to_string_lossy());
        assert!(out.contains("export BSC_PLAN_DB='"), "a worker needs its plan store: {out}");
        assert!(out.contains("pain-point-finder"), "its own project: {out}");
    }

    /// A NON-project session ends with the vars GONE, not inherited: "another project's store,
    /// silently" becomes "`bsc plan` fails loudly", which is the honest outcome.
    #[test]
    fn a_non_project_session_unsets_the_stores_rather_than_inheriting_them() {
        let out = super::store_exports_for_cwd("/tmp/some/unrelated/repo");
        for v in ["BSC_PLAN_DB", "BSC_ERROR_DB", "BSC_USAGE_DB", "BSC_DATA_DB"] {
            assert!(out.contains(&format!("unset {v};")), "{v} must be unset: {out}");
        }
        assert!(!out.contains("export "), "nothing exported for a non-project cwd: {out}");
    }
}
