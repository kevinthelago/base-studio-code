import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ThemeScope } from "./ThemeScope";

describe("ThemeScope", () => {
  it("applies the theme's token overrides to a wrapper and renders children", () => {
    const { getByText, container } = render(<ThemeScope theme="soft">child</ThemeScope>);
    expect(getByText("child")).toBeInTheDocument();
    const wrap = container.querySelector('[data-kit-theme="soft"]') as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.style.getPropertyValue("--card-radius")).toBe("14px");
  });

  it("scopes to a subtree without overrides for the default theme", () => {
    const { container } = render(<ThemeScope theme="default">x</ThemeScope>);
    const wrap = container.querySelector('[data-kit-theme="default"]') as HTMLElement;
    expect(wrap.style.getPropertyValue("--card-radius")).toBe("");
  });
});
