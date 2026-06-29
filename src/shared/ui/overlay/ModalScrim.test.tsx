import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModalScrim } from "./ModalScrim";

const scrim = (c: HTMLElement) => c.querySelector(".modal-scrim") as HTMLElement;

describe("ModalScrim", () => {
  it("renders its child card", () => {
    render(<ModalScrim onDismiss={() => {}}><div>body</div></ModalScrim>);
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("dismisses on Escape and on a mousedown that lands on the scrim itself", () => {
    const onDismiss = vi.fn();
    const { container } = render(<ModalScrim onDismiss={onDismiss}><button>inner</button></ModalScrim>);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(scrim(container));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("does NOT dismiss when the mousedown lands on the inner card", () => {
    const onDismiss = vi.fn();
    render(<ModalScrim onDismiss={onDismiss}><button>inner</button></ModalScrim>);
    fireEvent.mouseDown(screen.getByText("inner"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("is non-dismissable when onDismiss is undefined (busy modal)", () => {
    const { container } = render(<ModalScrim><div>body</div></ModalScrim>);
    // neither Escape nor an overlay click throws or closes anything
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.mouseDown(scrim(container));
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("applies the align + blur modifier classes", () => {
    const { container } = render(<ModalScrim onDismiss={() => {}} align="start" blur><div>x</div></ModalScrim>);
    const el = scrim(container);
    expect(el.classList.contains("start")).toBe(true);
    expect(el.classList.contains("blur")).toBe(true);
  });
});
