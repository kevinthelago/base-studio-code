// Tests for GENERIC rendering of general nodes (#3494, slice 3b of the keystone #3484).
//
// The legacy `kind` path is covered by the existing KitRenderer tests, which are deliberately
// UNMODIFIED by this slice — that they still pass is the parity evidence for the two production
// surfaces (SessionsBehaviorCard, TransformationsBody). These tests cover only the new path.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { KitRenderer } from "./KitRenderer";
import type { GeneralNode } from "./generalNode";
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

  it("KNOWN GAP: a handler on a PASSTHROUGH primitive is not resolvable (#3494)", () => {
    // `Button` is passthrough and does NOT declare `onClick` — it forwards DOM props verbatim. So the
    // manifest gives the renderer no way to know that prop is a handler, and the action name reaches
    // the DOM as a string. 14 function props ARE declared (Toggle/IconButton/Dialog/…) and those work;
    // this affects only undeclared handlers on the 9 passthrough primitives.
    //
    // Recorded as a test rather than a comment so it cannot be forgotten, and so whoever closes the
    // gap (by declaring the handler in the manifest, or by adding an explicit node-level action map)
    // is told by a failing test that they have done it.
    const onClick = vi.fn();
    render(
      <KitRenderer
        node={{ type: "Button", children: "Go", props: { onClick: "doTheThing" } } as GeneralNode}
        on={{ doTheThing: onClick }}
      />,
    );
    screen.getByText("Go").click();
    expect(onClick, "if this now FIRES, the gap is closed — delete this test").not.toHaveBeenCalled();
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

describe("the two vocabularies interoperate while they coexist (#3494)", () => {
  it("a legacy `kind` child inside a general node still renders via the legacy path", () => {
    // 3c deletes the kinds; until then a mixed tree must work, or migrating the two production
    // surfaces would have to be atomic with the renderer change.
    const tree = {
      type: "Stack",
      children: [{ kind: "text", text: "legacy child" }],
    } as unknown as GeneralNode;
    render(<KitRenderer node={tree} />);
    expect(screen.getByText("legacy child")).toBeTruthy();
  });

  it("a legacy root still renders exactly as before", () => {
    render(<KitRenderer node={{ kind: "text", text: "legacy root" } as never} />);
    expect(screen.getByText("legacy root")).toBeTruthy();
  });
});
