import { useAppStore } from "../../store";
import { ToggleRow } from "./General";
import type { LlmProvider } from "../../lib/core/llmConfig";

const LLM_PROVIDERS: [LlmProvider, string][] = [
  ["anthropic", "Anthropic Claude"],
  ["openai",    "OpenAI"],
  ["gemini",    "Google Gemini"],
  ["local",     "Local (Ollama / OpenAI-compatible)"],
];
const KEY_PLACEHOLDER: Record<LlmProvider, string> = {
  anthropic: "sk-ant-…", openai: "sk-…", gemini: "AIza…", local: "",
};

const TOOLS: [string, string, boolean][] = [
  ["read",    "Read files inside cwd",                  true  ],
  ["write",   "Write & patch files",                    true  ],
  ["bash",    "Run shell commands (sandboxed)",          true  ],
  ["git",     "Local git operations",                   true  ],
  ["gh",      "Authenticated GitHub API calls",         true  ],
  ["kb",      "Read/write Knowledge blocks",            true  ],
  ["http",    "Outbound HTTP (allowlisted hosts)",      false ],
  ["browser", "Headless browsing for docs",             false ],
];

export function IntegrationsSettings() {
  const { claudeApiKey, setClaudeApiKey, autoPlanWithClaude, setAutoPlanWithClaude } = useAppStore();
  const autoCompleteGates = useAppStore(s => s.autoCompleteGates);
  const setAutoCompleteGates = useAppStore(s => s.setAutoCompleteGates);
  const llmProvider = useAppStore(s => s.llmProvider);
  const setLlmProvider = useAppStore(s => s.setLlmProvider);
  const llmModel = useAppStore(s => s.llmModel);
  const setLlmModel = useAppStore(s => s.setLlmModel);
  const openaiKey = useAppStore(s => s.openaiKey);
  const setOpenaiKey = useAppStore(s => s.setOpenaiKey);
  const geminiKey = useAppStore(s => s.geminiKey);
  const setGeminiKey = useAppStore(s => s.setGeminiKey);
  const localBaseUrl = useAppStore(s => s.localBaseUrl);
  const setLocalBaseUrl = useAppStore(s => s.setLocalBaseUrl);
  // The key for the selected provider (anthropic reuses claudeApiKey; local needs none).
  const providerKey = llmProvider === "openai" ? openaiKey : llmProvider === "gemini" ? geminiKey : llmProvider === "anthropic" ? claudeApiKey : "";
  const setProviderKey = (v: string) => {
    if (llmProvider === "openai") setOpenaiKey(v);
    else if (llmProvider === "gemini") setGeminiKey(v);
    else if (llmProvider === "anthropic") setClaudeApiKey(v);
  };
  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Integrations</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        External services your agents can reach.
      </p>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>LLM provider</h3>
          <span className="hint">Powers planning &amp; assistant calls (autopilot, grader, cleanup).</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
          <div className="field">
            <label>Provider</label>
            <select className="input" value={llmProvider} onChange={(e) => setLlmProvider(e.target.value as LlmProvider)}>
              {LLM_PROVIDERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Model</label>
            <input
              className="input"
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              placeholder="claude-sonnet-4-6"
            />
          </div>
          {llmProvider === "local" && (
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>Base URL</label>
              <input
                className="input"
                value={localBaseUrl}
                onChange={(e) => setLocalBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
              />
              <div className="hint">OpenAI-compatible endpoint (e.g. Ollama).</div>
            </div>
          )}
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>API key</label>
            {llmProvider === "local" ? (
              <div className="hint">Local provider — no API key needed; set the <b>Base URL</b> above.</div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input"
                    type="password"
                    value={providerKey}
                    onChange={(e) => setProviderKey(e.target.value)}
                    placeholder={KEY_PLACEHOLDER[llmProvider]}
                  />
                  <button className="btn">show</button>
                  <button className="btn">test</button>
                </div>
                <div className="hint">Stored in OS keyring · never written to disk in plaintext. The per-pane agent model lives in Settings → General.</div>
              </>
            )}
          </div>
          <div className="field">
            <label>Per-agent context cap</label>
            <input className="input" defaultValue="64000" />
          </div>
          <div className="field">
            <label>Monthly spend cap</label>
            <input className="input" defaultValue="$150" />
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>Extended thinking</label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["off", "auto", "always"] as const).map((v, i) => (
                <button key={v} className="btn" style={{
                  flex: 1, justifyContent: "center",
                  background: i === 1 ? "var(--bg-elev2)" : "var(--bg-elev)",
                  borderColor: i === 1 ? "var(--accent-dim)" : "var(--border-soft)",
                  color: i === 1 ? "var(--accent)" : "var(--fg)",
                }}>{v}</button>
              ))}
            </div>
            <div className="hint">Off for haiku regardless of this setting.</div>
          </div>
        </div>
        <div style={{ height: 14 }} />
        <ToggleRow
          on={autoPlanWithClaude}
          onToggle={() => setAutoPlanWithClaude(!autoPlanWithClaude)}
          title="Automate planning with the LLM"
        >
          Adds an <b>Auto-plan</b> control to the project planner: from your pitch, the model
          answers its own discovery questions and drives the plan to a publishable state for
          your review — it never auto-publishes to GitHub. Runs under the least-privilege
          "Planning Autopilot" agent role. Requires an API key for the selected provider (above).
        </ToggleRow>
        <ToggleRow
          on={autoCompleteGates}
          onToggle={() => setAutoCompleteGates(!autoCompleteGates)}
          title="Auto-advance planner gates"
        >
          When a planning stage's sections are drafted and its gate is ready, confirm it
          automatically instead of clicking <b>approve &amp; continue</b> each time. You still drive
          the conversation — only the per-gate approval is automated. Off by default; steps aside
          while Auto-plan is running.
        </ToggleRow>
      </div>

      <div style={{ height: 18 }} />

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Tools available to agents</h3>
          <span className="hint">Tools the runtime exposes to Claude via the local registry.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {TOOLS.map(([n, d, on]) => (
            <div key={n} style={{
              padding: "10px 12px", borderRadius: 6,
              background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
              display: "flex", flexDirection: "column", gap: 4,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 11.5,
                  color: on ? "var(--accent)" : "var(--fg-muted)",
                }}>{n}</span>
                <span style={{ flex: 1 }} />
                <span style={{
                  width: 24, height: 14, borderRadius: 99,
                  background: on ? "var(--accent)" : "var(--bg-elev2)",
                  border: "1px solid " + (on ? "transparent" : "var(--border)"),
                  position: "relative",
                }}>
                  <span style={{
                    position: "absolute", top: 1,
                    ...(on ? { right: 1 } : { left: 1 }),
                    width: 10, height: 10, borderRadius: "50%",
                    background: on ? "#1a120a" : "var(--fg-dim)",
                  }} />
                </span>
              </div>
              <div className="hint">{d}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
