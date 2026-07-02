import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Box } from "./Box";

describe("Box", () => {
  it("renders a plain div by default and passes children + className through", () => {
    render(<Box className="c" data-testid="b">hi</Box>);
    const el = screen.getByTestId("b");
    expect(el.tagName).toBe("DIV");
    expect(el.classList.contains("c")).toBe(true);
    expect(el).toHaveTextContent("hi");
  });

  it("renders a custom element via `as`", () => {
    render(<Box as="section" data-testid="b">x</Box>);
    expect(screen.getByTestId("b").tagName).toBe("SECTION");
  });

  it("maps the token shorthands", () => {
    render(<Box pad="md" bg="var(--bg-elev)" border radius="lg" shadow="xl" data-testid="b">x</Box>);
    const el = screen.getByTestId("b");
    expect(el.style.padding).toBe("12px");
    expect(el.style.background).toBe("var(--bg-elev)");
    expect(el.style.border).toBe("var(--stroke)");
    expect(el.style.borderRadius).toBe("var(--r-lg)");
    expect(el.style.boxShadow).toBe("var(--shadow-xl)");
  });

  it("supports the border variants and a [block, inline] pad", () => {
    const { rerender } = render(<Box border="soft" pad={["sm", "lg"]} data-testid="b">x</Box>);
    let el = screen.getByTestId("b");
    expect(el.style.border).toBe("var(--stroke-soft)");
    expect(el.style.padding).toBe("8px 16px");
    rerender(<Box border="var(--accent)" radius={4} data-testid="b">x</Box>);
    el = screen.getByTestId("b");
    expect(el.style.border).toBe("1px solid var(--accent)");
    expect(el.style.borderRadius).toBe("4px");
  });

  it("omits unset shorthands, lets style win last, and passes handlers through", () => {
    const onClick = vi.fn();
    render(<Box radius="md" style={{ borderRadius: "2px" }} onClick={onClick} data-testid="b">x</Box>);
    const el = screen.getByTestId("b");
    expect(el.style.borderRadius).toBe("2px"); // style override wins
    expect(el.style.padding).toBe(""); // unset shorthand omitted
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
