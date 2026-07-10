import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RailGroupHeader } from "./RailGroupHeader";

describe("RailGroupHeader (#2789)", () => {
  it("renders the label and a trailing count", () => {
    render(<RailGroupHeader count={5}>Data structures</RailGroupHeader>);
    expect(screen.getByText("Data structures")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("is not a button when static (no toggle affordance)", () => {
    const { container } = render(<RailGroupHeader>Positions</RailGroupHeader>);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders a caret + aria-expanded and fires onToggle when collapsible", () => {
    const onToggle = vi.fn();
    render(<RailGroupHeader collapsible open onToggle={onToggle} count={3}>Typescript</RailGroupHeader>);
    const btn = document.querySelector("button.rail-grouphead") as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".rail-caret.open")).not.toBeNull();
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders a right-aligned action slot", () => {
    render(<RailGroupHeader action={<button>＋ New group</button>}>Groups</RailGroupHeader>);
    expect(screen.getByText("＋ New group")).toBeTruthy();
  });
});
