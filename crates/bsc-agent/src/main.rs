//! `bsc-agent` — the model-agnostic agent runtime (epic #1078, P2). A lean CLI that
//! runs a tool-using agent loop against any provider in `bsc-llm`. Configured by env
//! (so the app can launch it like `bsc-plan`): `BSC_AGENT_PROVIDER` (default
//! `anthropic`), `BSC_AGENT_MODEL`, `BSC_AGENT_API_KEY`. The task comes from argv (or
//! stdin); the system prompt is the `CLAUDE.md` chain (cwd + ancestors) + `CLAUDE.local.md`,
//! matching Claude Code's context loading. Output goes to
//! stdout — it runs inside the PTY like `claude` does.

mod agent;
mod permissions;
mod telemetry;

use agent::{bash_tool, edit_file_tool, read_file_tool, run_agent, write_file_tool};
use std::io::Read;
use std::path::Path;

/// Compose the system prompt the way Claude Code does: every `CLAUDE.md` from the filesystem root
/// down to `start` (most-specific last), then `start/CLAUDE.local.md` (the plan / local overrides
/// copied into worker worktrees). Absent/empty files are skipped. (#1078 P3 context parity)
fn compose_system(start: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut dirs: Vec<&Path> = start.ancestors().collect();
    dirs.reverse(); // root first, `start` last — the most-specific CLAUDE.md appears last
    for d in dirs {
        if let Ok(c) = std::fs::read_to_string(d.join("CLAUDE.md")) {
            if !c.trim().is_empty() {
                parts.push(c);
            }
        }
    }
    if let Ok(c) = std::fs::read_to_string(start.join("CLAUDE.local.md")) {
        if !c.trim().is_empty() {
            parts.push(c);
        }
    }
    parts.join("\n\n")
}

#[tokio::main]
async fn main() {
    let provider = std::env::var("BSC_AGENT_PROVIDER").unwrap_or_else(|_| "anthropic".into());
    let model = std::env::var("BSC_AGENT_MODEL").unwrap_or_default();
    let api_key = std::env::var("BSC_AGENT_API_KEY").unwrap_or_default();

    // Task: argv (joined) if given, else stdin.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let task = if argv.is_empty() {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s.trim().to_string()
    } else {
        argv.join(" ")
    };
    if task.is_empty() {
        eprintln!("usage: bsc-agent <task>   (or pipe the task on stdin)");
        std::process::exit(2);
    }

    // System prompt = the CLAUDE.md chain (ancestors + cwd) + CLAUDE.local.md (the plan),
    // matching Claude Code's context loading so a bsc-agent worker sees the same context.
    let system = compose_system(&std::env::current_dir().unwrap_or_default());
    let tools = vec![read_file_tool(), write_file_tool(), edit_file_tool(), bash_tool()];
    // Least-privilege gate ($BSC_AGENT_PERMS); permissive when unset.
    let perms = permissions::Permissions::from_env();
    // Native telemetry: audit.log + tokens.log + transcript ($BSC_AUDIT_LOG / $BSC_TOKENS_LOG);
    // no-op when those aren't set. Emits the contracts the app's readers already consume.
    let tele = telemetry::Telemetry::from_env();

    let kind = match llm::resolve_provider(&provider) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("bsc-agent: {e}");
            std::process::exit(2);
        }
    };

    let result = match kind {
        llm::ProviderKind::Anthropic => {
            run_agent(&llm::AnthropicProvider, &api_key, &model, &system, &task, &tools, &perms, &tele, 20).await
        }
        llm::ProviderKind::OpenAi => {
            run_agent(&llm::OpenAiProvider, &api_key, &model, &system, &task, &tools, &perms, &tele, 20).await
        }
        llm::ProviderKind::Gemini => {
            run_agent(&llm::GeminiProvider, &api_key, &model, &system, &task, &tools, &perms, &tele, 20).await
        }
        llm::ProviderKind::Local => {
            // The OpenAI-compatible endpoint for local models — $BSC_AGENT_BASE_URL (set by the
            // app from the user's config), falling back to Ollama's default when unset/empty.
            let base_url = std::env::var("BSC_AGENT_BASE_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| llm::DEFAULT_LOCAL_BASE_URL.into());
            let p = llm::LocalProvider { base_url };
            run_agent(&p, &api_key, &model, &system, &task, &tools, &perms, &tele, 20).await
        }
    };

    if let Err(e) = result {
        eprintln!("bsc-agent: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::compose_system;
    use std::fs;

    #[test]
    fn composes_ancestor_chain_then_local() {
        let base = std::env::temp_dir().join(format!("bsc-agent-ctx-{}", std::process::id()));
        let inner = base.join("repo").join("worktree");
        fs::create_dir_all(&inner).unwrap();
        fs::write(base.join("repo").join("CLAUDE.md"), "OUTER").unwrap();
        fs::write(inner.join("CLAUDE.md"), "INNER").unwrap();
        fs::write(inner.join("CLAUDE.local.md"), "LOCAL").unwrap();

        let s = compose_system(&inner);
        let (oi, ii, li) = (s.find("OUTER"), s.find("INNER"), s.find("LOCAL"));
        assert!(oi.is_some() && ii.is_some() && li.is_some(), "all present: {s}");
        // ancestor CLAUDE.md before cwd CLAUDE.md before CLAUDE.local.md
        assert!(oi < ii && ii < li, "ordering: {s}");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn includes_local_even_without_cwd_claude_md() {
        let dir = std::env::temp_dir().join(format!("bsc-agent-local-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("CLAUDE.local.md"), "PLAN-ONLY-MARKER").unwrap();
        assert!(compose_system(&dir).contains("PLAN-ONLY-MARKER"));
        let _ = fs::remove_dir_all(&dir);
    }
}
