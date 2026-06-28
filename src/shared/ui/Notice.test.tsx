import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Notice } from "./Notice";

describe("Notice", () => {
  it("renders the message tinted by tone, with an optional dot and right slot", () => {
    const { container } = render(
      <Notice tone="success" dot right={<span data-testid="cap">cap</span>}>sources connected</Notice>,
    );
    const box = container.firstChild as HTMLElement;
    expect(box.style.color).toBe("var(--success)");
    expect(box.style.background).toContain("var(--success)");
    expect(screen.getByText("sources connected")).toBeInTheDocument();
    expect(screen.getByTestId("cap")).toBeInTheDocument();
    // leading dot + message (+ spacer + right) ⇒ first child is the dot span
    expect((box.firstChild as HTMLElement).tagName).toBe("SPAN");
  });

  it("defaults to the accent tone and omits the dot", () => {
    const { container } = render(<Notice>heads up</Notice>);
    const box = container.firstChild as HTMLElement;
    expect(box.style.color).toBe("var(--accent)");
    expect(box.textContent).toBe("heads up");
  });
});
