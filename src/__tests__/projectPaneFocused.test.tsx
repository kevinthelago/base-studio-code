import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectPane } from "../screens/projects/ProjectPane";
import type { Phase } from "../screens/projects/focusedPlan";

const ph = (key: string, name: string, status: Phase["status"], index: number, total: number): Phase =>
  ({ key, name, glyph: "•", blurb: `${name} blurb`, gate: "gate", index, total, status, fraction: 0 });

const baseFocus = (over: Partial<Parameters<typeof ProjectPane>[0]["focus"] & object> = {}) => ({
  phases: [ph("context", "Context", "active", 0, 3), ph("structure", "Structure", "upcoming", 1, 3), ph("permissions", "Permissions", "locked", 2, 3)],
  selectedIdx: 0,
  activeIdx: 0,
  onSelect: vi.fn(),
  pill: "wait" as const,
  footer: { kind: "approve-continue" as const, enabled: false },
  onBack: vi.fn(),
  onPrimary: vi.fn(),
  ...over,
});

describe("ProjectPane focused mode (#652)", () => {
  it("renders the stepper + the selected phase, and selects on step click", () => {
    const onSelect = vi.fn();
    render(<ProjectPane focus={baseFocus({ onSelect })} />);
    expect(screen.getByText("PHASE 01 / 03")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Context" })).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Permissions"));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("shows a lock banner when browsing a future phase", () => {
    render(<ProjectPane focus={baseFocus({ selectedIdx: 2, activeIdx: 0 })} />);
    expect(screen.getByText(/Locked\./)).toBeInTheDocument();
    expect(screen.getByText("PHASE 03 / 03")).toBeInTheDocument();
  });

  it("renders a generic body for a section without a dedicated panel", () => {
    render(<ProjectPane focus={baseFocus({
      phases: [ph("automations", "Automations", "active", 0, 1)],
      selectedIdx: 0, activeIdx: 0,
    })} />);
    expect(screen.getByText(/planner documents this stage/)).toBeInTheDocument();
  });
});
