import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Spacer } from "./Spacer";

describe("Spacer", () => {
  it("is a greedy flex:1 filler by default", () => {
    const { container } = render(<Spacer />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.flex).toBe("1");
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("becomes a rigid box sized along the main axis when given a size", () => {
    const { container } = render(<Spacer size="md" />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.flex).toBe("0 0 12px");
  });

  it("accepts a raw px size and a style override", () => {
    const { container } = render(<Spacer size={20} style={{ opacity: 0 }} />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.flex).toBe("0 0 20px");
    expect(el.style.opacity).toBe("0");
  });
});
