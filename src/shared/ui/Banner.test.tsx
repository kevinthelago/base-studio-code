import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Banner } from "./Banner";

describe("Banner", () => {
  it("renders the tone class, lead, and content", () => {
    const { container } = render(
      <Banner tone="success" lead={<span data-testid="dot" />}>all good</Banner>,
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
    expect(screen.getByTestId("dot")).toBeInTheDocument();
    expect(container.querySelector(".banner.tone-success")).not.toBeNull();
  });

  it("defaults to the neutral tone", () => {
    const { container } = render(<Banner>note</Banner>);
    expect(container.querySelector(".banner.tone-neutral")).not.toBeNull();
  });
});
