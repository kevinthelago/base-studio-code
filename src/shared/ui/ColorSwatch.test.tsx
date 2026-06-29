import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ColorSwatch } from "./ColorSwatch";

describe("ColorSwatch", () => {
  it("renders a sized square with the given colour", () => {
    const { container } = render(<ColorSwatch color="var(--accent)" size={8} radius={3} />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe("8px");
    expect(el.style.height).toBe("8px");
    expect(el.style.borderRadius).toBe("3px");
    expect(el.style.background).toBe("var(--accent)");
  });

  it("defaults to 9px / radius 2 and merges an override style", () => {
    const { container } = render(<ColorSwatch color="#abc" style={{ display: "block" }} />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe("9px");
    expect(el.style.borderRadius).toBe("2px");
    expect(el.style.display).toBe("block");
  });
});
