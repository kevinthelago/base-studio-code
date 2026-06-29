import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("defaults to the neutral inline tone (not a bar)", () => {
    const { container } = render(<Banner>note</Banner>);
    expect(container.querySelector(".banner.tone-neutral")).not.toBeNull();
    expect(container.querySelector(".banner.bar")).toBeNull();
  });

  it("renders a tone-colored dot, loud text, and a right slot (the status-box look)", () => {
    const { container } = render(
      <Banner tone="success" dot loud right={<span data-testid="cap">cap</span>}>sources connected</Banner>,
    );
    expect(container.querySelector(".banner.loud.tone-success")).not.toBeNull();
    expect(container.querySelector(".banner-dot")).not.toBeNull();
    expect(screen.getByText("sources connected")).toBeInTheDocument();
    expect(screen.getByTestId("cap")).toBeInTheDocument();
  });

  it("variant=bar renders a full-width app bar with a working dismiss", () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Banner variant="bar" tone="accent" onDismiss={onDismiss}>restore?</Banner>,
    );
    expect(container.querySelector(".banner.bar")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
