//! `bsc-agent` — the model-agnostic agent runtime (epic #1078, P2). A lean CLI that
//! runs a tool-using agent loop against any provider in `bsc-llm`. Configured by env
//! (so the app can launch it like `bsc-plan`): `BSC_AGENT_PROVIDER` (default
//! `anthropic`), `BSC_AGENT_MODEL`, `BSC_AGENT_API_KEY`. The task comes from argv (or
//! stdin); the system prompt is `CLAUDE.md` in the cwd if present. Output goes to
//! stdout — it runs inside the PTY like `claude` does.

mod agent;

use agent::{read_file_tool, run_agent};
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
    let tools = vec![read_file_tool()];

    let kind = match llm::resolve_provider(&provider) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("bsc-agent: {e}");
            std::process::exit(2);
        }
    };

    let result = match kind {
        llm::ProviderKind::Anthropic => {
            run_agent(&llm::AnthropicProvider, &api_key, &model, &system, &task, &tools, 20).await
        }
        llm::ProviderKind::OpenAi => {
            run_agent(&llm::OpenAiProvider, &api_key, &model, &system, &task, &tools, 20).await
        }
        llm::ProviderKind::Gemini => {
            run_agent(&llm::GeminiProvider, &api_key, &model, &system, &task, &tools, 20).await
        }
        llm::ProviderKind::Local => {
            let p = llm::LocalProvider { base_url: llm::DEFAULT_LOCAL_BASE_URL.into() };
            run_agent(&p, &api_key, &model, &system, &task, &tools, 20).await
        }
    };

    if let Err(e) = result {
        eprintln!("bsc-agent: {e}");
        std::process::exit(1);
    }
}
