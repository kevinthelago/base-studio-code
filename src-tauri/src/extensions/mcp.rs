use crate::*;

/// Resolve a catalog MCP server's download directory under `~/.base-studio-code/mcp/`,
/// slugifying `name` (`[A-Za-z0-9._-]`, else `_`) so it can never escape the `mcp/` root.
/// `Err` for an empty / `.` / `..` name. Pure over the base dir — unit-tested.
pub(crate) fn mcp_install_dir(name: &str) -> Result<std::path::PathBuf, String> {
    let safe = crate::platform::fsx::safe_dir_segment(name, |c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        .map_err(|_| "mcp_install_dir: invalid name".to_string())?;
    Ok(bsc_base_dir().join("mcp").join(safe))
}
#[tauri::command]
pub(crate) async fn mcp_clone(name: String, url: String) -> Result<String, String> {
    let _perf = PerfSpan::new("mcp_clone");
    let dir = mcp_install_dir(&name)?;
    let dir_str = dir.to_string_lossy().into_owned();
    if dir.join(".git").exists() {
        // Already downloaded — fast-forward to the latest default branch (best-effort).
        let mut pull = std::process::Command::new("git");
        pull.args(["-C", &dir_str, "pull", "--ff-only"]);
        let _ = no_window(&mut pull).status();
        log::info!("mcp_clone: updated {name} at {dir_str}");
        return Ok(dir_str);
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut cmd = std::process::Command::new("git");
    cmd.args(["clone", "--depth", "1", &url, &dir_str]);
    let status = no_window(&mut cmd).status().map_err(|e| e.to_string())?;
    if !status.success() {
        log::warn!("mcp_clone: git clone failed for {url}");
        return Err(format!("git clone failed for {url}"));
    }
    log::info!("mcp_clone: downloaded {url} → {dir_str}");
    Ok(dir_str)
}
/// The shell build command for a downloaded MCP server, detected from its repo files,
/// or `None` if the toolchain isn't recognized. A `uv`/Python project builds with
/// `python -m uv sync` (uv is a Python module; its shim is often off PATH — `python -m uv`
/// runs without any PATH setup, #887); a pnpm project with `pnpm install && pnpm build`;
/// any other Node project falls back to npm. Pure over the dir contents — unit-tested.
pub(crate) fn mcp_build_command(dir: &std::path::Path) -> Option<String> {
    if dir.join("pyproject.toml").exists() || dir.join("uv.lock").exists() {
        Some("python -m uv sync".into())
    } else if dir.join("pnpm-lock.yaml").exists() {
        Some("pnpm install && pnpm build".into())
    } else if dir.join("package.json").exists() {
        Some("npm install && npm run build".into())
    } else {
        None
    }
}
/// Result of building a downloaded MCP server. `ok` is the overall success; `ran` is the
/// shell command that was executed; `stdout`/`stderr` are its (truncated) output so the
/// MCP panel can show why a build failed.
#[derive(serde::Serialize)]
pub(crate) struct McpBuildResult {
    pub(crate) ok: bool,
    pub(crate) ran: String,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}
/// Build a downloaded MCP server in place (`~/.base-studio-code/mcp/<name>`), running its
/// detected toolchain build (`uv sync` / `pnpm install && pnpm build` / npm). Invoked by the
/// MCP panel's "build" button — kept separate from `mcp_clone` so downloading is cheap and
/// the (slow, toolchain-dependent) build is opt-in. Returns the outcome instead of erroring on
/// a failed build so the panel can surface stdout/stderr; only setup problems (missing dir,
/// unknown toolchain) are `Err`.
#[tauri::command]
pub(crate) async fn mcp_build(name: String) -> Result<McpBuildResult, String> {
    let _perf = PerfSpan::new("mcp_build");
    let dir = mcp_install_dir(&name)?;
    if !dir.exists() {
        return Err(format!("mcp_build: {name} is not downloaded yet — download it first"));
    }
    let Some(command) = mcp_build_command(&dir) else {
        return Err(format!("mcp_build: don't recognize how to build {name} (no pyproject.toml / package.json)"));
    };
    // Run through the platform shell so `&&` chains work and Windows `.cmd` shims
    // (pnpm/npm) resolve — a bare `Command::new("pnpm")` only finds `.exe` on Windows.
    #[cfg(windows)]
    let (shell, flag) = ("cmd", "/C");
    #[cfg(not(windows))]
    let (shell, flag) = ("sh", "-c");
    let mut cmd = std::process::Command::new(shell);
    cmd.current_dir(&dir).args([flag, &command]);
    let output = no_window(&mut cmd).output().map_err(|e| format!("mcp_build: failed to run `{command}`: {e}"))?;
    // Truncate captured output so a noisy build log doesn't bloat the IPC payload.
    let cap = |b: &[u8]| {
        let s = String::from_utf8_lossy(b);
        if s.len() > 8000 { format!("…{}", &s[s.len() - 8000..]) } else { s.into_owned() }
    };
    let ok = output.status.success();
    if ok {
        log::info!("mcp_build: built {name} via `{command}`");
    } else {
        log::warn!("mcp_build: `{command}` failed for {name}");
    }
    Ok(McpBuildResult { ok, ran: command, stdout: cap(&output.stdout), stderr: cap(&output.stderr) })
}
/// (downloaded, built) for an MCP server's install dir. Downloaded ⇒ a clone is present;
/// built ⇒ its toolchain's install/build output exists (`.venv` for uv, `node_modules` for
/// npm/pnpm, `dist` for a TS build). Pure over the dir — unit-tested.
pub(crate) fn mcp_status_of(dir: &std::path::Path) -> (bool, bool) {
    let downloaded = dir.join(".git").exists();
    let built = downloaded
        && (dir.join(".venv").exists() || dir.join("node_modules").exists() || dir.join("dist").exists());
    (downloaded, built)
}
#[derive(serde::Serialize)]
pub(crate) struct McpStatusResult {
    pub(crate) downloaded: bool,
    pub(crate) built: bool,
}
/// Report whether a catalog MCP server has been downloaded and built, so the planning page's
/// MCP panel can open with real install status instead of assuming "not installed".
#[tauri::command]
pub(crate) async fn mcp_status(name: String) -> Result<McpStatusResult, String> {
    let dir = mcp_install_dir(&name)?;
    let (downloaded, built) = mcp_status_of(&dir);
    Ok(McpStatusResult { downloaded, built })
}
/// An update can be pulled when the remote HEAD differs from the local HEAD (both known).
/// Pure over the two sha strings — unit-tested.
pub(crate) fn mcp_update_available(local: &str, remote: &str) -> bool {
    let (l, r) = (local.trim(), remote.trim());
    !l.is_empty() && !r.is_empty() && l != r
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")] // return values aren't auto-renamed (#789): expose `updateAvailable`
pub(crate) struct McpUpdateStatus {
    pub(crate) downloaded: bool,
    pub(crate) built: bool,
    pub(crate) update_available: bool,
}
/// Check whether a downloaded MCP server has an update available — the MCP page runs this for
/// every installed first-party server on open, so each card shows an "up to date" pill or an
/// "update" button. Compares the local HEAD with the remote's (`git ls-remote origin HEAD`, refs
/// only — no object download). Also reports downloaded/built so an un-built clone surfaces a
/// "build" action. `update_available` is false for a non-git / not-downloaded server.
#[tauri::command]
pub(crate) async fn mcp_check_update(name: String) -> Result<McpUpdateStatus, String> {
    let _perf = PerfSpan::new("mcp_check_update");
    let dir = mcp_install_dir(&name)?;
    let (downloaded, built) = mcp_status_of(&dir);
    let mut update_available = false;
    if downloaded {
        let dir_str = dir.to_string_lossy().into_owned();
        let local = git_output(&["-C", &dir_str, "rev-parse", "HEAD"]);
        // `<sha>\tHEAD` — take the leading sha.
        let remote_line = git_output(&["-C", &dir_str, "ls-remote", "origin", "HEAD"]);
        let remote = remote_line.split_whitespace().next().unwrap_or("");
        update_available = mcp_update_available(&local, remote);
    }
    Ok(McpUpdateStatus { downloaded, built, update_available })
}
/// Merge the resolved MCP servers into `<cwd>/.mcp.json` by name (preserving any
/// repo-authored entries). Skips entirely when there are none and no file exists.
/// `enabledMcpjsonServers` in settings.json gates which are actually active.
pub(crate) fn write_mcp_json(root: &std::path::Path, mcp_servers: &[McpServerCfg]) -> Result<(), String> {
    let path = root.join(".mcp.json");
    if mcp_servers.is_empty() && !path.exists() { return Ok(()); }
    let mut doc: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() { doc = serde_json::json!({}); }
    let servers = doc.as_object_mut().unwrap()
        .entry("mcpServers").or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() { *servers = serde_json::json!({}); }
    let smap = servers.as_object_mut().unwrap();
    for m in mcp_servers {
        smap.insert(m.name.clone(), mcp_server_value(m));
    }
    std::fs::write(&path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
/// The sentinel command the frontend sets for the built-in Research server (#1196). It carries no
/// real path (the frontend can't know where the app exe lives), so `mcp_server_value` rewrites it to
/// the bundled `bsc-research-mcp` binary's absolute path at write time.
pub(crate) const RESEARCH_MCP_MARKER: &str = "bsc-research-mcp";
/// The same sentinel for the built-in Compliance server (#1005) — rewritten to the bundled
/// `bsc-compliance-mcp` binary's absolute path at write time.
pub(crate) const COMPLIANCE_MCP_MARKER: &str = "bsc-compliance-mcp";
/// Resolve a stdio MCP command, substituting the bundled-binary absolute path for a built-in MCP
/// marker (Research #1196, Compliance #1005). A non-marker command passes through unchanged; a
/// marker falls back to the bare name when its bundled binary can't be located (e.g. a dev build
/// without the sidecar). Each marker resolves through its own bundled-path lookup.
pub(crate) fn resolve_mcp_command(command: &str, bundled: Option<std::path::PathBuf>) -> String {
    if command == RESEARCH_MCP_MARKER || command == COMPLIANCE_MCP_MARKER {
        if let Some(p) = bundled {
            return p.to_string_lossy().to_string();
        }
    }
    command.to_string()
}
/// One MCP server's `.mcp.json` value: stdio `{command,args,env?}` or http `{type,url}`.
pub(crate) fn mcp_server_value(m: &McpServerCfg) -> serde_json::Value {
    if m.transport == "http" {
        return serde_json::json!({ "type": "http", "url": m.url.clone().unwrap_or_default() });
    }
    let mut v = serde_json::Map::new();
    let raw = m.command.clone().unwrap_or_default();
    // Each built-in marker rewrites to its own bundled sidecar's absolute path.
    let bundled = match raw.as_str() {
        COMPLIANCE_MCP_MARKER => pty::bsc_compliance_mcp_bin_path(),
        _ => pty::bsc_research_mcp_bin_path(),
    };
    let command = resolve_mcp_command(&raw, bundled);
    v.insert("command".into(), serde_json::Value::String(command));
    v.insert("args".into(), serde_json::Value::Array(
        m.args.iter().map(|a| serde_json::Value::String(a.clone())).collect(),
    ));
    let env: serde_json::Map<String, serde_json::Value> = m.env.iter()
        .filter(|(k, _)| !k.is_empty())
        .map(|(k, val)| (k.clone(), serde_json::Value::String(val.clone())))
        .collect();
    if !env.is_empty() { v.insert("env".into(), serde_json::Value::Object(env)); }
    serde_json::Value::Object(v)
}
