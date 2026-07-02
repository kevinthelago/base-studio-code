import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InlineError } from "./InlineError";

describe("InlineError", () => {
  it("renders its message children with the mono danger styling", () => {
    render(<InlineError>Something failed</InlineError>);
    const el = screen.getByText("Something failed");
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass("mono");
    // Danger foreground + the fixed 88%-transparent danger wash + a hairline danger border.
    expect(el.style.color).toContain("--danger");
    expect(el.style.background).toContain("--danger");
    expect(el.style.border).toContain("--danger");
    expect(el.style.fontSize).toBe("11px");
  });

  it("applies the default padding and radius", () => {
    render(<InlineError>msg</InlineError>);
    const el = screen.getByText("msg");
    expect(el.style.padding).toBe("8px 12px");
    expect(el.style.borderRadius).toBe("4px");
  });

  it("honors the pad / radius / borderFade variant props", () => {
    render(<InlineError pad={[12, 16]} radius={6} borderFade={60}>wide</InlineError>);
    const el = screen.getByText("wide");
    expect(el.style.padding).toBe("12px 16px");
    expect(el.style.borderRadius).toBe("6px");
    // The border tint reflects the requested transparency percentage.
    expect(el.style.border).toContain("transparent 60%");
  });

  it("merges a passthrough style (e.g. a per-site margin) and extra className", () => {
    render(<InlineError className="extra" style={{ marginBottom: 14 }}>x</InlineError>);
    const el = screen.getByText("x");
    expect(el).toHaveClass("mono");
    expect(el).toHaveClass("extra");
    expect(el.style.marginBottom).toBe("14px");
  });
});
