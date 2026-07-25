import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PaletteToggle } from "./PaletteToggle";

describe("PaletteToggle (#3706)", () => {
  it("shows the theme label and reads un-pressed when the palette is collapsed", () => {
    render(<PaletteToggle label="Nord" open={false} onToggle={() => {}} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("Nord");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("reads pressed when the palette is open", () => {
    render(<PaletteToggle label="Dracula" open onToggle={() => {}} />);
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });

  it("fires onToggle on click", () => {
    const onToggle = vi.fn();
    render(<PaletteToggle label="Nord" open={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
