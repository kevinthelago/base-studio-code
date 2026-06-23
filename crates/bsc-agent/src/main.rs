//! `bsc-agent` — the model-agnostic agent runtime (epic #1078, P2). A lean CLI that
//! runs a tool-using agent loop against any provider in `bsc-llm`. Configured by env
//! (so the app can launch it like `bsc-plan`): `BSC_AGENT_PROVIDER` (default
//! `anthropic`), `BSC_AGENT_MODEL`, `BSC_AGENT_API_KEY`. The task comes from argv (or
//! stdin); the system prompt is `CLAUDE.md` in the cwd if present. Output goes to
//! stdout — it runs inside the PTY like `claude` does.

mod agent;
mod permissions;
mod telemetry;

use agent::{bash_tool, edit_file_tool, read_file_tool, run_agent, write_file_tool};
use std::io::Read;

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

    // System prompt from the project's CLAUDE.md, if any (same context file the
    // planner/agents already author). Absent ⇒ empty.
    let system = std::fs::read_to_string("CLAUDE.md").unwrap_or_default();
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
