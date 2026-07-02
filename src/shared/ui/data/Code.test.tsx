import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Code } from "./Code";

function pre(node: HTMLElement): HTMLPreElement {
  return node.querySelector("pre") as HTMLPreElement;
}

describe("Code", () => {
  it("renders a framed mono pre with the baked defaults", () => {
    const { container } = render(<Code>hello world</Code>);
    const el = pre(container);
    expect(el.tagName).toBe("PRE");
    expect(el).toHaveTextContent("hello world");
    expect(el.style.fontFamily).toBe("var(--mono)");
    expect(el.style.fontSize).toBe("10px");
    expect(el.style.maxHeight).toBe("150px");
    expect(el.style.whiteSpace).toBe("pre-wrap");
    expect(el.style.color).toBe("var(--fg-muted)");
    expect(el.style.background).toBe("var(--bg-canvas)");
  });

  it("applies a custom maxHeight", () => {
    const { container } = render(<Code maxHeight={320}>x</Code>);
    expect(pre(container).style.maxHeight).toBe("320px");
  });

  it("switches to a horizontal scroll when wrap is false", () => {
    const { container } = render(<Code wrap={false}>x</Code>);
    expect(pre(container).style.whiteSpace).toBe("pre");
  });

  it("resolves the tone to a foreground color token", () => {
    const { container } = render(<Code tone="danger">x</Code>);
    expect(pre(container).style.color).toBe("var(--danger)");
  });

  it("passes through className and lets a style override win last", () => {
    const { container } = render(
      <Code className="c" style={{ fontSize: 13, marginTop: 6 }}>x</Code>,
    );
    const el = pre(container);
    expect(el.classList.contains("c")).toBe(true);
    expect(el.style.fontSize).toBe("13px");
    expect(el.style.marginTop).toBe("6px");
  });
});
