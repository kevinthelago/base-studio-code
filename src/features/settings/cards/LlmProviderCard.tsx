import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import {
  providerNeedsBscAgent, LLM_PROVIDERS,
  DEFAULT_ANTHROPIC_MODEL, DEFAULT_LOCAL_MODEL, DEFAULT_LOCAL_BASE_URL,
  type LlmProvider,
} from "@/shared/lib/core/llmConfig";
import { Card } from "@/shared/ui/data/Card";
import { Grid } from "@/shared/ui/layout/Grid";
import { Row } from "@/shared/ui/layout/Row";
import { Button } from "@/shared/ui/controls/Button";
import { Field, TextField, SelectField } from "@/shared/ui/controls/Field";
import { Box } from "@/shared/ui/layout/Box";

// The provider list + placeholders live in `@data/console/model-defaults.json` (#2416), consumed
// via `LLM_PROVIDERS` / the `DEFAULT_*` model constants from `@/shared/lib/core/llmConfig` — the
// one source for every model default; nothing model-shaped is authored here.
const keyPlaceholder = (p: LlmProvider): string =>
  LLM_PROVIDERS.find((o) => o.id === p)?.keyPlaceholder ?? "";

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
    <Card title="LLM provider" hint={<>Powers planning &amp; assistant calls (autopilot, grader, cleanup).</>}>
      <Grid cols="1.4fr 1fr" gap={14}>
        <SelectField label="Provider" value={llmProvider} onChange={(v) => setLlmProvider(v as LlmProvider)}>
          {LLM_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </SelectField>
        <TextField
          label="Model"
          value={llmModel}
          onChange={setLlmModel}
          placeholder={isLocal ? DEFAULT_LOCAL_MODEL : DEFAULT_ANTHROPIC_MODEL}
          list={isLocal ? "ollama-models" : undefined}
        />
        {/* the datalist is display:none, so as a grid sibling it generates no box/track */}
        {isLocal && models.length > 0 && (
          <datalist id="ollama-models">
            {models.map((m) => <option key={m} value={m} />)}
          </datalist>
        )}
        {isLocal && (
          <Box style={{ gridColumn: "1 / -1" }}>
            <TextField
              label="Base URL"
              value={localBaseUrl}
              onChange={setLocalBaseUrl}
              placeholder={DEFAULT_LOCAL_BASE_URL}
              trailing={
                <Button onClick={testConnection} disabled={testing}>
                  {testing ? "testing…" : "test"}
                </Button>
              }
              hint={testMsg || (llmProvider === "ollama" ? "Ollama port / API URL." : "OpenAI-compatible endpoint (e.g. Ollama).")}
            />
          </Box>
        )}
        <Box style={{ gridColumn: "1 / -1" }}>
          {(llmProvider === "local" || llmProvider === "ollama") ? (
            <Field label="API key" hint={<>Local provider — no API key needed; set the <b>Base URL</b> above.</>}>{null}</Field>
          ) : (
            <TextField
              label="API key"
              type="password"
              value={providerKey}
              onChange={setProviderKey}
              placeholder={keyPlaceholder(llmProvider)}
              trailing={<><Button>show</Button><Button>test</Button></>}
              hint="Stored in OS keyring · never written to disk in plaintext. The per-pane agent model lives in Settings → General."
            />
          )}
        </Box>
        <Box style={{ gridColumn: "1 / -1" }}>
          {/* A local/ollama provider can't run on Claude Code, so it forces bsc-agent — the planner,
              workers, and director all run on the selected LLM. Lock the control + say so. */}
          <SelectField
            label="Run the agent fleet on"
            value={providerNeedsBscAgent(llmProvider) ? "bsc-agent" : fleetHarness}
            disabled={providerNeedsBscAgent(llmProvider)}
            onChange={(v) => setFleetHarness(v as "claude" | "bsc-agent")}
            hint={providerNeedsBscAgent(llmProvider)
              ? "Locked to bsc-agent — the selected local provider runs the planner, workers, and director on the LLM above, with the same role permissions, MCP, and context."
              : "Planner, workers + director launch on this harness; bsc-agent runs on the selected LLM with the same role permissions, MCP, and context."}
          >
            <option value="claude">Claude Code (default)</option>
            <option value="bsc-agent">bsc-agent — the provider/model above</option>
          </SelectField>
        </Box>
        <Field label="Per-agent context cap">
          {/* eslint-disable-next-line no-restricted-syntax -- uncontrolled defaultValue placeholder input; TextField requires controlled value/onChange */}
          <input className="input" defaultValue="64000" />
        </Field>
        <Field label="Monthly spend cap">
          {/* eslint-disable-next-line no-restricted-syntax -- uncontrolled defaultValue placeholder input; TextField requires controlled value/onChange */}
          <input className="input" defaultValue="$150" />
        </Field>
        <Field label="Extended thinking" style={{ gridColumn: "1 / -1" }}
          hint="Off for haiku regardless of this setting.">
          <Row gap={6} align="stretch">
            {(["off", "auto", "always"] as const).map((v, i) => (
              <Button key={v} style={{
                flex: 1, justifyContent: "center",
                background: i === 1 ? "var(--bg-elev2)" : "var(--bg-elev)",
                borderColor: i === 1 ? "var(--accent-dim)" : "var(--border-soft)",
                color: i === 1 ? "var(--accent)" : "var(--fg)",
              }}>{v}</Button>
            ))}
          </Row>
        </Field>
      </Grid>
    </Card>
  );
}
