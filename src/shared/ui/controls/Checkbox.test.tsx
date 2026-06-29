import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
  it("shows the ✓ only when checked", () => {
    const { rerender } = render(<Checkbox checked={false} />);
    expect(screen.queryByText("✓")).toBeNull();
    rerender(<Checkbox checked />);
    expect(screen.getByText("✓")).toBeTruthy();
  });

  it("is presentational (no role) when no onChange is given", () => {
    const { container } = render(<Checkbox checked aria-label="x" />);
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
  });

  it("is an interactive checkbox when onChange is given — click + Space/Enter toggle it", () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} aria-label="Enable" />);
    const box = screen.getByRole("checkbox", { name: "Enable" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: " " });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("does not act when disabled", () => {
    const onChange = vi.fn();
    render(<Checkbox checked onChange={onChange} disabled aria-label="d" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
