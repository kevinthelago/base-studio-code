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

  // #4172 — failure containment reachable FROM A SPEC. The designer composes data trees, so a boundary
  // that only exists as an app-shell import is unreachable to it; registering the primitive is what makes
  // "a broken page does not blank its host" something a DESIGNED page can carry.
  describe("PageBoundary as a spec primitive (#4172)", () => {
    const Boom = () => { throw new Error("child exploded"); };

    it("validates as a spec node", () => {
      expect(validateGeneralNode({
        type: "PageBoundary",
        props: { page: "reports", hint: "Use the sidebar to open another report." },
        children: { type: "Text", children: "body" },
      })).toEqual([]);
    });

    it("renders its children when nothing throws", () => {
      render(<KitRenderer node={{
        type: "PageBoundary",
        props: { page: "reports" },
        children: { type: "Text", children: "the real body" },
      }} />);
      expect(screen.getByText("the real body")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("contains a throwing child, naming the page and the HOST's own recovery hint", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      // The real composition: the page wraps a SLOT the host fills — the seam a spec uses for anything
      // it cannot express itself (a feature component owning hooks/state). Here the host fills it with a
      // component that throws, which is exactly the case the boundary exists for.
      render(
        <KitRenderer
          node={{
            type: "PageBoundary",
            props: { page: "reports", hint: "Use the sidebar." },
            children: { type: "Slot", props: { name: "body" } },
          }}
          slots={{ body: <Boom /> }}
        />,
      );
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("child exploded");
      expect(alert.textContent).toContain("reports");
      // The hint is the HOST's, not this app's — #4172 moved it off the hard-coded Ctrl+←/→ wording.
      expect(alert.textContent).toContain("Use the sidebar.");
      expect(alert.textContent).not.toContain("Ctrl");
      err.mockRestore();
    });
  });
});
