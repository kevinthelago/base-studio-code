import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { LlmProviderCard } from "./LlmProviderCard";

// #1830: the local-model preflight — the "test" button probes /api/tags via the ollama_models
// command, surfacing a reachable endpoint + installed models (offered as model-field suggestions),
// or a friendly error, instead of a typo'd model / down server only showing up mid-session.
describe("LlmProviderCard — Ollama preflight (#1830)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({ llmProvider: "ollama", localBaseUrl: "http://localhost:11434/v1", llmModel: "" });
  });

  it("lists installed models + offers them as datalist suggestions", async () => {
    vi.mocked(invoke).mockResolvedValue(["llama3.1:8b", "qwen3-coder:latest"]);
    render(<LlmProviderCard />);
    fireEvent.click(screen.getByRole("button", { name: "test" }));

    await waitFor(() => screen.getByText(/2 models installed/));
    expect(invoke).toHaveBeenCalledWith("ollama_models", { baseUrl: "http://localhost:11434/v1" });
    // discovered models become datalist <option>s for the free-text model field
    expect(document.querySelector('datalist#ollama-models option[value="qwen3-coder:latest"]')).toBeInTheDocument();
  });

  it("surfaces an unreachable endpoint as an error, not a crash", async () => {
    vi.mocked(invoke).mockRejectedValue("Request failed: connection refused");
    render(<LlmProviderCard />);
    fireEvent.click(screen.getByRole("button", { name: "test" }));

    await waitFor(() => screen.getByText(/Request failed/));
  });
});
