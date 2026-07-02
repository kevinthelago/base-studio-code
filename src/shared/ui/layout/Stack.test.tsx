import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Stack } from "./Stack";

describe("Stack", () => {
  it("renders a flex column with the resolved gap and children", () => {
    render(<Stack gap="md" data-testid="s"><span>a</span><span>b</span></Stack>);
    const el = screen.getByTestId("s");
    expect(el.style.display).toBe("flex");
    expect(el.style.flexDirection).toBe("column");
    expect(el.style.gap).toBe("12px");
    expect(el).toHaveTextContent("ab");
  });

  it("leaves alignItems unset by default (native stretch) and applies it when asked", () => {
    const { rerender } = render(<Stack data-testid="s">x</Stack>);
    expect(screen.getByTestId("s").style.alignItems).toBe("");
    rerender(<Stack align="center" data-testid="s">x</Stack>);
    expect(screen.getByTestId("s").style.alignItems).toBe("center");
  });

  it("supports a raw px gap, padding, inline, and passes through arbitrary div props", () => {
    const onClick = vi.fn();
    render(<Stack gap={10} pad={["sm", "md"]} inline className="c" onClick={onClick} data-testid="s">x</Stack>);
    const el = screen.getByTestId("s");
    expect(el.style.gap).toBe("10px");
    expect(el.style.padding).toBe("8px 12px");
    expect(el.style.display).toBe("inline-flex");
    expect(el.classList.contains("c")).toBe(true);
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("lets a style override win last", () => {
    render(<Stack gap="md" style={{ gap: 3 }} data-testid="s">x</Stack>);
    expect(screen.getByTestId("s").style.gap).toBe("3px");
  });
});
