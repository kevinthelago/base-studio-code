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

/// The sanitized project key owning `cwd` — the first path component under the projects hub root
/// (`~/.base-studio-code/projects/<key>/...`), or None when `cwd` is empty or not under a hub.
/// Shared derivation for [`plan_db_for_cwd`] and [`data_db_for_cwd`] so a session's plan.db and
/// DuckDB store always resolve to the same key.
fn project_key_from_cwd(cwd: &str) -> Option<std::ffi::OsString> {
    if cwd.is_empty() {
        return None;
    }
    let root = crate::projects_root();
    let rel = std::path::Path::new(cwd).strip_prefix(&root).ok()?;
    Some(rel.components().next()?.as_os_str().to_os_string())
}

/// The sealed scratch dir for an app-owned STUDIO session (#3373), or None for every other pane.
///
/// A restricted studio session is confined to one store CLI by Bash allow-list rules, and a heredoc
/// cannot be allow-listed (newlines are command separators), so it authors by WRITING a payload here
/// and passing `--file <bare-name>`. Only the studio workspaces get one: a plain console in some repo
/// has no confinement to work around and would just accumulate stray dirs.
///
/// Derived from the cwd exactly like [`plan_db_for_cwd`], rather than plumbed down from the frontend,
/// so the rule lives in one place: a studio workspace is a DIRECT child of the bsc base dir whose name
/// ends in `-studio` (`~/.base-studio-code/design-studio/`, `…/sound-studio/`, …).
fn scratch_dir_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    let native = crate::platform::shell::to_native_path(cwd);
    let dir = std::path::Path::new(&native);
    // A DIRECT child of the base dir — not a nested path that merely starts with it.
    if dir.parent() != Some(bsc_base_dir().as_path()) {
        return None;
    }
    let name = dir.file_name()?.to_string_lossy().into_owned();
    name.ends_with("-studio").then(|| dir.join("scratch"))
}

/// The project hub's `plan.db` for a session whose cwd lives under a project hub
/// (`~/.base-studio-code/projects/<key>/...`), or None for a non-project session (#plan-db).
/// Workers run in `projects/<key>/.worktrees/...` and the director/planner in `projects/<key>/` —
/// both resolve to the same hub db, so the whole fleet shares one canonical plan store.
fn plan_db_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
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
    for stem in ["bsc", "bsc-agent"] {
        let exe = if cfg!(windows) { format!("{stem}.exe") } else { stem.to_string() };
        let Some(src) = sidecar_candidates(&cur, &exe).into_iter().find(|p| p.exists()) else {
            continue; // not built yet — sidecar_status reports it missing
        };
        let dst = dir.join(&exe);
        match std::fs::copy(&src, &dst) {
            Ok(_) => log::info!("[startup] staged dev sidecar `{stem}` → {}", dst.display()),
            Err(e) => log::warn!(
                "[startup] could not stage `{stem}` to {} (a live session may hold it): {e}",
                dst.display()
            ),
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
    // bsc-note / bsc-blocked (fleet assume-and-log) cost nothing in sessions that
    // don't use them. Per-session doc paths the helpers read are exposed as env
    // vars when applicable; bsc-note/bsc-blocked default to a DECISIONS.md in cwd.
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
    }
    // bsc plan (#plan-db): point this session at its project's canonical plan store. $BSC_PLAN_DB is
    // the plan.db the `bsc plan` subcommand reads/writes (the unified `bsc` binary is staged once as
    // $BSC_BIN below — no per-CLI binary). The DB is derived from the cwd — every project session runs
    // under `~/.base-studio-code/projects/<key>/...` (the director/planner at the hub, workers in a
    // worktree beneath it) — so the whole fleet shares one plan.db. Non-project sessions (a plain
    // console in some repo) get no BSC_PLAN_DB and never call `bsc plan`.
    if let Some(db) = plan_db_for_cwd(cwd) {
        cmd.env("BSC_PLAN_DB", to_bash_path(&db.to_string_lossy()));
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
    // bsc errors (#2260): point this session at its project's runtime-fault store. $BSC_ERROR_DB is the
    // error.db the `bsc errors` subcommand reads/writes — cwd-derived exactly like BSC_PLAN_DB, so the
    // whole fleet shares one error.db per project; a non-project session gets none and never calls it.
    if let Some(db) = error_db_for_cwd(cwd) {
        cmd.env("BSC_ERROR_DB", to_bash_path(&db.to_string_lossy()));
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
    // project's .duckdb (cwd-derived, like BSC_PLAN_DB).
    if let Some(db) = data_db_for_cwd(cwd) {
        cmd.env("BSC_DATA_DB", to_bash_path(&db.to_string_lossy()));
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
mod tests {
    use super::{
        bsc_shim_files, bundled_gh_dir, compose_path, is_build_output, plan_db_for_cwd,
        portable_git_bin_candidates, scratch_dir_for_cwd, session_env_with,
        session_skill_group_for_pane, sidecar_candidates, staged_sidecar_dir, BSC_SHIM_CMD,
        BSC_SHIM_SH,
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
    fn plan_db_for_cwd_resolves_the_central_db_from_a_project_session() {
        let projects = bsc_base_dir().join("projects");
        // Director/planner at the hub root → the project's central plans/<key>.db (#2996, out of the hub).
        let hub = projects.join("my-app");
        assert_eq!(plan_db_for_cwd(&hub.to_string_lossy()), Some(crate::plan_db_path("my-app")));
        // A worker in a worktree beneath the hub resolves to the SAME db.
        let wt = projects.join("my-app").join(".worktrees").join("web--auth");
        assert_eq!(plan_db_for_cwd(&wt.to_string_lossy()), Some(crate::plan_db_path("my-app")));
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
}
