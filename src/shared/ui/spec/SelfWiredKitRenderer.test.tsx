import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SelfWiredKitRenderer } from "./SelfWiredKitRenderer";
import type { KitNode } from "./schema";

// The <Toggle> knob's marginLeft is "auto" when ON and "2px" when OFF — a cssstyle-safe on/off signal
// (the track's ON colour is a var() cssstyle may drop). The outer track is the first/enclosing span.
const knob = (track: Element) => track.querySelector("span") as HTMLElement;

describe("SelfWiredKitRenderer (#2868)", () => {
  it("toggles a nested toggle on click with NO host wired — the inert-in-nested-context fix", () => {
    const { container } = render(<SelfWiredKitRenderer node={{ kind: "toggle", bind: "flag" }} />);
    const track = container.querySelector("span") as HTMLElement;
    expect(knob(track).style.marginLeft).toBe("2px");   // off
    fireEvent.click(track);
    expect(knob(track).style.marginLeft).toBe("auto");  // on — the self-wired host flipped it
  });

  it("seeds initial state (a toggle can start on)", () => {
    const { container } = render(<SelfWiredKitRenderer node={{ kind: "toggle", bind: "flag" }} initial={{ flag: true }} />);
    expect(knob(container.querySelector("span") as HTMLElement).style.marginLeft).toBe("auto");
  });

  it("composes per bind key — nested toggles behave independently", () => {
    const spec: KitNode = { kind: "row", children: [
      { kind: "toggle", bind: "a" },
      { kind: "toggle", bind: "b" },
    ] };
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
    const spec: KitNode = { kind: "field", control: "select", label: "Provider", bind: "provider", options: ["anthropic", "openai"] };
    render(<SelfWiredKitRenderer node={spec} initial={{ provider: "anthropic" }} />);
    const combo = screen.getByRole("combobox");
    expect(combo).toHaveValue("anthropic");
    fireEvent.change(combo, { target: { value: "openai" } });
    expect(combo).toHaveValue("openai");
  });

  it("resolves a nested button's action so the click is observed, not dead", () => {
    const onAction = vi.fn();
    render(<SelfWiredKitRenderer node={{ kind: "card", children: [{ kind: "button", label: "Save", action: "save" }] }} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onAction).toHaveBeenCalledWith("save");
  });
});
