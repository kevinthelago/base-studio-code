import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IconButton, CLOSE_GLYPH } from "./IconButton";

describe("IconButton", () => {
  it("renders the canonical close glyph by default and exposes its aria-label", () => {
    render(<IconButton aria-label="close" />);
    const btn = screen.getByRole("button", { name: "close" });
    expect(btn).toHaveTextContent(CLOSE_GLYPH);
    expect(btn.className).toContain("icon-btn");
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<IconButton aria-label="close" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(<IconButton aria-label="close" disabled onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "close" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies size + danger modifier classes", () => {
    const { rerender } = render(<IconButton aria-label="remove" size="xs" danger />);
    let cls = screen.getByRole("button", { name: "remove" }).className;
    expect(cls).toContain("xs");
    expect(cls).toContain("danger");
    rerender(<IconButton aria-label="remove" size="md" />);
    cls = screen.getByRole("button", { name: "remove" }).className;
    expect(cls).not.toContain("xs");
    expect(cls).not.toContain("danger");
  });

  it("renders custom children over the default glyph", () => {
    render(<IconButton aria-label="cancel">cancel</IconButton>);
    expect(screen.getByRole("button", { name: "cancel" })).toHaveTextContent("cancel");
  });
});
