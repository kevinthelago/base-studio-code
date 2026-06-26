import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Chip } from "./Chip";

describe("Chip", () => {
  it("renders children and derives bg/border from the text color", () => {
    const { getByText } = render(<Chip color="var(--info)">hello</Chip>);
    const el = getByText("hello");
    expect(el.tagName).toBe("SPAN");
    expect(el.style.color).toBe("var(--info)");
    expect(el.style.background).toContain("color-mix(in oklch, var(--info), transparent 88%)");
    expect(el.style.border).toContain("color-mix(in oklch, var(--info), transparent 72%)");
  });

  it("applies the density/layout overrides", () => {
    const { getByText } = render(
      <Chip color="var(--danger)" bgAlpha={88} borderAlpha={70} gap={5} padding="1px 7px" alignSelf="flex-start">x</Chip>,
    );
    const el = getByText("x");
    expect(el.style.gap).toBe("5px");
    expect(el.style.padding).toBe("1px 7px");
    expect(el.style.alignSelf).toBe("flex-start");
    expect(el.style.background).toContain("transparent 88%"); // bgAlpha
    expect(el.style.border).toContain("transparent 70%"); // borderAlpha distinct from bg
  });
});
