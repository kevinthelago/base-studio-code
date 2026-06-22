//! Native permission enforcement (epic #1078, P2c). `bsc-agent` renders the generic
//! role model itself — deny whole tools, deny `bash` commands by pattern, and restrict
//! `write_file`/`edit_file` to a set of path globs — instead of relying on a harness
//! config file (`.claude/settings.json`). Loaded from `$BSC_AGENT_PERMS` (a JSON file
//! path or inline JSON); anything unset/empty/unparseable yields the permissive
//! default (allow everything), so an unconfigured session behaves exactly as before.

use serde::Deserialize;
use serde_json::Value;

/// The session's permission set. All-empty (the [`Default`]) is permissive.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct Permissions {
    /// Tool names that may never run (e.g. `["bash"]` for a read-only role).
    #[serde(default)]
    pub deny_tools: Vec<String>,
    /// Substrings that, if present in a `bash` command, deny it (e.g. `["rm -rf", "git push"]`).
    #[serde(default)]
    pub deny_bash: Vec<String>,
    /// When non-empty, `write_file`/`edit_file` are allowed ONLY for paths matching one
    /// of these globs (e.g. `["src/**", "*.md"]`). Empty ⇒ no write-path restriction.
    #[serde(default)]
    pub write_globs: Vec<String>,
}

impl Permissions {
    /// Load from `$BSC_AGENT_PERMS`: if it names an existing file, parse that file as
    /// JSON; otherwise parse the value itself as inline JSON. Unset / empty / unparseable
    /// ⇒ the permissive default.
    pub fn from_env() -> Permissions {
        let raw = match std::env::var("BSC_AGENT_PERMS") {
            Ok(v) if !v.trim().is_empty() => v,
            _ => return Permissions::default(),
        };
        // A path to a readable file wins; otherwise treat the value as inline JSON.
        let json = std::fs::read_to_string(&raw).unwrap_or(raw);
        serde_json::from_str(&json).unwrap_or_default()
    }

    /// Whether `tool_name` (with the model-supplied `args`) is permitted. `Err(reason)`
    /// is fed back to the model as the tool result so it can adapt — it is not a crash.
    /// Pure: no env / filesystem access.
    pub fn check(&self, tool_name: &str, args: &Value) -> Result<(), String> {
        if self.deny_tools.iter().any(|t| t == tool_name) {
            return Err(format!("permission denied: tool '{tool_name}' is not allowed"));
        }
        match tool_name {
            "bash" => {
                let cmd = args["command"].as_str().unwrap_or("");
                if self.deny_bash.iter().any(|p| cmd.contains(p.as_str())) {
                    return Err("permission denied: bash command matches a denied pattern".into());
                }
            }
            "write_file" | "edit_file" if !self.write_globs.is_empty() => {
                let path = args["path"].as_str().unwrap_or("");
                let allowed = self.write_globs.iter().any(|g| {
                    glob::Pattern::new(g).map(|pat| pat.matches(path)).unwrap_or(false)
                });
                if !allowed {
                    return Err(format!(
                        "permission denied: '{path}' is outside the allowed write paths"
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn permissive_default_allows_everything() {
        let p = Permissions::default();
        assert!(p.check("bash", &json!({ "command": "rm -rf /" })).is_ok());
        assert!(p.check("write_file", &json!({ "path": "/etc/passwd" })).is_ok());
        assert!(p.check("read_file", &json!({ "path": "/anything" })).is_ok());
    }

    #[test]
    fn deny_tools_blocks_the_named_tool() {
        let p = Permissions { deny_tools: vec!["bash".into()], ..Default::default() };
        assert!(p.check("bash", &json!({ "command": "ls" })).is_err());
        assert!(p.check("read_file", &json!({ "path": "x" })).is_ok());
    }

    #[test]
    fn deny_bash_matches_substring() {
        let p = Permissions { deny_bash: vec!["rm -rf".into(), "git push".into()], ..Default::default() };
        assert!(p.check("bash", &json!({ "command": "sudo rm -rf /tmp" })).is_err());
        assert!(p.check("bash", &json!({ "command": "git push origin main" })).is_err());
        assert!(p.check("bash", &json!({ "command": "ls -la" })).is_ok());
    }

    #[test]
    fn write_globs_restrict_paths_when_set() {
        let p = Permissions { write_globs: vec!["src/**".into(), "*.md".into()], ..Default::default() };
        assert!(p.check("write_file", &json!({ "path": "src/lib.rs" })).is_ok());
        assert!(p.check("edit_file", &json!({ "path": "README.md" })).is_ok());
        assert!(p.check("write_file", &json!({ "path": "/etc/hosts" })).is_err());
        // read_file is never write-restricted.
        assert!(p.check("read_file", &json!({ "path": "/etc/hosts" })).is_ok());
    }

    #[test]
    fn empty_write_globs_means_no_write_restriction() {
        let p = Permissions::default();
        assert!(p.check("write_file", &json!({ "path": "/anywhere/x" })).is_ok());
    }
}
