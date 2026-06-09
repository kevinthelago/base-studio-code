import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Stepper, PhaseHeader, PhaseFooter, LockBanner, DoneBanner } from "../screens/projects/FocusedShell";
import type { Phase } from "../screens/projects/focusedPlan";

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

  it("marks the selected step", () => {
    const { container } = render(<Stepper phases={phases} selectedIdx={2} onSelect={vi.fn()} />);
    expect(container.querySelector(".step.locked.selected")).toBeTruthy();
  });
});

describe("PhaseHeader (#652)", () => {
  it("shows the phase number, title, and gate pill state", () => {
    render(<PhaseHeader phase={phase({ index: 1, total: 3, name: "Repos" })} pill="wait" />);
    expect(screen.getByText("PHASE 02 / 03")).toBeInTheDocument();
    expect(screen.getByText("Repos")).toBeInTheDocument();
    expect(screen.getByText(/waiting/)).toBeInTheDocument();
  });
  it("renders pass + blocked pills", () => {
    const { rerender, container } = render(<PhaseHeader phase={phase()} pill="pass" />);
    expect(screen.getByText(/passing/)).toBeInTheDocument();
    rerender(<PhaseHeader phase={phase()} pill="blocked" />);
    expect(container.querySelector(".ph-gate.fail")).toBeTruthy();
    expect(screen.getByText(/blocked/)).toBeInTheDocument();
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
