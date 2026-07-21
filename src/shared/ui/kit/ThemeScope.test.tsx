import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ThemeScope } from "./ThemeScope";

describe("ThemeScope", () => {
  it("applies the theme's token overrides to a wrapper and renders children", () => {
    const { getByText, container } = render(<ThemeScope theme="nord">child</ThemeScope>);
    expect(getByText("child")).toBeInTheDocument();
    const wrap = container.querySelector('[data-kit-theme="nord"]') as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.style.getPropertyValue("--accent")).toBe("#88c0d0");
  });

  it("scopes to a subtree without overrides for the default theme", () => {
    const { container } = render(<ThemeScope theme="default">x</ThemeScope>);
    const wrap = container.querySelector('[data-kit-theme="default"]') as HTMLElement;
    expect(wrap.style.getPropertyValue("--card-radius")).toBe("");
  });
});
