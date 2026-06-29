import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "./Card";

describe("Card", () => {
  it("renders the .card frame + children", () => {
    const { container } = render(<Card>body</Card>);
    expect(container.querySelector(".card")).not.toBeNull();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("renders a canonical head from title + hint", () => {
    render(<Card title="Theme" hint="appearance">body</Card>);
    expect(screen.getByRole("heading", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByText("appearance")).toBeInTheDocument();
  });

  it("prefers a custom header over title", () => {
    render(<Card title="ignored" header={<div>custom head</div>}>body</Card>);
    expect(screen.getByText("custom head")).toBeInTheDocument();
    expect(screen.queryByText("ignored")).toBeNull();
  });

  it("applies className alongside .card and a tooltip", () => {
    const { container } = render(<Card className="stat-tile" tooltip="hi">body</Card>);
    const el = container.querySelector(".card.stat-tile");
    expect(el).not.toBeNull();
    expect(el?.getAttribute("title")).toBe("hi");
  });
});
