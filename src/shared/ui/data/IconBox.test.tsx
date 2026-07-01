import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { IconBox } from "./IconBox";

describe("IconBox (#1882)", () => {
  it("renders its child in a fixed, centered square", () => {
    render(<IconBox size={34} radius={8}><span>A</span></IconBox>);
    const el = screen.getByText("A").parentElement as HTMLElement;
    expect(el.style.width).toBe("34px");
    expect(el.style.height).toBe("34px");
    expect(el.style.flex).toBe("0 0 34px");
    expect(el.style.borderRadius).toBe("8px");
    expect(el.style.display).toBe("flex");
    expect(el.style.alignItems).toBe("center");
    expect(el.style.justifyContent).toBe("center");
  });

  it("defaults to a 30px square with a 7px radius", () => {
    render(<IconBox><span>x</span></IconBox>);
    const el = screen.getByText("x").parentElement as HTMLElement;
    expect(el.style.width).toBe("30px");
    expect(el.style.flex).toBe("0 0 30px");
    expect(el.style.borderRadius).toBe("7px");
  });
});
