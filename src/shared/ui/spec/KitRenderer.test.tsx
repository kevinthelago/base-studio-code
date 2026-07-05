import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KitRenderer } from "./KitRenderer";
import { demoSpec } from "./demoSpec";

describe("KitRenderer", () => {
  it("renders the demo card end-to-end from a spec", () => {
    render(<KitRenderer node={demoSpec} />);
    // header, field labels, row label, and the action button all render from the tree
    expect(screen.getByText("LLM provider")).toBeInTheDocument();
    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("API key")).toBeInTheDocument();
    expect(screen.getByText("Stream responses")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("reads bound values from host state", () => {
    render(<KitRenderer node={demoSpec} values={{ provider: "openai" }} />);
    expect(screen.getByRole("combobox")).toHaveValue("openai");
    // the select's options come from the spec
    expect(screen.getByRole("option", { name: "anthropic" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "openai" })).toBeInTheDocument();
  });

  it("wires a bound control's onChange back through onBind", () => {
    const onBind = vi.fn();
    render(<KitRenderer node={demoSpec} values={{ provider: "openai" }} onBind={onBind} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "anthropic" } });
    expect(onBind).toHaveBeenCalledWith("provider", "anthropic");
  });

  it("wires a password field's edits through onBind by its bind key", () => {
    const onBind = vi.fn();
    const { container } = render(<KitRenderer node={demoSpec} onBind={onBind} />);
    const pw = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pw).toBeTruthy();
    fireEvent.change(pw, { target: { value: "sk-123" } });
    expect(onBind).toHaveBeenCalledWith("apiKey", "sk-123");
  });

  it("fires the named action handler on button click", () => {
    const save = vi.fn();
    render(<KitRenderer node={demoSpec} on={{ save }} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledOnce();
  });

  it("renders nothing extra for an unknown-kind leaf (graceful)", () => {
    // The union forbids this at compile time; at runtime a bad node renders null, not a crash.
    const bad = { kind: "mystery" } as unknown as Parameters<typeof KitRenderer>[0]["node"];
    const { container } = render(<KitRenderer node={bad} />);
    expect(container).toBeEmptyDOMElement();
  });
});
