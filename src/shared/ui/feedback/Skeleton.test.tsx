// Skeleton (#2234) — the shared loading placeholder (Box + the shimmer style atom).
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Skeleton, SkeletonText } from "./Skeleton";
import { EmptyState } from "./EmptyState";

describe("Skeleton (#2234)", () => {
  it("renders a shimmer block at the given size", () => {
    const { container } = render(<Skeleton w={80} h={16} radius={4} />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe("80px");
    expect(el.style.height).toBe("16px");
    expect(el.style.borderRadius).toBe("4px");
    expect(el.style.animation).toContain("skeleton-shimmer");
  });

  it("SkeletonText renders one shimmer per line", () => {
    const { container } = render(<SkeletonText lines={3} />);
    // Each line is a Skeleton (animated block).
    const shimmering = [...container.querySelectorAll("*")].filter(
      (n) => (n as HTMLElement).style?.animation?.includes("skeleton-shimmer"),
    );
    expect(shimmering).toHaveLength(3);
  });
});

// EmptyState compact size (#2234) — the in-card empty footprint.
describe("EmptyState size=sm (#2234)", () => {
  it("renders a smaller icon box than the default md", () => {
    const { rerender, container } = render(<EmptyState icon="○" title="Empty" />);
    const md = (container.querySelector(".mono") as HTMLElement).style.width;
    rerender(<EmptyState icon="○" title="Empty" size="sm" />);
    const sm = (container.querySelector(".mono") as HTMLElement).style.width;
    expect(parseInt(sm)).toBeLessThan(parseInt(md));
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });
});
