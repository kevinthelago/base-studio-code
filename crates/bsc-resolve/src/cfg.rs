//! The wire types a session's extensions are handed over as.
//!
//! Field names match the frontend payloads exactly; these are deserialized from what the renderer
//! sends and re-serialized into `.mcp.json` / `.claude/skills/<slug>/SKILL.md`, so a rename here is a
//! wire break, not a refactor.



/// One MCP server an extension contributes to a session's `.mcp.json`. Field names
/// match the frontend `McpServerPayload`.
#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct McpServerCfg {
    pub name: String,
    pub transport: String, // "stdio" | "http"
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
}
/// One lifecycle hook an extension contributes to a session's settings.json.
#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct HookCfg {
    pub event: String,   // PreToolUse | PostToolUse | …
    #[serde(default)]
    pub matcher: String, // optional tool matcher; empty = all
    pub command: String,
}
/// One reusable Skill written into a session as a Claude Code Skill file
/// (`.claude/skills/<slug>/SKILL.md`). Field names match the frontend payload.
#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct SkillCfg {
    /// The stable skilldb skill id — carried so attach-time usage counting (#A) can bump the right
    /// row. Optional (defaults empty) so older payloads / tests without it still deserialize.
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    #[serde(default)]
    pub tools: Vec<String>,
}
