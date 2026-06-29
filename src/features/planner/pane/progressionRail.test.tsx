import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProgressionRail, type RailNode } from "./ProgressionRail";

const node = (over: Partial<RailNode> & { key: string }): RailNode => ({
  status: "upcoming", icon: "category", ...over,
});

describe("ProgressionRail (#1869)", () => {
  it("renders nothing for an empty rail", () => {
    const { container } = render(<ProgressionRail nodes={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows ✓ for done nodes and the stage icon otherwise", () => {
    const { container } = render(
      <ProgressionRail nodes={[node({ key: "a", status: "complete" }), node({ key: "b", status: "active" })]} />,
    );
    expect(screen.getByText("✓")).toBeInTheDocument();       // the complete node
    expect(container.querySelectorAll("svg")).toHaveLength(1); // only the non-done node draws an icon
  });

  it("treats 'ahead' (banked) as done — also ✓", () => {
    render(<ProgressionRail nodes={[node({ key: "a", status: "ahead" })]} />);
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  describe("compact (card) variant", () => {
    it("is non-interactive (no buttons) and renders no labels", () => {
      const { container } = render(
        <ProgressionRail nodes={[node({ key: "a", label: "Goal" }), node({ key: "b", label: "Scope" })]} />,
      );
      expect(container.querySelector("button")).toBeNull();
      expect(container.querySelector(".prail-label")).toBeNull();
      expect(container.querySelector(".prail.compact")).toBeTruthy();
    });

    it("defaults connectors to solid after a complete node, dim otherwise", () => {
      const { container } = render(
        <ProgressionRail nodes={[node({ key: "a", status: "complete" }), node({ key: "b", status: "locked" }), node({ key: "c", status: "upcoming" })]} />,
      );
      const conns = container.querySelectorAll(".prail-conn");
      expect(conns).toHaveLength(2);                 // one between each pair
      expect(conns[0].classList.contains("solid")).toBe(true);  // after the complete node
      expect(conns[1].classList.contains("dim")).toBe(true);    // after the locked node
    });
  });

  describe("stepper variant", () => {
    const nodes = [
      node({ key: "a", status: "complete", label: "A" }),
      node({ key: "b", status: "active", label: "B" }),
      node({ key: "c", status: "locked", label: "C" }),
    ];

    it("renders labels and calls onSelect on click", () => {
      const onSelect = vi.fn();
      render(<ProgressionRail nodes={nodes} variant="stepper" selectedIdx={1} onSelect={onSelect} />);
      expect(screen.getByText("B")).toBeInTheDocument();
      fireEvent.click(screen.getByTitle("C"));
      expect(onSelect).toHaveBeenCalledWith(2);
    });

    it("marks the selected node and pulses highlighted keys", () => {
      const { container } = render(
        <ProgressionRail nodes={nodes} variant="stepper" selectedIdx={2} onSelect={vi.fn()} highlight={new Set(["c"])} />,
      );
      expect(container.querySelector(".prail-seg.locked.sel")).toBeTruthy();
      expect(container.querySelector(".prail-seg.locked.attn")).toBeTruthy();
      expect(container.querySelector(".prail-seg.complete.attn")).toBeNull();
    });

    it("honors a custom connectorKind", () => {
      const { container } = render(
        <ProgressionRail nodes={nodes} variant="stepper" selectedIdx={0} onSelect={vi.fn()} connectorKind={() => "dashed"} />,
      );
      const conns = container.querySelectorAll(".prail-conn");
      expect(conns).toHaveLength(2);
      expect(Array.from(conns).every((c) => c.classList.contains("dashed"))).toBe(true);
    });
  });
});
