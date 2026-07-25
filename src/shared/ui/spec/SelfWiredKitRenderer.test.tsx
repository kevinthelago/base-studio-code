import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SelfWiredKitRenderer } from "./SelfWiredKitRenderer";
import { validateGeneralNode } from "./generalNode";
import type { GeneralNode } from "./generalNode";

// The <Toggle> knob's marginLeft is "auto" when ON and "2px" when OFF — a cssstyle-safe on/off signal
// (the track's ON colour is a var() cssstyle may drop). The outer track is the first/enclosing span.
const knob = (track: Element) => track.querySelector("span") as HTMLElement;

/** A bound switch: value in via `binds`, behaviour out via `actions` (#3500). */
const boundToggle = (key: string, action = "toggle"): GeneralNode => ({
  type: "Toggle",
  binds: { on: key },
  actions: { onClick: action },
});

describe("SelfWiredKitRenderer (#2868)", () => {
  it("toggles a nested toggle on click with NO host wired — the inert-in-nested-context fix", () => {
    const { container } = render(<SelfWiredKitRenderer node={boundToggle("flag")} />);
    const track = container.querySelector("span") as HTMLElement;
    expect(knob(track).style.marginLeft).toBe("2px");   // off
    fireEvent.click(track);
    expect(knob(track).style.marginLeft).toBe("auto");  // on — the self-wired host flipped it
  });

  it("seeds initial state (a toggle can start on)", () => {
    const { container } = render(
      <SelfWiredKitRenderer node={boundToggle("flag")} initial={{ flag: true }} />,
    );
    expect(knob(container.querySelector("span") as HTMLElement).style.marginLeft).toBe("auto");
  });

  it("composes per bind key — nested toggles behave independently", () => {
    const spec: GeneralNode = {
      type: "Row",
      children: [boundToggle("a", "toggleA"), boundToggle("b", "toggleB")],
    };
    const { container } = render(<SelfWiredKitRenderer node={spec} />);
    const tracks = [...container.querySelectorAll("span")].filter(
      (s) => (s as HTMLElement).style.cursor === "pointer",
    ) as HTMLElement[];
    expect(tracks).toHaveLength(2);
    fireEvent.click(tracks[0]);
    expect(knob(tracks[0]).style.marginLeft).toBe("auto"); // a → on
    expect(knob(tracks[1]).style.marginLeft).toBe("2px");  // b unchanged (independent state)
  });

  it("selects: a nested select persists its choice through the self-wired state", () => {
    const spec: GeneralNode = {
      type: "SelectField",
      props: {
        label: "Provider",
        children: [
          { type: "Option", props: { value: "anthropic" }, children: "anthropic" },
          { type: "Option", props: { value: "openai" }, children: "openai" },
        ],
      },
      binds: { value: "provider" },
      actions: { onChange: "setProvider" },
    };
    expect(validateGeneralNode(spec)).toEqual([]);
    render(<SelfWiredKitRenderer node={spec} initial={{ provider: "anthropic" }} />);
    const combo = screen.getByRole("combobox");
    expect(combo).toHaveValue("anthropic");
    fireEvent.change(combo, { target: { value: "openai" } });
    expect(combo).toHaveValue("openai");
  });

  it("resolves a nested button's action so the click is observed, not dead", () => {
    const onAction = vi.fn();
    render(
      <SelfWiredKitRenderer
        node={{ type: "Card", children: [{ type: "Button", children: "Save", actions: { onClick: "save" } }] }}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onAction).toHaveBeenCalledWith("save");
  });

  // #3500 — the preview decides what an action writes from the MANIFEST's declared prop type, never
  // from the prop's name. A boolean bind flips; anything else takes the handler's first argument.
  // These two cases are the whole rule, so they are asserted directly rather than inferred from the
  // behaviour tests above.
  it("an action bound to a NON-boolean prop sets it from the handler argument, not a flip", () => {
    const spec: GeneralNode = {
      type: "TextField",
      props: { label: "Name" },
      binds: { value: "name" },
      actions: { onChange: "setName" },
    };
    render(<SelfWiredKitRenderer node={spec} initial={{ name: "before" }} />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("before");
    fireEvent.change(input, { target: { value: "after" } });
    expect(input).toHaveValue("after");
  });

  it("an action on a node with NO binds is observed only — nothing to write", () => {
    const onAction = vi.fn();
    render(
      <SelfWiredKitRenderer
        node={{ type: "Button", children: "Go", actions: { onClick: "go" } }}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onAction).toHaveBeenCalledWith("go");
  });
});
