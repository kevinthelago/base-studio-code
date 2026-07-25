// Tests for GENERIC rendering of general nodes (#3494, slice 3b of the keystone #3484).
//
// The legacy `kind` path is covered by the existing KitRenderer tests, which are deliberately
// UNMODIFIED by this slice — that they still pass is the parity evidence for the two production
// surfaces (SessionsBehaviorCard, TransformationsBody). These tests cover only the new path.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { KitRenderer } from "./KitRenderer";
import { validateGeneralNode, type GeneralNode } from "./generalNode";
import { UI_KIT } from "../manifest";

describe("generic rendering through the registry (#3494)", () => {
  it("renders a primitive resolved by `type`, not by a per-primitive branch", () => {
    render(<KitRenderer node={{ type: "Text", children: "hello world" } as GeneralNode} />);
    expect(screen.getByText("hello world")).toBeTruthy();
  });

  it("renders nested children recursively", () => {
    const tree: GeneralNode = {
      type: "Stack",
      children: [
        { type: "Text", children: "first" },
        { type: "Text", children: "second" },
      ],
    };
    render(<KitRenderer node={tree} />);
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("renders MANY different primitives with no renderer edit — the point of the slice", () => {
    // If the renderer were still branching per primitive, most of these would come back blank. Picking
    // them from the manifest (rather than a hardcoded list) is what makes this a genericity test.
    const simple = UI_KIT.filter((p) =>
      ["Text", "Chip", "Button", "Code", "SectionLabel"].includes(p.name),
    );
    expect(simple.length).toBeGreaterThan(3);
    for (const p of simple) {
      const { unmount } = render(
        <KitRenderer node={{ type: p.name, children: `body-${p.name}` } as GeneralNode} />,
      );
      expect(screen.getByText(`body-${p.name}`), `${p.name} rendered nothing`).toBeTruthy();
      unmount();
    }
  });
});

describe("bindings on the generic path (#3494)", () => {
  it("resolves a DECLARED function prop as an ACTION NAME against the host callbacks", () => {
    // The 3a contract: a data tree binds handlers by NAME; it can never carry a function. The renderer
    // knows WHICH props are handlers from the manifest's declared `type: "function"` — never by
    // guessing from the prop's name.
    const onClick = vi.fn();
    const { container } = render(
      <KitRenderer
        node={{ type: "Toggle", props: { on: true, onClick: "doTheThing" } } as GeneralNode}
        on={{ doTheThing: onClick }}
      />,
    );
    (container.firstElementChild as HTMLElement).click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("an unknown action name is a no-op, not a crash", () => {
    // Same tolerance the legacy `button` branch has always had — a missing host callback must not
    // take down a surface that is otherwise fine.
    const { container } = render(
      <KitRenderer
        node={{ type: "Toggle", props: { on: true, onClick: "missing" } } as GeneralNode}
        on={{}}
      />,
    );
    expect(() => (container.firstElementChild as HTMLElement).click()).not.toThrow();
  });

  it("binds a handler on a PASSTHROUGH primitive via the actions map (#3496)", () => {
    // This closes the gap #3494 recorded. `Button` is passthrough and does NOT declare `onClick`, so
    // the manifest cannot tell the renderer that prop is a handler — the actions map states it
    // outright instead of the renderer guessing from the prop's name.
    const onClick = vi.fn();
    render(
      <KitRenderer
        node={{ type: "Button", children: "Go", actions: { onClick: "doTheThing" } } as GeneralNode}
        on={{ doTheThing: onClick }}
      />,
    );
    screen.getByText("Go").click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("the actions map WINS over a declared function prop of the same name (#3496)", () => {
    // Documented precedence: the explicit map beats the implicit declared-type path. Asserted rather
    // than left to chance, because "which one wins" is exactly what an author needs to be able to rely
    // on when they reach for the map to disambiguate.
    const viaProp = vi.fn();
    const viaMap = vi.fn();
    const { container } = render(
      <KitRenderer
        node={{ type: "Toggle", props: { on: true, onClick: "fromProp" }, actions: { onClick: "fromMap" } } as GeneralNode}
        on={{ fromProp: viaProp, fromMap: viaMap }}
      />,
    );
    (container.firstElementChild as HTMLElement).click();
    expect(viaMap).toHaveBeenCalledOnce();
    expect(viaProp).not.toHaveBeenCalled();
  });

  it("an unknown action name in the map is a no-op, not a crash", () => {
    const { container } = render(
      <KitRenderer
        node={{ type: "Button", children: "Go", actions: { onClick: "missing" } } as GeneralNode}
        on={{}}
      />,
    );
    expect(() => (container.querySelector("button") as HTMLElement).click()).not.toThrow();
  });
});

describe("failure is visible, never blank (#3494)", () => {
  it("an unresolvable type renders a stated error rather than nothing", () => {
    // A silent blank in a data-driven UI is indistinguishable from "the data said render nothing" —
    // precisely the failure mode this migration must not introduce.
    render(<KitRenderer node={{ type: "NotAPrimitive" } as unknown as GeneralNode} />);
    expect(screen.getByText(/unknown primitive "NotAPrimitive"/)).toBeTruthy();
  });

  it("does not throw on a bad node — one bad node must not white-screen a surface", () => {
    expect(() =>
      render(<KitRenderer node={{ type: "AlsoNotReal" } as unknown as GeneralNode} />),
    ).not.toThrow();
  });
});

// #3500 — the legacy `kind` vocabulary is GONE. A tree carrying one is no longer a second dialect the
// renderer understands; it is simply an invalid node, and must fail the way any invalid node does:
// visibly, without throwing. (The interop suite that used to live here tested a coexistence that no
// longer exists, so keeping it would have asserted the opposite of the contract.)
describe("the retired vocabulary is not silently accepted (#3500)", () => {
  it("a node carrying the legacy `kind` discriminant does not validate", () => {
    const legacy = { kind: "text", text: "legacy" } as unknown as GeneralNode;
    expect(validateGeneralNode(legacy)).toEqual(['$: missing string "type"']);
  });

  it("a legacy node nested in a general tree does not validate either", () => {
    const tree = {
      type: "Stack",
      children: [{ kind: "text", text: "legacy child" }],
    } as unknown as GeneralNode;
    // The `children` slot rejects it as a non-node, and the walk does not descend into it — one clear
    // error at the container, not a confusing cascade from inside a node that was never valid.
    expect(validateGeneralNode(tree)).toEqual(["$.props.children: expected nodes or text"]);
  });

  it("rendering one shows a visible error instead of silently dropping it", () => {
    const legacy = { kind: "text", text: "legacy" } as unknown as GeneralNode;
    render(<KitRenderer node={legacy} />);
    expect(screen.getByText(/unknown primitive/)).toBeTruthy();
  });
});
