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

  it("accepts a raw px size with the dense .08em tracking (#2420)", () => {
    render(<SectionLabel size={9.5}>staged files</SectionLabel>);
    const el = screen.getByText("staged files");
    expect(el.style.fontSize).toBe("9.5px");
    // CSSOM serializes the leading-dot value with its zero — assert the canonical form.
    expect(el.style.letterSpacing).toBe("0.08em");
    expect(el.classList.contains("mono")).toBe(true);
  });

  it("renders a space-between label row when `right` is set — style lands on the ROW (#2420)", () => {
    render(
      <SectionLabel size={9.5} right={<button>+ add</button>} style={{ marginBottom: 9 }}>
        Responsibilities
      </SectionLabel>,
    );
    const label = screen.getByText("Responsibilities");
    const row = label.parentElement as HTMLElement;
    // Label keeps the micro-label typography; the wrapper row carries the layout + spacing.
    expect(label.style.textTransform).toBe("uppercase");
    expect(label.style.fontSize).toBe("9.5px");
    expect(row.style.display).toBe("flex");
    expect(row.style.justifyContent).toBe("space-between");
    expect(row.style.marginBottom).toBe("9px");
    // The right slot renders inside the row.
    expect(screen.getByText("+ add").parentElement).toBe(row);
  });
});
