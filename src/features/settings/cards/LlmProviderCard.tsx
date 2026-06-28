import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { providerNeedsBscAgent, type LlmProvider } from "@/shared/lib/core/llmConfig";

export const LLM_PROVIDERS: [LlmProvider, string][] = [
  ["anthropic", "Anthropic Claude"],
  ["openai",    "OpenAI"],
  ["gemini",    "Google Gemini"],
  ["local",     "Local (Ollama / OpenAI-compatible)"],
  ["ollama",    "Ollama (Local)"],
];
export const KEY_PLACEHOLDER: Record<LlmProvider, string> = {
  anthropic: "sk-ant-…", openai: "sk-…", gemini: "AIza…", local: "", ollama: "",
};

export function LlmProviderCard() {
  const { claudeApiKey, setClaudeApiKey } = useAppStore();
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
  const fleetHarness = useAppStore(s => s.fleetHarness);
  const setFleetHarness = useAppStore(s => s.setFleetHarness);

  const providerKey = llmProvider === "openai" ? openaiKey : llmProvider === "gemini" ? geminiKey : llmProvider === "anthropic" ? claudeApiKey : "";
  const setProviderKey = (v: string) => {
    if (llmProvider === "openai") setOpenaiKey(v);
    else if (llmProvider === "gemini") setGeminiKey(v);
    else if (llmProvider === "anthropic") setClaudeApiKey(v);
  };

  // Local-model preflight (#1830): probe the Ollama endpoint for its installed models — surfaces a
  // down server / wrong URL HERE (before a session hits it mid-task) and offers the model names as
  // suggestions for the free-text model field below.
  const isLocal = providerNeedsBscAgent(llmProvider);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState("");
  const [models, setModels] = useState<string[]>([]);

  const testConnection = async () => {
    setTesting(true);
    setTestMsg("");
    try {
      const found = await invoke<string[]>("ollama_models", { baseUrl: localBaseUrl });
      setModels(found);
      setTestMsg(
        found.length
          ? `✓ reachable — ${found.length} model${found.length === 1 ? "" : "s"} installed`
          : "✓ reachable — no models yet (run `ollama pull <model>`)",
      );
    } catch (e) {
      setModels([]);
      setTestMsg(`✗ ${String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
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
            placeholder={isLocal ? "qwen3-coder" : "claude-sonnet-4-6"}
            list={isLocal ? "ollama-models" : undefined}
          />
          {isLocal && models.length > 0 && (
            <datalist id="ollama-models">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
          )}
        </div>
        {isLocal && (
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>Base URL</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="input"
                value={localBaseUrl}
                onChange={(e) => setLocalBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
              />
              <button className="btn" onClick={testConnection} disabled={testing}>
                {testing ? "testing…" : "test"}
              </button>
            </div>
            <div className="hint">
              {testMsg || (llmProvider === "ollama" ? "Ollama port / API URL." : "OpenAI-compatible endpoint (e.g. Ollama).")}
            </div>
          </div>
        )}
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>API key</label>
          {(llmProvider === "local" || llmProvider === "ollama") ? (
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
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>Run the agent fleet on</label>
          {/* A local/ollama provider can't run on Claude Code, so it forces bsc-agent — the planner,
              workers, and director all run on the selected LLM. Lock the control + say so. */}
          <select
            className="input"
            value={providerNeedsBscAgent(llmProvider) ? "bsc-agent" : fleetHarness}
            disabled={providerNeedsBscAgent(llmProvider)}
            onChange={(e) => setFleetHarness(e.target.value as "claude" | "bsc-agent")}
          >
            <option value="claude">Claude Code (default)</option>
            <option value="bsc-agent">bsc-agent — the provider/model above</option>
          </select>
          <div className="hint">
            {providerNeedsBscAgent(llmProvider)
              ? "Locked to bsc-agent — the selected local provider runs the planner, workers, and director on the LLM above, with the same role permissions, MCP, and context."
              : "Planner, workers + director launch on this harness; bsc-agent runs on the selected LLM with the same role permissions, MCP, and context."}
          </div>
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
    </div>
  );
}
