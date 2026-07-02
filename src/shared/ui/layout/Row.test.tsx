import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Row } from "./Row";

describe("Row", () => {
  it("renders a flex row centered by default with the resolved gap", () => {
    render(<Row gap="sm" data-testid="r"><span>a</span></Row>);
    const el = screen.getByTestId("r");
    expect(el.style.display).toBe("flex");
    expect(el.style.flexDirection).toBe(""); // row is the flex default — not forced to column
    expect(el.style.alignItems).toBe("center");
    expect(el.style.gap).toBe("8px");
  });

  it("honors an explicit align, justify, and wrap", () => {
    render(<Row align="baseline" justify="between" wrap gap="md" data-testid="r">x</Row>);
    const el = screen.getByTestId("r");
    expect(el.style.alignItems).toBe("baseline");
    expect(el.style.justifyContent).toBe("space-between");
    expect(el.style.flexWrap).toBe("wrap");
  });

  it("passes through className/style and lets style override the computed values", () => {
    render(<Row align="center" className="c" style={{ alignItems: "flex-end" }} data-testid="r">x</Row>);
    const el = screen.getByTestId("r");
    expect(el.classList.contains("c")).toBe(true);
    expect(el.style.alignItems).toBe("flex-end");
  });
});
