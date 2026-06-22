import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Stepper, PhaseHeader, PhaseFooter, LockBanner, DoneBanner } from "./FocusedShell";
import type { Phase } from "../stages/focusedPlan";

const phase = (over: Partial<Phase> = {}): Phase => ({
  key: "context", name: "Context", glyph: "◆", blurb: "Discovery", gate: "all topics resolved",
  index: 0, total: 3, status: "active", fraction: 0.5, ...over,
});

describe("Stepper (#652)", () => {
  const phases = [phase({ key: "a", name: "A", status: "complete", index: 0 }),
    phase({ key: "b", name: "B", status: "active", index: 1 }),
    phase({ key: "c", name: "C", status: "locked", index: 2 })];

  it("renders a node per phase and selects on click", () => {
    const onSelect = vi.fn();
    render(<Stepper phases={phases} selectedIdx={1} onSelect={onSelect} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("C"));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("marks the selected rail node", () => {
    const { container } = render(<Stepper phases={phases} selectedIdx={2} onSelect={vi.fn()} />);
    expect(container.querySelector(".seqrail-seg.locked.sel")).toBeTruthy();
  });

  it("pulses highlighted (incomplete) nodes via the attn class", () => {
    const { container } = render(<Stepper phases={phases} selectedIdx={0} onSelect={vi.fn()} highlight={new Set(["c"])} />);
    expect(container.querySelector(".seqrail-seg.locked.attn")).toBeTruthy();
    expect(container.querySelector(".seqrail-seg.complete.attn")).toBeNull(); // only highlighted keys
  });

  it("renders a skipped optional node with the ↷ glyph (#678)", () => {
    const skipped = [
      phase({ key: "a", name: "A", status: "complete", index: 0 }),
      phase({ key: "ui", name: "UI", status: "skipped", index: 1 }),
      phase({ key: "b", name: "B", status: "active", index: 2 }),
    ];
    const { container } = render(<Stepper phases={skipped} selectedIdx={2} onSelect={vi.fn()} />);
    expect(container.querySelector(".seqrail-seg.skipped")).toBeTruthy();
    expect(screen.getByText("↷")).toBeInTheDocument(); // state shown by the node glyph, not a marker
  });

  it("renders an ahead (banked) node reached by a dashed connector", () => {
    const aheadPhases = [
      phase({ key: "a", name: "A", status: "active", index: 0 }),
      phase({ key: "b", name: "B", status: "upcoming", index: 1 }),
      phase({ key: "c", name: "C", status: "ahead", index: 2 }),
    ];
    const { container } = render(<Stepper phases={aheadPhases} selectedIdx={0} onSelect={vi.fn()} />);
    expect(container.querySelector(".seqrail-seg.ahead")).toBeTruthy();
    expect(container.querySelector(".seqrail-conn.dashed")).toBeTruthy(); // connector into the banked node
  });
});

describe("PhaseHeader (#652)", () => {
  it("shows the phase title and gate pill state", () => {
    render(<PhaseHeader phase={phase({ index: 1, total: 3, name: "Repos" })} pill="wait" />);
    expect(screen.getByText("Repos")).toBeInTheDocument();
    expect(screen.getByText(/waiting/)).toBeInTheDocument();
  });
  it("renders pass + wait pills", () => {
    const { rerender } = render(<PhaseHeader phase={phase()} pill="pass" />);
    expect(screen.getByText(/passing/)).toBeInTheDocument();
    rerender(<PhaseHeader phase={phase()} pill="wait" />);
    expect(screen.getByText(/waiting/)).toBeInTheDocument();
  });

  it("surfaces unmet gate reasons on click when blocked (#805)", () => {
    const p = phase({ unmet: [
      { label: "resolve the discovery topics", detail: "3 of 5" },
      { label: "confirm goal, scope, stack & architecture" },
    ] });
    render(<PhaseHeader phase={p} pill="wait" />);
    // a "why?" affordance shows; the reason list is hidden until clicked
    expect(screen.getByText("why?")).toBeInTheDocument();
    expect(screen.queryByText(/Still needed to pass/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("why?"));
    expect(screen.getByText(/Still needed to pass/)).toBeInTheDocument();
    expect(screen.getByText(/confirm goal, scope/)).toBeInTheDocument();
    expect(screen.getByText(/3 of 5/)).toBeInTheDocument();
  });

  it("offers no 'why?' when the gate passes", () => {
    render(<PhaseHeader phase={phase({ unmet: [{ label: "x" }] })} pill="pass" />);
    expect(screen.queryByText("why?")).not.toBeInTheDocument();
  });
});

describe("PhaseFooter (#652)", () => {
  it("labels the primary by action kind and disables when blocked", () => {
    const onPrimary = vi.fn();
    const { rerender } = render(
      <PhaseFooter phase={phase({ index: 1 })} action={{ kind: "approve-continue", enabled: false }} onBack={vi.fn()} onPrimary={onPrimary} />,
    );
    expect(screen.getByText("gate blocking…")).toBeInTheDocument();
    rerender(<PhaseFooter phase={phase({ index: 1 })} action={{ kind: "publish", enabled: true }} onBack={vi.fn()} onPrimary={onPrimary} />);
    fireEvent.click(screen.getByText(/Publish to GitHub/));
    expect(onPrimary).toHaveBeenCalled();
  });
  it("relabels publish as 'Update GitHub' once the project is published (#823)", () => {
    const { rerender } = render(
      <PhaseFooter phase={phase({ index: 1 })} action={{ kind: "publish", enabled: true }} onBack={vi.fn()} onPrimary={vi.fn()} />,
    );
    expect(screen.getByText(/Publish to GitHub/)).toBeInTheDocument();
    rerender(<PhaseFooter phase={phase({ index: 1 })} action={{ kind: "publish", enabled: true }} published onBack={vi.fn()} onPrimary={vi.fn()} />);
    expect(screen.getByText(/Update GitHub/)).toBeInTheDocument();
    expect(screen.queryByText(/Publish to GitHub/)).not.toBeInTheDocument();
  });
  it("disables back on the first phase", () => {
    render(<PhaseFooter phase={phase({ index: 0 })} action={{ kind: "approve-continue", enabled: true }} onBack={vi.fn()} onPrimary={vi.fn()} />);
    expect(screen.getByText("← back")).toBeDisabled();
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
