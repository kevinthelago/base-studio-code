// Claude config file management (extracted from lib.rs, #758).
//
// ~/.claude.json trust state (guarded by CLAUDE_JSON_LOCK, written atomically) +
// CLAUDE.md / settings.json for global and per-repo targets.

use crate::home_dir;

/// Serializes the app's read-modify-write of `~/.claude.json` so concurrent
/// session launches (each `pty_create` calls `trust_claude_dir`) don't interleave
/// writes with each other.
static CLAUDE_JSON_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Returns valid, pretty-printed JSON for `content`: the content re-serialized if
/// it already parses; otherwise the leading JSON value with any trailing junk
/// dropped (the common `<valid JSON><junk>` corruption); otherwise `None`.
fn repair_claude_json(content: &str) -> Option<String> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(content) {
        return serde_json::to_string_pretty(&v).ok();
    }
    serde_json::Deserializer::from_str(content)
        .into_iter::<serde_json::Value>()
        .next()
        .and_then(|r| r.ok())
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
}

/// Ensures `~/.claude.json` is valid JSON (Claude CLI aborts on startup when it
/// isn't). Rather than wiping the user's config to `{}`, this keeps the leading
/// valid object and drops trailing junk where possible, only resetting to `{}`
/// when nothing parses. Safe to call before any PTY session that runs claude.
pub(crate) fn sanitize_claude_config() {
    let path = home_dir().join(".claude.json");
    if !path.exists() { return; }
    let _guard = CLAUDE_JSON_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(content) = std::fs::read_to_string(&path) else { return; };
    if serde_json::from_str::<serde_json::Value>(&content).is_ok() { return; }
    let (json, what) = match repair_claude_json(&content) {
        Some(j) => (j, "repaired (dropped trailing junk)"),
        None    => ("{}".to_string(), "unrecoverable; reset to {}"),
    };
    let _ = crate::platform::fsx::atomic_write(&path, json.as_bytes());
    log::warn!("sanitize_claude_config: ~/.claude.json {what}");
}

/// Normalises a filesystem path to the form Claude Code uses as a *key* in the
/// `projects` map of `~/.claude.json`: forward slashes, an upper-case Windows
/// drive letter, no `\\?\` verbatim prefix, and no trailing slash (e.g.
/// `C:\Users\Kevin\proj` → `C:/Users/Kevin/proj`). The key must match exactly
/// or Claude Code treats the directory as unseen and re-shows the trust prompt.
///
/// NOT to be confused with [`crate::agent::launch::claude_project_dir_name`] (`launch.rs`): that maps
/// the same cwd to the *directory name* under `~/.claude/projects/` (every non-alnum char → `-`,
/// `C:/Users/Kevin/proj` → `C--Users-Kevin-proj`). Two deliberately distinct cwd→identifier transforms
/// for two distinct Claude Code on-disk contracts (the `~/.claude.json` map key vs. the projects dir).
fn claude_project_key(path: &str) -> String {
    let mut s = path.replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    if s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic() {
        s = format!("{}{}", s[..1].to_uppercase(), &s[1..]);
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

/// Sets `projects[key].hasTrustDialogAccepted = true` in a parsed `~/.claude.json`
/// value, creating the `projects` map and the per-directory entry if absent and
/// preserving every other field (history, allowedTools, sibling projects, …).
///
/// Returns `true` if the value was changed, `false` if `key` was already trusted
/// (so the caller can skip an unnecessary write and shrink the clobber window
/// against a concurrently-running `claude`).
fn mark_dir_trusted(config: &mut serde_json::Value, key: &str) -> bool {
    use serde_json::{Map, Value};
    crate::platform::fsx::ensure_object(config);
    let obj = config.as_object_mut().unwrap();
    let projects = obj.entry("projects").or_insert_with(|| Value::Object(Map::new()));
    crate::platform::fsx::ensure_object(projects);
    let entry = projects.as_object_mut().unwrap()
        .entry(key.to_string()).or_insert_with(|| Value::Object(Map::new()));
    crate::platform::fsx::ensure_object(entry);
    let entry = entry.as_object_mut().unwrap();
    if entry.get("hasTrustDialogAccepted") == Some(&Value::Bool(true)) {
        return false;
    }
    entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
    true
}

/// Pre-accepts Claude Code's per-directory trust prompt for `cwd` so a `claude`
/// session auto-launched there starts already trusted (no blocking "Do you
/// trust the files in this folder?" dialog).
///
/// Merges into the existing `~/.claude.json` rather than replacing it, and
/// refuses to touch a non-empty file it can't parse (leaving recovery to
/// [`sanitize_claude_config`]) so a corrupt config is never clobbered here.
/// No-op for an empty `cwd` or when the directory is already trusted.
pub(crate) fn trust_claude_dir(cwd: &str) {
    if cwd.is_empty() { return; }
    // Serialize with sanitize_claude_config and other concurrent launches so the
    // read-modify-write can't interleave and corrupt the file.
    let _guard = CLAUDE_JSON_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = home_dir().join(".claude.json");
    let mut config = match std::fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(v) => v,
            Err(e) => { log::warn!("trust_claude_dir: ~/.claude.json unparseable ({e}); skipping"); return; }
        },
        Err(_) => serde_json::json!({}), // missing file → start fresh
    };
    let key = claude_project_key(cwd);
    if !mark_dir_trusted(&mut config, &key) { return; }
    match crate::platform::fsx::atomic_write_json(&path, &config) {
        Ok(())  => log::info!("trust_claude_dir: pre-trusted {key}"),
        Err(e)  => log::warn!("trust_claude_dir: write {} failed: {e}", path.display()),
    }
}

