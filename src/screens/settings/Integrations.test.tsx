import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IntegrationsSettings } from "./Integrations";
import { useAppStore } from "../../store";

describe("IntegrationsSettings — LLM provider (#1085)", () => {
  beforeEach(() => {
    useAppStore.setState({
      llmProvider: "anthropic", llmModel: "claude-sonnet-4-6",
      claudeApiKey: "", openaiKey: "", geminiKey: "",
    });
  });

  it("renders the provider + model controls", () => {
    const { container } = render(<IntegrationsSettings />);
    expect(screen.getByText("LLM provider")).toBeTruthy();
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("anthropic");
  });

  it("changing the provider writes to the store", () => {
    const { container } = render(<IntegrationsSettings />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "openai" } });
    expect(useAppStore.getState().llmProvider).toBe("openai");
  });

  it("the key field writes to the selected provider's key", () => {
    useAppStore.setState({ llmProvider: "openai" });
    render(<IntegrationsSettings />);
    const key = screen.getByPlaceholderText("sk-…") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "oai-123" } });
    expect(useAppStore.getState().openaiKey).toBe("oai-123");
    expect(useAppStore.getState().claudeApiKey).toBe("");
  });

  it("local provider shows no key field", () => {
    useAppStore.setState({ llmProvider: "local" });
    render(<IntegrationsSettings />);
    expect(screen.getByText(/no API key needed/i)).toBeTruthy();
  });

  it("edits the API-tier model", () => {
    render(<IntegrationsSettings />);
    const model = screen.getByPlaceholderText("claude-sonnet-4-6") as HTMLInputElement;
    fireEvent.change(model, { target: { value: "claude-opus-4-8" } });
    expect(useAppStore.getState().llmModel).toBe("claude-opus-4-8");
  });
});
