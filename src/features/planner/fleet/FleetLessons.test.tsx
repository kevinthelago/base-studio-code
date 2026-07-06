// FleetLessons (#2242) — the fleet lessons card (renders the review queue for the active project).
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FleetLessons } from "./FleetLessons";

describe("FleetLessons (#2242)", () => {
  it("renders the card head (loading/empty are driven by the async lesson poll)", () => {
    render(<FleetLessons />);
    expect(screen.getByText("Lessons learned")).toBeInTheDocument();
  });
});
