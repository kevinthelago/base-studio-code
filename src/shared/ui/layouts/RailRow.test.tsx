import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RailRow } from "./RailRow";

describe("RailRow (#2789)", () => {
  it("renders the label, leading, and trailing slots", () => {
    render(
      <RailRow leading={<span data-testid="lead">◆</span>} trailing={<span data-testid="trail">7</span>}>
        Merge Sort
      </RailRow>,
    );
    expect(screen.getByText("Merge Sort")).toBeTruthy();
    expect(screen.getByTestId("lead")).toBeTruthy();
    expect(screen.getByTestId("trail")).toBeTruthy();
  });

  it("applies the canonical `.on` class only when active", () => {
    const { rerender } = render(<RailRow>Idle</RailRow>);
    expect(document.querySelector(".rail-row.on")).toBeNull();
    rerender(<RailRow active>Selected</RailRow>);
    expect(document.querySelector(".rail-row.on")).not.toBeNull();
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<RailRow onClick={onClick}>Click me</RailRow>);
    fireEvent.click(screen.getByText("Click me"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a disclosure caret whose open state toggles the `.open` modifier", () => {
    const { rerender } = render(<RailRow caret={false}>Collapsed</RailRow>);
    const caret = document.querySelector(".rail-caret");
    expect(caret).not.toBeNull();
    expect(caret?.classList.contains("open")).toBe(false);
    rerender(<RailRow caret={true}>Expanded</RailRow>);
    expect(document.querySelector(".rail-caret")?.classList.contains("open")).toBe(true);
  });

  it("omits the caret entirely when `caret` is undefined", () => {
    render(<RailRow>No caret</RailRow>);
    expect(document.querySelector(".rail-caret")).toBeNull();
  });

  it("indents by depth and forwards data-* attributes", () => {
    render(<RailRow indent={2} data-group-id="rel">Nested</RailRow>);
    const row = document.querySelector('[data-group-id="rel"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.style.paddingLeft).toBe("36px"); // 8 + 2*14
  });
});
