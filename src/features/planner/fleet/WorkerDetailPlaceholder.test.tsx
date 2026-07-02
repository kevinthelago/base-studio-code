import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Placeholder } from "./WorkerDetailPlaceholder";

describe("WorkerDetail Placeholder (#499)", () => {
  it("renders its title, hint, and body copy", () => {
    render(<Placeholder title="Tokens & spend" hint="not measured yet" body="Per-session token accounting isn't wired up yet." />);
    expect(screen.getByText("Tokens & spend")).toBeInTheDocument();
    expect(screen.getByText("not measured yet")).toBeInTheDocument();
    expect(screen.getByText(/Per-session token accounting/)).toBeInTheDocument();
  });
});
