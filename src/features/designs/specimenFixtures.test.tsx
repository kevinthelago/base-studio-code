import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SPECIMEN_FIXTURES, previewFixture } from "./specimenFixtures";

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

  it("renders the REAL controls/data/chart components ported in #2820", () => {
    // A real SegmentedControl (its .seg-btn buttons), not a bespoke <button> mock.
    const { container: seg } = render(<>{SPECIMEN_FIXTURES.SegmentedControl!("default")}</>);
    expect(seg.querySelector(".seg-btn")).not.toBeNull();
    // A real RoleTierChips row — one tier pill per capability (git · github · code · net).
    render(<>{SPECIMEN_FIXTURES.RoleTierChips!("default")}</>);
    expect(screen.getByText(/^git /)).toBeInTheDocument();
    expect(screen.getByText(/^code /)).toBeInTheDocument();
    // A real StatCard (.statcard).
    const { container: stat } = render(<>{SPECIMEN_FIXTURES.StatCard!("default")}</>);
    expect(stat.querySelector(".statcard")).not.toBeNull();
  });
});

// #2820: previewFixture is the single lookup both preview surfaces call — it spans the react-ui kit AND
// other kits (the d3 ForceGraph), so a component built on an external library renders live in the Studio.
describe("previewFixture (#2820)", () => {
  it("renders the REAL d3 ForceGraph (an <svg> of circles) for the react-d3 kit", () => {
    const { container } = render(<>{previewFixture("ForceGraph", "default")}</>);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // A real force layout: a circle per demo node (7) and a line per demo link (8).
    expect(container.querySelectorAll("circle").length).toBe(7);
    expect(container.querySelectorAll("line").length).toBe(8);
  });

  it("routes react-ui names to their real fixture", () => {
    const { container } = render(<>{previewFixture("Button", "primary")}</>);
    expect(container.querySelector(".btn.primary")).not.toBeNull();
  });

  it("returns null for an unknown component (→ specimens mock / placeholder)", () => {
    expect(previewFixture("NotARealComponent", "default")).toBeNull();
  });
});
