// The keyboard-activation bundle (#3775) and its modifier guard (#4134).
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { clickable, onEnterOrSpace } from "./a11y";

describe("onEnterOrSpace", () => {
  it("activates on an unmodified Enter or Space, and preventDefaults", () => {
    for (const key of ["Enter", " "]) {
      const activate = vi.fn();
      const preventDefault = vi.fn();
      onEnterOrSpace(activate)({ key, preventDefault, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false } as never);
      expect(activate, key).toHaveBeenCalledTimes(1);
      expect(preventDefault, key).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores a MODIFIED Enter/Space — and does not preventDefault it (#4134)", () => {
    // The bug: Shift+Enter typed at a focused rail row / card / toggle activated it AND swallowed the
    // chord. A real <button> does not click on Shift+Enter either.
    for (const mod of ["shiftKey", "ctrlKey", "altKey", "metaKey"] as const) {
      for (const key of ["Enter", " "]) {
        const activate = vi.fn();
        const preventDefault = vi.fn();
        onEnterOrSpace(activate)({ key, preventDefault, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, [mod]: true } as never);
        expect(activate, `${mod}+${key}`).not.toHaveBeenCalled();
        expect(preventDefault, `${mod}+${key}`).not.toHaveBeenCalled();
      }
    }
  });

  it("claims no other key", () => {
    const activate = vi.fn();
    onEnterOrSpace(activate)({ key: "a", preventDefault: vi.fn(), shiftKey: false, ctrlKey: false, altKey: false, metaKey: false } as never);
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("clickable", () => {
  it("is fully inert without an onClick — no role, no tabindex, no handler", () => {
    expect(clickable(undefined)).toEqual({});
  });

  it("wires role + focusability + click + key activation together", () => {
    const onClick = vi.fn();
    render(<div {...clickable(onClick, { label: "Open" })}>row</div>);
    const el = screen.getByRole("button", { name: "Open" });
    expect(el.getAttribute("tabindex")).toBe("0");
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("does not activate on Shift+Enter through the real DOM path (#4134)", () => {
    const onClick = vi.fn();
    render(<div {...clickable(onClick, { label: "Open" })}>row</div>);
    fireEvent.keyDown(screen.getByRole("button", { name: "Open" }), { key: "Enter", shiftKey: true });
    expect(onClick).not.toHaveBeenCalled();
  });
});
