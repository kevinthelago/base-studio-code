import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SPECIMEN_FIXTURES } from "./specimenFixtures";

// #2555: the Design Studio preview must render the REAL shared/ui components (via these fixtures),
// not the hand-drawn specimens.tsx mocks — so the Studio is true WYSIWYG. These assert the fixtures
// emit the actual components (their real class-names / roles), and defer unknown variants to the mock.
describe("SPECIMEN_FIXTURES (#2555)", () => {
  it("renders the REAL Button (a .btn) per variant, not a mock", () => {
    const { rerender } = render(<>{SPECIMEN_FIXTURES.Button!("primary")}</>);
    const btn = screen.getByRole("button", { name: "Launch stage" });
    expect(btn.className).toContain("btn");        // the real Button's class, not a bespoke <button>
    expect(btn.className).toContain("primary");
    rerender(<>{SPECIMEN_FIXTURES.Button!("danger")}</>);
    expect(screen.getByRole("button", { name: "Delete" }).className).toContain("danger");
  });

  it("renders the REAL Card (a .card) with its title", () => {
    const { container } = render(<>{SPECIMEN_FIXTURES.Card!("default")}</>);
    expect(container.querySelector(".card")).not.toBeNull();
    expect(screen.getByText("Auth service")).toBeInTheDocument();
  });

  it("renders the REAL Banner toned by variant", () => {
    const { container } = render(<>{SPECIMEN_FIXTURES.Banner!("danger")}</>);
    const banner = container.querySelector(".banner");
    expect(banner).not.toBeNull();
    expect(banner!.className).toContain("tone-danger");
  });

  it("defers a variant it doesn't cover by returning null (→ specimens fallback)", () => {
    // Button has no real 'loading' render; the fixture returns null so the caller uses the mock.
    expect(SPECIMEN_FIXTURES.Button!("loading")).toBeNull();
    expect(SPECIMEN_FIXTURES.Chip!("loading")).toBeNull();
  });
});
