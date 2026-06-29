import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatTile } from "./StatTile";

describe("StatTile", () => {
  it("renders k/v/sub and applies the value tone", () => {
    const { container } = render(<StatTile k="success rate" v="92%" sub="of all runs" tone="success" />);
    expect(screen.getByText("success rate")).toBeInTheDocument();
    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.getByText("of all runs")).toBeInTheDocument();
    expect(container.querySelector(".stat-tile")).not.toBeNull();
    expect(container.querySelector(".v.success")).not.toBeNull();
  });

  it("omits the sub when absent", () => {
    const { container } = render(<StatTile k="count" v={3} />);
    expect(container.querySelector(".sub")).toBeNull();
  });
});
