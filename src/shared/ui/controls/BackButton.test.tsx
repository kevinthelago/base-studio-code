import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BackButton } from "./BackButton";

describe("BackButton", () => {
  it("text variant renders the chevron SVG + label (never the '←' char) and is labelled", () => {
    const { container } = render(<BackButton variant="text" label="portfolio" onClick={() => {}} aria-label="Back to portfolio" />);
    const btn = screen.getByRole("button", { name: "Back to portfolio" });
    expect(btn.textContent).toContain("portfolio");
    expect(btn.textContent).not.toContain("←");
    expect(container.querySelector("svg polyline")).not.toBeNull(); // chevron_left
  });

  it("icon variant renders the boxed chevron with no visible text", () => {
    const { container } = render(<BackButton variant="icon" onClick={() => {}} aria-label="Back to Planner" />);
    const btn = screen.getByRole("button", { name: "Back to Planner" });
    expect(btn.textContent).toBe("");
    expect(container.querySelector("svg polyline")).not.toBeNull();
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<BackButton label="fleet" onClick={onClick} aria-label="Back to fleet" />);
    fireEvent.click(screen.getByRole("button", { name: "Back to fleet" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("respects disabled", () => {
    const onClick = vi.fn();
    render(<BackButton label="back" disabled onClick={onClick} aria-label="Back" />);
    const btn = screen.getByRole("button", { name: "Back" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("passes through className (call sites keep their look)", () => {
    render(<BackButton label="back" className="nav-btn" onClick={() => {}} aria-label="Back" />);
    expect(screen.getByRole("button", { name: "Back" })).toHaveClass("nav-btn");
  });
});
