import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Stepper, StageHeader, StageFooter, LockBanner, DoneBanner } from "./FocusedShell";
import type { Stage } from "../stages/focusedPlan";

const stage = (over: Partial<Stage> = {}): Stage => ({
  key: "discovery", name: "Discovery", glyph: "◆", blurb: "Discovery", gate: "all topics resolved",
  index: 0, total: 3, status: "active", fraction: 0.5, ...over,
});

// The Stepper now delegates to the shared <ProgressionRail> (#1869) — the focused-pane variant
// ("stepper") of the unified rail standardized on the blueprint-card look (square icon nodes).
describe("Stepper (#652, #1869)", () => {
  const stages = [stage({ key: "a", name: "A", status: "complete", index: 0 }),
    stage({ key: "b", name: "B", status: "active", index: 1 }),
    stage({ key: "c", name: "C", status: "locked", index: 2 })];

  it("renders a node per stage and selects on click", () => {
    const onSelect = vi.fn();
    render(<Stepper stages={stages} selectedIdx={1} onSelect={onSelect} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("C"));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("marks the selected rail node", () => {
    const { container } = render(<Stepper stages={stages} selectedIdx={2} onSelect={vi.fn()} />);
    expect(container.querySelector(".prail-seg.locked.sel")).toBeTruthy();
  });

  // #1074: every seg must carry its stage-title label (the label regressed once before, #1072).
  it("renders a stage-title label under every rail node (#1074)", () => {
    const { container } = render(<Stepper stages={stages} selectedIdx={1} onSelect={vi.fn()} />);
    const labels = Array.from(container.querySelectorAll(".prail-seg .prail-label"));
    expect(labels).toHaveLength(stages.length);
    expect(labels.map((l) => l.textContent)).toEqual(["A", "B", "C"]);
  });

  it("pulses highlighted (incomplete) nodes via the attn class", () => {
    const { container } = render(<Stepper stages={stages} selectedIdx={0} onSelect={vi.fn()} highlight={new Set(["c"])} />);
    expect(container.querySelector(".prail-seg.locked.attn")).toBeTruthy();
    expect(container.querySelector(".prail-seg.complete.attn")).toBeNull(); // only highlighted keys
  });

  it("renders a skipped optional node, its state shown by the node ring + stage icon (#678, #1869)", () => {
    const skipped = [
      stage({ key: "a", name: "A", status: "complete", index: 0 }),
      stage({ key: "ui", name: "UI", status: "skipped", index: 1 }),
      stage({ key: "b", name: "B", status: "active", index: 2 }),
    ];
    const { container } = render(<Stepper stages={skipped} selectedIdx={2} onSelect={vi.fn()} />);
    const seg = container.querySelector(".prail-seg.skipped");
    expect(seg).toBeTruthy();
    // state carried by the .skipped ring color; the node shows the stage icon (not a ✓ — done only),
    // matching the card look we standardized on.
    expect(seg!.querySelector("svg")).toBeTruthy();
  });

  it("renders an ahead (banked) node reached by a dashed connector", () => {
    const aheadStages = [
      stage({ key: "a", name: "A", status: "active", index: 0 }),
      stage({ key: "b", name: "B", status: "upcoming", index: 1 }),
      stage({ key: "c", name: "C", status: "ahead", index: 2 }),
    ];
    const { container } = render(<Stepper stages={aheadStages} selectedIdx={0} onSelect={vi.fn()} />);
    expect(container.querySelector(".prail-seg.ahead")).toBeTruthy();
    expect(container.querySelector(".prail-conn.dashed")).toBeTruthy(); // connector into the banked node
  });
});

describe("StageHeader (#652)", () => {
  it("shows the stage title and the gate pill", () => {
    const { container } = render(<StageHeader stage={stage({ index: 1, total: 3, name: "Repos" })} pill="wait" />);
    expect(screen.getByText("Repos")).toBeInTheDocument();
    expect(screen.getByText("gate")).toBeInTheDocument();
    expect(container.querySelector(".ph-gate.wait")).toBeTruthy();
  });
  it("reflects pass/wait state via the pill class", () => {
    const { container, rerender } = render(<StageHeader stage={stage()} pill="pass" />);
    expect(container.querySelector(".ph-gate.pass")).toBeTruthy();
    rerender(<StageHeader stage={stage()} pill="wait" />);
    expect(container.querySelector(".ph-gate.wait")).toBeTruthy();
  });

  it("surfaces unmet gate reasons on click when blocked (#805)", () => {
    const p = stage({ unmet: [
      { label: "resolve the discovery topics", detail: "3 of 5" },
      { label: "confirm goal, scope, stack & architecture" },
    ] });
    render(<StageHeader stage={p} pill="wait" />);
    // a "why?" affordance shows; the reason list is hidden until clicked
    expect(screen.getByText("why?")).toBeInTheDocument();
    expect(screen.queryByText(/Still needed to pass/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("why?"));
    expect(screen.getByText(/Still needed to pass/)).toBeInTheDocument();
    expect(screen.getByText(/confirm goal, scope/)).toBeInTheDocument();
    expect(screen.getByText(/3 of 5/)).toBeInTheDocument();
  });

  it("offers no 'why?' when the gate passes", () => {
    render(<StageHeader stage={stage({ unmet: [{ label: "x" }] })} pill="pass" />);
    expect(screen.queryByText("why?")).not.toBeInTheDocument();
  });
});

describe("StageFooter (#652)", () => {
  it("labels the primary by action kind and disables when blocked", () => {
    const onPrimary = vi.fn();
    const { rerender } = render(
      <StageFooter stage={stage({ index: 1 })} action={{ kind: "approve-continue", enabled: false }} onBack={vi.fn()} onPrimary={onPrimary} />,
    );
    expect(screen.getByText("gate blocking…")).toBeInTheDocument();
    rerender(<StageFooter stage={stage({ index: 1 })} action={{ kind: "publish", enabled: true }} onBack={vi.fn()} onPrimary={onPrimary} />);
    fireEvent.click(screen.getByText(/Publish to GitHub/));
    expect(onPrimary).toHaveBeenCalled();
  });
  it("relabels publish as 'Update GitHub' once the project is published (#823)", () => {
    const { rerender } = render(
      <StageFooter stage={stage({ index: 1 })} action={{ kind: "publish", enabled: true }} onBack={vi.fn()} onPrimary={vi.fn()} />,
    );
    expect(screen.getByText(/Publish to GitHub/)).toBeInTheDocument();
    rerender(<StageFooter stage={stage({ index: 1 })} action={{ kind: "publish", enabled: true }} published onBack={vi.fn()} onPrimary={vi.fn()} />);
    expect(screen.getByText(/Update GitHub/)).toBeInTheDocument();
    expect(screen.queryByText(/Publish to GitHub/)).not.toBeInTheDocument();
  });
  it("disables back on the first stage", () => {
    render(<StageFooter stage={stage({ index: 0 })} action={{ kind: "approve-continue", enabled: true }} onBack={vi.fn()} onPrimary={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });

  it("renders NO Skip on a required stage — the #2854 ghost fix (no greyed skip beside 'gate blocking…')", () => {
    // A blocked required stage: canSkip is a marker but skipEnabled is false → the Skip control must
    // not render at all (the bug rendered a disabled ghost next to the blocked primary).
    render(
      <StageFooter
        stage={stage({ index: 1, skippable: false })}
        action={{ kind: "approve-continue", enabled: false, canSkip: true, skipEnabled: false }}
        onBack={vi.fn()} onPrimary={vi.fn()} onSkip={vi.fn()}
      />,
    );
    expect(screen.getByText("gate blocking…")).toBeInTheDocument();
    expect(screen.queryByText(/skip stage/)).not.toBeInTheDocument();
  });

  it("renders an actionable Skip when the active stage is skippable (#2854)", () => {
    const onSkip = vi.fn();
    render(
      <StageFooter
        stage={stage({ index: 1, skippable: true })}
        action={{ kind: "approve-continue", enabled: false, canSkip: true, skipEnabled: true }}
        onBack={vi.fn()} onPrimary={vi.fn()} onSkip={onSkip}
      />,
    );
    const skip = screen.getByText(/skip stage/);
    expect(skip).toBeEnabled();
    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalled();
  });
});

describe("banners (#652)", () => {
  it("render lock + done", () => {
    const { rerender } = render(<LockBanner activeName="Repos" />);
    expect(screen.getByText(/Locked\./)).toBeInTheDocument();
    expect(screen.getByText("Repos")).toBeInTheDocument();
    rerender(<DoneBanner />);
    expect(screen.getByText(/Completed\./)).toBeInTheDocument();
  });
});
