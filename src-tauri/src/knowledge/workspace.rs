use crate::*;

pub(crate) const KB_CLAUDE_MD: &str = include_str!("../../templates/kb-claude.md");
/// Creates the flat reusable document library at `documents/`, writing CLAUDE.md
/// and .claude/settings.json. Safe to call on every mount — overwrites config
/// files but leaves articles alone. Returns the library path.
#[tauri::command]
pub(crate) async fn setup_kb_workspace() -> Result<String, String> {
    config::sanitize_claude_config();
    let kb_dir     = documents_dir();
    let claude_dir = kb_dir.join(".claude");
    std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        claude_dir.join("settings.json"),
        r#"{"permissions":{"allow":["Read","Write","Edit"],"deny":["Bash","WebFetch","WebSearch","MultiEdit"]}}"#,
    ).map_err(|e| e.to_string())?;
    std::fs::write(kb_dir.join("CLAUDE.md"), KB_CLAUDE_MD)
        .map_err(|e| e.to_string())?;
    Ok(kb_dir.to_string_lossy().into_owned())
}
