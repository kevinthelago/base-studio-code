import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Text } from "./Text";

describe("Text", () => {
  it("renders a bare span with no size/color/weight forced by default", () => {
    render(<Text data-testid="t">hi</Text>);
    const el = screen.getByTestId("t");
    expect(el.tagName).toBe("SPAN");
    expect(el.style.fontSize).toBe("");
    expect(el.style.color).toBe("");
    expect(el.style.fontWeight).toBe("");
    expect(el).toHaveTextContent("hi");
  });

  it("resolves a named size rung and a semantic tone to CSS", () => {
    render(<Text size="sm" tone="dim" data-testid="t">x</Text>);
    const el = screen.getByTestId("t");
    expect(el.style.fontSize).toBe("11px");
    expect(el.style.color).toBe("var(--fg-dim)");
  });

  it("supports a raw px size, a weight, and the mono utility class", () => {
    render(<Text size={10.5} weight={600} mono data-testid="t">x</Text>);
    const el = screen.getByTestId("t");
    expect(el.style.fontSize).toBe("10.5px");
    expect(el.style.fontWeight).toBe("600");
    expect(el.classList.contains("mono")).toBe(true);
  });

  it("renders as the requested element and passes through arbitrary props", () => {
    const onClick = vi.fn();
    render(<Text as="label" htmlFor="f" className="c" onClick={onClick} data-testid="t">x</Text>);
    const el = screen.getByTestId("t");
    expect(el.tagName).toBe("LABEL");
    expect(el.getAttribute("for")).toBe("f");
    expect(el.classList.contains("c")).toBe(true);
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("lets a style override win last", () => {
    render(<Text size="md" tone="accent" style={{ fontSize: 3, color: "red" }} data-testid="t">x</Text>);
    const el = screen.getByTestId("t");
    expect(el.style.fontSize).toBe("3px");
    expect(el.style.color).toBe("red");
  });
});
