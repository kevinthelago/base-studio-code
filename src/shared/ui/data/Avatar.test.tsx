import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Avatar } from "./Avatar";
import { LabelChip } from "./LabelChip";

describe("Avatar", () => {
  it("renders the login initial and a hover title", () => {
    const { container } = render(<Avatar login="octocat" />);
    const span = container.querySelector("span")!;
    expect(span.textContent).toBe("O");
    expect(span.getAttribute("title")).toBe("@octocat");
  });

  it("falls back to ? for an empty login", () => {
    const { container } = render(<Avatar login="" />);
    expect(container.querySelector("span")!.textContent).toBe("?");
  });

  it("borders + offsets in palette mode (assignee stack)", () => {
    const { container } = render(<Avatar login="alice" palette bordered ml={-5} fontScale={0.56} />);
    const style = container.querySelector("span")!.style;
    expect(style.border).toContain("var(--bg-canvas)");
    expect(style.marginLeft).toBe("-5px");
  });
});

describe("LabelChip", () => {
  it("renders the label name and tints from its hex color", () => {
    const { container } = render(<LabelChip label={{ name: "bug", color: "ff0000" }} />);
    const span = container.querySelector("span")!;
    expect(span.textContent).toBe("bug");
    expect(span.style.color).toBe("rgb(255, 0, 0)");
  });
});