// Reads and writes CLAUDE.md + .claude/settings.json for two target types:
//   global   — local_path = "" → ~/.claude/CLAUDE.md and ~/.claude/settings.json
//   per-repo — local_path = repo root → {root}/CLAUDE.md and {root}/.claude/settings.json

fn claude_paths(local_path: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    if local_path.is_empty() {
        let global = home_dir().join(".claude");
        (global.join("CLAUDE.md"), global.join("settings.json"))
    } else {
        let base = std::path::PathBuf::from(local_path);
        (base.join("CLAUDE.md"), base.join(".claude").join("settings.json"))
    }
}

#[derive(serde::Serialize)]
pub(crate) struct ClaudeConfigData {
    instructions: String,
    allow:        Vec<String>,
    deny:         Vec<String>,
}

#[tauri::command]
pub(crate) fn read_claude_config(local_path: String) -> Result<ClaudeConfigData, String> {
    let (md_path, settings_path) = claude_paths(&local_path);

    let instructions = std::fs::read_to_string(&md_path).unwrap_or_default();

    let (allow, deny) = if settings_path.exists() {
        let raw = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
        let parse_list = |key: &str| -> Vec<String> {
            v["permissions"][key].as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        (parse_list("allow"), parse_list("deny"))
    } else {
        (vec![], vec![])
    };

    Ok(ClaudeConfigData { instructions, allow, deny })
}

#[tauri::command]
pub(crate) fn write_claude_config(
    local_path: String,
    instructions: String,
    allow: Vec<String>,
    deny: Vec<String>,
) -> Result<(), String> {
    let (md_path, settings_path) = claude_paths(&local_path);

    if let Some(parent) = md_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    crate::platform::fsx::atomic_write(&md_path, instructions.as_bytes()).map_err(|e| e.to_string())?;

    let settings = serde_json::json!({
        "permissions": { "allow": allow, "deny": deny }
    });
    crate::platform::fsx::atomic_write_json(&settings_path, &settings).map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {

    use super::{claude_project_key, mark_dir_trusted};

    #[test]
    fn claude_project_key_uses_forward_slashes_and_upper_drive() {
        // Backslashes → forward slashes; lower-case drive → upper, matching the
        // form Claude Code writes (verified against a real ~/.claude.json).
        assert_eq!(claude_project_key(r"C:\Users\Kevin\proj"), "C:/Users/Kevin/proj");
        assert_eq!(claude_project_key("c:/Users/Kevin/proj"), "C:/Users/Kevin/proj");
        // Already-canonical paths pass through unchanged.
        assert_eq!(
            claude_project_key("C:/Users/Kevin/.base-studio-code/repos/x"),
            "C:/Users/Kevin/.base-studio-code/repos/x"
        );
    }

    #[test]
    fn claude_project_key_strips_trailing_slash_and_verbatim_prefix() {
        assert_eq!(claude_project_key("C:/Users/Kevin/proj/"), "C:/Users/Kevin/proj");
        assert_eq!(claude_project_key(r"\\?\C:\Users\Kevin\proj"), "C:/Users/Kevin/proj");
        assert_eq!(claude_project_key("/"), "/"); // bare root preserved
    }

    #[test]
    fn mark_dir_trusted_creates_projects_entry_when_absent() {
        let mut cfg = serde_json::json!({});
        assert!(mark_dir_trusted(&mut cfg, "C:/Users/Kevin/proj"));
        assert_eq!(
            cfg["projects"]["C:/Users/Kevin/proj"]["hasTrustDialogAccepted"],
            serde_json::Value::Bool(true)
        );
    }

    #[test]
    fn mark_dir_trusted_preserves_other_fields_and_sibling_projects() {
        let mut cfg = serde_json::json!({
            "numStartups": 7,
            "projects": {
                "C:/other": { "allowedTools": ["Read"], "hasTrustDialogAccepted": true },
                "C:/proj":  { "allowedTools": ["Edit"], "history": [{ "display": "hi" }] }
            }
        });
        assert!(mark_dir_trusted(&mut cfg, "C:/proj"));
        // Target gains trust without losing its existing fields …
        assert_eq!(cfg["projects"]["C:/proj"]["hasTrustDialogAccepted"], serde_json::Value::Bool(true));
        assert_eq!(cfg["projects"]["C:/proj"]["allowedTools"][0], "Edit");
        assert_eq!(cfg["projects"]["C:/proj"]["history"][0]["display"], "hi");
        // … and unrelated keys / sibling projects are untouched.
        assert_eq!(cfg["numStartups"], 7);
        assert_eq!(cfg["projects"]["C:/other"]["allowedTools"][0], "Read");
    }

    #[test]
    fn mark_dir_trusted_is_noop_when_already_trusted() {
        let mut cfg = serde_json::json!({ "projects": { "C:/proj": { "hasTrustDialogAccepted": true } } });
        assert!(!mark_dir_trusted(&mut cfg, "C:/proj"));
    }

    #[test]
    fn mark_dir_trusted_flips_existing_false_to_true() {
        let mut cfg = serde_json::json!({ "projects": { "C:/proj": { "hasTrustDialogAccepted": false } } });
        assert!(mark_dir_trusted(&mut cfg, "C:/proj"));
        assert_eq!(cfg["projects"]["C:/proj"]["hasTrustDialogAccepted"], serde_json::Value::Bool(true));
    }

    use super::repair_claude_json;

    #[test]
    fn repair_claude_json_passes_through_valid() {
        let out = repair_claude_json(r#"{"a":1,"b":[2,3]}"#).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap()["a"], 1);
    }

    #[test]
    fn repair_claude_json_drops_trailing_junk() {
        // The observed corruption: a complete object followed by stray bytes.
        let out = repair_claude_json("{\"a\":1}\n}garbage").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["a"], 1);
        assert!(v.get("garbage").is_none());
    }

    #[test]
    fn repair_claude_json_returns_none_for_unrecoverable() {
        assert!(repair_claude_json("not json at all").is_none());
        assert!(repair_claude_json("").is_none());
    }

    #[test]
    fn repair_claude_json_handles_concurrent_write_tail() {
        // The real-world tail: a complete object, then leftover bytes from a
        // longer previous write that wasn't truncated (e.g. `}4\n  }\n}`).
        let out = repair_claude_json("{\n  \"numStartups\": 239,\n  \"ok\": true\n}4\n  }\n}").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["numStartups"], 239);
        assert_eq!(v["ok"], true);
    }
}

