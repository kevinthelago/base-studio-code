import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ModelsView } from "@/app/console/panes/views/ModelsView";

// bsc request 174: a local-model row used to push providerId "ollama" — the raw-REPL provider
// (`ollama run <model>`, no tools/skills/perms/num_ctx/CLAUDE.md chain). It must push "bsc-agent",
// the harness that actually reads BSC_AGENT_MODEL, mirroring how the Claude tier rows emit "claude".
describe("ModelsView local models (bsc request 174)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(async (cmd: unknown) => {
      if (cmd === "ollama_models") return ["llama3"];
      return null;
    });
  });

  it("emits providerId bsc-agent for a local model, not the raw ollama REPL provider", async () => {
    const onSelect = vi.fn();
    render(<ModelsView provider="claude" onSelect={onSelect} />);

    const row = await screen.findByTestId("model-choice-bsc-agent-llama3");
    fireEvent.click(row);

    expect(onSelect).toHaveBeenCalledWith("bsc-agent", "llama3");
    expect(onSelect).not.toHaveBeenCalledWith("ollama", "llama3");
  });

  it("never offers the raw ollama REPL provider as a local-model choice", async () => {
    render(<ModelsView provider="claude" />);
    await screen.findByTestId("model-choice-bsc-agent-llama3");
    expect(screen.queryByTestId("model-choice-ollama-llama3")).toBeNull();
  });
});
