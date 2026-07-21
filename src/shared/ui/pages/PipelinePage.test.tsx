// PipelinePage (#2505) — the linked-list-shaped page composition: the Sequence strip under the
// header bar, the focused-step detail (status Chip + description + facts), and both orientations.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PipelinePage, type PipelineStep } from "./PipelinePage";

const STEPS: PipelineStep[] = [
  { id: "build", label: "Build", status: "complete", facts: [{ k: "took", v: "41s" }] },
  { id: "test", label: "Test", status: "active", description: "Running the suite." },
  { id: "ship", label: "Ship" },
];

describe("PipelinePage — rendering", () => {
  it("renders the header bar and the ordered step strip", () => {
    const { container } = render(<PipelinePage title="Deploy" hint="release" steps={STEPS} />);
    expect(screen.getByText("Deploy")).toBeInTheDocument();
    expect(screen.getByText("release")).toBeInTheDocument();
    const labels = [...container.querySelectorAll(".seq-step .seq-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Build", "Test", "Ship"]);
  });

  it("auto-focuses the active step and renders its default detail: heading + status Chip + description", () => {
    render(<PipelinePage title="Deploy" steps={STEPS} />);
    expect(screen.getByRole("button", { name: /Test/ })).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("active")).toBeInTheDocument();          // the status Chip
    expect(screen.getByText("Running the suite.")).toBeInTheDocument();
  });

  it("vertical orientation renders the timeline rail", () => {
    const { container } = render(<PipelinePage title="Deploy" steps={STEPS} orientation="vertical" />);
    expect(container.querySelector(".seq-strip.seq-v")).toBeTruthy();
  });
});

describe("PipelinePage — selection drives the detail", () => {
  it("uncontrolled: clicking a step focuses it and renders its facts KeyValueList", () => {
    const onSelect = vi.fn();
    render(<PipelinePage title="Deploy" steps={STEPS} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Build/ }));
    expect(onSelect).toHaveBeenCalledWith("build");
    expect(screen.getByText("took")).toBeInTheDocument();
    expect(screen.getByText("41s")).toBeInTheDocument();
    expect(screen.getByText("complete")).toBeInTheDocument(); // the status Chip follows the focus
  });

  it("controlled: selectedId drives the focus; detail render-prop overrides the default", () => {
    render(<PipelinePage title="Deploy" steps={STEPS} selectedId="ship"
      detail={(s) => <span>STEP:{s.id}</span>} />);
    expect(screen.getByText("STEP:ship")).toBeInTheDocument();
  });
});
