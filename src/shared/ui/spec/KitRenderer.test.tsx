import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KitRenderer } from "./KitRenderer";
import { validateGeneralNode } from "./generalNode";
import { demoSpec } from "./demoSpec";

describe("KitRenderer", () => {
  // The reference spec is what an agent copies, so "it renders" is not enough — it must also pass the
  // validator the agent is told to run. A reference that renders but fails `bsc ui validate` would
  // teach every planner to emit specs the CLI rejects.
  it("the demo spec validates against the real primitive contract", () => {
    expect(validateGeneralNode(demoSpec)).toEqual([]);
  });

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
    // the select's options come from the spec, as Option nodes
    expect(screen.getByRole("option", { name: "anthropic" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "openai" })).toBeInTheDocument();
  });

  it("reads a bound boolean into a control's value prop", () => {
    render(<KitRenderer node={demoSpec} values={{ stream: true }} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  // #3500 — the handler's OWN arguments are forwarded to the named action. Without this a field's new
  // value never reaches the host and every text/select input in a data-driven UI is unwritable.
  it("forwards a change handler's new value to the named action", () => {
    const setProvider = vi.fn();
    render(<KitRenderer node={demoSpec} values={{ provider: "openai" }} on={{ setProvider }} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "anthropic" } });
    expect(setProvider).toHaveBeenCalledWith("anthropic");
  });

  it("forwards a password field's edits to its named action", () => {
    const setApiKey = vi.fn();
    const { container } = render(<KitRenderer node={demoSpec} on={{ setApiKey }} />);
    const pw = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pw).toBeTruthy();
    fireEvent.change(pw, { target: { value: "sk-123" } });
    expect(setApiKey).toHaveBeenCalledWith("sk-123");
  });

  it("fires the named action handler on button click", () => {
    const save = vi.fn();
    render(<KitRenderer node={demoSpec} on={{ save }} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledOnce();
  });

  // A silent blank is indistinguishable from "the data said render nothing" — the exact failure mode a
  // data-driven UI must not have. An unknown type renders a VISIBLE error and does not throw.
  it("renders a visible error for an unknown primitive, and does not crash", () => {
    // The `type` union rejects this at compile time; the cast simulates untrusted JSON from an agent,
    // which is where a bad node actually comes from.
    const bad = { type: "Mystery" } as unknown as Parameters<typeof KitRenderer>[0]["node"];
    render(<KitRenderer node={bad} />);
    expect(screen.getByText(/unknown primitive "Mystery"/)).toBeInTheDocument();
  });

  it("an unknown action name is a no-op, not a crash", () => {
    render(<KitRenderer node={demoSpec} on={{}} />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Save" }))).not.toThrow();
  });
});
