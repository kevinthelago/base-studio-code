import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionLabel } from "./SectionLabel";

describe("SectionLabel", () => {
  it("renders uppercase mono children with the dim tone by default", () => {
    render(<SectionLabel>Scopes requested</SectionLabel>);
    const el = screen.getByText("Scopes requested");
    expect(el.style.textTransform).toBe("uppercase");
    // The mono font-family now comes from the `mono` utility class, not an inline style.
    expect(el.classList.contains("mono")).toBe(true);
    expect(el.style.color).toBe("var(--fg-dim)");
  });

  it("honors size + tone presets and merges a style override", () => {
    render(<SectionLabel size="sm" tone="muted" style={{ marginBottom: 6 }}>What you get</SectionLabel>);
    const el = screen.getByText("What you get");
    expect(el.style.fontSize).toBe("9px");
    expect(el.style.color).toBe("var(--fg-muted)");
    expect(el.style.marginBottom).toBe("6px");
  });
});
