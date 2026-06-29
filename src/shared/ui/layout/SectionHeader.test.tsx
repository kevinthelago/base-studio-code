import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionHeader } from "./SectionHeader";

describe("SectionHeader", () => {
  it("renders title + hint + meta", () => {
    const { container } = render(<SectionHeader title="Hooks" hint="lifecycle" meta="3 enabled" />);
    expect(screen.getByRole("heading", { name: "Hooks" })).toBeInTheDocument();
    expect(screen.getByText("lifecycle")).toBeInTheDocument();
    expect(container.querySelector(".sh-meta")?.textContent).toBe("3 enabled");
  });

  it("renders a raw right slot instead of meta", () => {
    const { container } = render(<SectionHeader title="Browse" right={<input placeholder="search" />} />);
    expect(container.querySelector("input")).not.toBeNull();
    expect(container.querySelector(".sh-meta")).toBeNull();
  });
});
