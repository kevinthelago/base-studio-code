import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Grid } from "./Grid";

describe("Grid", () => {
  it("renders a grid with a numeric cols expanded to repeat(n, 1fr) and the resolved gap", () => {
    render(<Grid cols={2} gap="sm" data-testid="g"><span>a</span><span>b</span></Grid>);
    const el = screen.getByTestId("g");
    expect(el.style.display).toBe("grid");
    expect(el.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
    expect(el.style.gap).toBe("8px");
    expect(el).toHaveTextContent("ab");
  });

  it("passes an explicit cols/rows template string straight through", () => {
    render(<Grid cols="1fr auto" rows="50px 1fr" data-testid="g">x</Grid>);
    const el = screen.getByTestId("g");
    expect(el.style.gridTemplateColumns).toBe("1fr auto");
    expect(el.style.gridTemplateRows).toBe("50px 1fr");
  });

  it("expands a numeric rows to repeat(n, 1fr) and supports a raw px gap", () => {
    render(<Grid rows={3} gap={10} data-testid="g">x</Grid>);
    const el = screen.getByTestId("g");
    expect(el.style.gridTemplateRows).toBe("repeat(3, 1fr)");
    expect(el.style.gap).toBe("10px");
  });

  it("maps align → alignItems and justify → justifyContent via the shared vocabulary", () => {
    render(<Grid align="center" justify="between" data-testid="g">x</Grid>);
    const el = screen.getByTestId("g");
    expect(el.style.alignItems).toBe("center");
    expect(el.style.justifyContent).toBe("space-between");
  });

  it("leaves cols/rows/gap/align/justify unset when not provided", () => {
    render(<Grid data-testid="g">x</Grid>);
    const el = screen.getByTestId("g");
    expect(el.style.gridTemplateColumns).toBe("");
    expect(el.style.gridTemplateRows).toBe("");
    expect(el.style.gap).toBe("");
    expect(el.style.alignItems).toBe("");
    expect(el.style.justifyContent).toBe("");
  });

  it("renders inline-grid and passes through arbitrary div props", () => {
    const onClick = vi.fn();
    render(<Grid inline className="c" onClick={onClick} data-testid="g">x</Grid>);
    const el = screen.getByTestId("g");
    expect(el.style.display).toBe("inline-grid");
    expect(el.classList.contains("c")).toBe(true);
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("lets a style override win last", () => {
    render(<Grid cols={2} gap="md" style={{ gap: 3 }} data-testid="g">x</Grid>);
    expect(screen.getByTestId("g").style.gap).toBe("3px");
  });
});
