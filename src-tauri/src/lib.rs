use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

// ── PTY state ────────────────────────────────────────────────────────────────

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

struct PtyState(Mutex<HashMap<String, PtySession>>);

// ── PTY commands ─────────────────────────────────────────────────────────────

/// Returns `true` when a new session is created, `false` when reconnecting to
/// an existing one (e.g. after a tab switch). The caller should send `\n` on
/// reconnect so the shell re-displays its prompt in the fresh terminal.
#[tauri::command]
async fn pty_create(
    pane_id: String,
    cols: u16,
    rows: u16,
    cwd: String,
    init_cmd: Option<String>,
    app: AppHandle,
    state: State<'_, PtyState>,
) -> Result<bool, String> {
    // If a session already exists for this pane (e.g. user switched tabs and
    // switched back), reconnect rather than recreating.
    if state.0.lock().unwrap().contains_key(&pane_id) {
        return Ok(false);
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());
    let mut cmd = CommandBuilder::new(&shell);

    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // Inject bash helpers into every new session.
    // Optional init_cmd is appended after the screen clear so callers can
    // auto-launch a process (e.g. "claude") inside the prepared shell.
    let init_suffix = init_cmd
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!("; {}", s))
        .unwrap_or_default();
    let osc7 = format!(
        "__bsc_osc7() {{ printf $'\\033]7;file://localhost%s\\a' \"$(pwd)\"; }}; \
         __bsc_state() {{ printf $'\\033]100;%s\\a' \"$1\"; }}; \
         claude() {{ __bsc_state run; command claude \"$@\"; }}; \
         PROMPT_COMMAND=\"${{PROMPT_COMMAND:+$PROMPT_COMMAND; }}__bsc_osc7; __bsc_state idle\"; \
         __bsc_osc7; __bsc_state idle; printf '\\033[2J\\033[H'{init_suffix}\n"
    );
    writer.write_all(osc7.as_bytes()).ok();

    // Stream PTY output to frontend via Tauri events
    let pane_id_r = pane_id.clone();
    let app_r = app.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_r.emit(&format!("pty_data_{}", pane_id_r), text);
                }
            }
        }
        let _ = app_r.emit(&format!("pty_exit_{}", pane_id_r), ());
    });

    state.0.lock().unwrap()
        .insert(pane_id, PtySession { writer, master: pair.master, _child: child });
    Ok(true)
}

#[tauri::command]
async fn pty_write(
    pane_id: String,
    data: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    if let Some(s) = sessions.get_mut(&pane_id) {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn pty_resize(
    pane_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    if let Some(s) = sessions.get(&pane_id) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn pty_kill(pane_id: String, state: State<'_, PtyState>) -> Result<(), String> {
    state.0.lock().unwrap().remove(&pane_id);
    Ok(())
}

// ── Git info ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct GitInfo {
    repo: String,
    branch: String,
    dirty: bool,
}

#[tauri::command]
async fn git_info(path: String) -> Option<GitInfo> {
    let root_out = std::process::Command::new("git")
        .args(["-C", &path, "rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !root_out.status.success() {
        return None;
    }
    let root_str = std::str::from_utf8(&root_out.stdout).ok()?.trim();
    let repo = std::path::Path::new(root_str)
        .file_name()?
        .to_string_lossy()
        .into_owned();

    let branch_out = std::process::Command::new("git")
        .args(["-C", &path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    let branch = std::str::from_utf8(&branch_out.stdout)
        .ok()?
        .trim()
        .to_string();

    let status_out = std::process::Command::new("git")
        .args(["-C", &path, "status", "--porcelain"])
        .output()
        .ok()?;
    let dirty = !status_out.stdout.is_empty();

    Some(GitInfo { repo, branch, dirty })
}

// ── File picker ───────────────────────────────────────────────────────────────

#[tauri::command]
async fn pick_directory() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

// ── Claude API (knowledge store) ─────────────────────────────────────────────

#[tauri::command]
async fn kb_chat(
    messages: Vec<serde_json::Value>,
    system: String,
    tools: Vec<serde_json::Value>,
    api_key: String,
) -> Result<serde_json::Value, String> {
    if api_key.is_empty() {
        return Err("No API key configured. Add it in Settings → Integrations.".to_string());
    }
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 4096,
        "system": system,
        "messages": messages,
        "tools": tools,
    });
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let err = json["error"]["message"]
            .as_str()
            .unwrap_or("Unknown error")
            .to_string();
        return Err(format!("API error ({}): {}", status, err));
    }
    Ok(json)
}

// ── GitHub proxy ──────────────────────────────────────────────────────────────

#[tauri::command]
async fn github_graphql(
    token: String,
    query: String,
    variables: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    let client = reqwest::Client::new();
    let mut body = serde_json::json!({ "query": query });
    if let Some(vars) = variables {
        body["variables"] = vars;
    }
    let response = client
        .post("https://api.github.com/graphql")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "base-studio-code/0.2.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        return Err(format!("GitHub API error ({}): {}", status, msg));
    }
    if let Some(errors) = json.get("errors") {
        if errors.is_array() && !errors.as_array().unwrap().is_empty() {
            let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error").to_string();
            return Err(format!("GraphQL error: {}", msg));
        }
    }
    Ok(json["data"].clone())
}

#[tauri::command]
async fn github_post(
    token: String,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/{}", path);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "base-studio-code/0.2.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        return Err(format!("GitHub API error ({}): {}", status, msg));
    }
    Ok(json)
}

#[tauri::command]
async fn github_request(token: String, path: String) -> Result<serde_json::Value, String> {
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/{}", path);
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "base-studio-code/0.2.0")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        return Err(format!("GitHub API error ({}): {}", status, msg));
    }
    Ok(json)
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(PtyState(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            kb_chat,
            github_request,
            github_graphql,
            github_post,
            pty_create,
            pty_write,
            pty_resize,
            pty_kill,
            pick_directory,
            git_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn pane_id_format_matches_frontend_convention() {
        // The frontend uses `t${tabIdx}p${paneIdx}` as the pane ID key.
        // Verify the format matches for several indices.
        assert_eq!(format!("t{}p{}", 0, 0), "t0p0");
        assert_eq!(format!("t{}p{}", 1, 3), "t1p3");
        assert_eq!(format!("t{}p{}", 2, 8), "t2p8");
    }

    #[test]
    fn osc7_path_strip_removes_scheme_and_host() {
        // Mirrors what TerminalView.tsx does in the browser:
        // data.replace(/^file:\/\/[^/]*/, "")
        let input = "file://localhost/c/Users/Kevin/project";
        let stripped = input.trim_start_matches("file://").splitn(2, '/').nth(1)
            .map(|s| format!("/{}", s))
            .unwrap_or_default();
        assert_eq!(stripped, "/c/Users/Kevin/project");
    }
}
