

/// One MCP server an extension contributes to a session's `.mcp.json`. Field names
/// match the frontend `McpServerPayload`.
#[derive(serde::Deserialize, Clone)]
pub(crate) struct McpServerCfg {
    pub(crate) name: String,
    pub(crate) transport: String, // "stdio" | "http"
    #[serde(default)]
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) env: Vec<(String, String)>,
}
/// One lifecycle hook an extension contributes to a session's settings.json.
#[derive(serde::Deserialize, Clone)]
pub(crate) struct HookCfg {
    pub(crate) event: String,   // PreToolUse | PostToolUse | …
    #[serde(default)]
    pub(crate) matcher: String, // optional tool matcher; empty = all
    pub(crate) command: String,
}
/// One reusable Skill written into a session as a Claude Code Skill file
/// (`.claude/skills/<slug>/SKILL.md`). Field names match the frontend payload.
#[derive(serde::Deserialize, Clone)]
pub(crate) struct SkillCfg {
    /// The stable skilldb skill id — carried so attach-time usage counting (#A) can bump the right
    /// row. Optional (defaults empty) so older payloads / tests without it still deserialize.
    #[serde(default)]
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) tools: Vec<String>,
}
