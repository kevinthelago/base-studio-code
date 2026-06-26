import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useModalDismiss, overlayDismiss } from "./useModalDismiss";

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

describe("useModalDismiss", () => {
  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    renderHook(() => useModalDismiss(onClose));
    pressEscape();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores other keys", () => {
    const onClose = vi.fn();
    renderHook(() => useModalDismiss(onClose));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not listen while disabled", () => {
    const onClose = vi.fn();
    renderHook(() => useModalDismiss(onClose, { enabled: false }));
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = renderHook(() => useModalDismiss(onClose));
    unmount();
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("overlayDismiss", () => {
  it("fires only when the overlay itself is the target", () => {
    const onClose = vi.fn();
    const node = {} as EventTarget;
    overlayDismiss(onClose)({ target: node, currentTarget: node } as never);
    expect(onClose).toHaveBeenCalledOnce();
    overlayDismiss(onClose)({ target: {}, currentTarget: node } as never); // clicked inner child
    expect(onClose).toHaveBeenCalledOnce(); // unchanged
  });

  it("is a no-op when onClose is undefined (busy/locked)", () => {
    const node = {} as EventTarget;
    expect(() => overlayDismiss(undefined)({ target: node, currentTarget: node } as never)).not.toThrow();
  });
});
