// The graph-health worklist (#3886). The findings already fired and already counted; what was missing was
// any way to reach the nodes they name. These pin the reaching.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HealthFindingsPanel } from "./HealthFindingsPanel";
import { groupFindings } from "./lib/healthGroups";
import type { HealthFinding } from "./lib/graphHealth";

const finding = (over: Partial<HealthFinding> & Pick<HealthFinding, "category">): HealthFinding => ({
  severity: 1, nodeIds: ["n1"], nodeNames: ["Node One"], why: "because", ...over,
});

describe("groupFindings", () => {
  it("groups by category, most-severe first", () => {
    const groups = groupFindings([
      finding({ category: "no-tests", nodeIds: ["a"], nodeNames: ["A"] }),
      finding({ category: "cycle", severity: 4, nodeIds: ["b"], nodeNames: ["B"] }),
      finding({ category: "no-tests", nodeIds: ["c"], nodeNames: ["C"] }),
    ]);
    // `cycle` outranks `no-tests` on HEALTH_SEVERITY, so it leads regardless of input order.
    expect(groups.map((g) => g.category)).toEqual(["cycle", "no-tests"]);
    expect(groups[1].findings).toHaveLength(2);
  });

  it("is empty for no findings", () => {
    expect(groupFindings([])).toEqual([]);
  });
});

describe("HealthFindingsPanel", () => {
  it("renders NOTHING when the graph is healthy — no badge on a clean kit", () => {
    const { container } = render(<HealthFindingsPanel findings={[]} onSelectNode={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the count condensed, and opens the list only when asked", () => {
    // The condensed-by-default shape is deliberate (the findings were condensed to icon+count on
    // request) — the panel must not be visible until the badge is clicked.
    render(<HealthFindingsPanel findings={[finding({ category: "no-tests" })]} onSelectNode={vi.fn()} />);
    expect(screen.getByRole("button", { name: /⚠ 1/ })).toBeTruthy();
    expect(screen.queryByTestId("ds-health-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /⚠ 1/ }));
    expect(screen.getByTestId("ds-health-panel")).toBeTruthy();
  });

  it("opens as a COLLAPSED index — category + count only, node names behind a click", () => {
    // The whole point of the grouping: `dangling-branch` names dozens of nodes per finding, and rendering
    // them expanded pushed every other category off the first screen. The index must stay scannable.
    render(
      <HealthFindingsPanel
        findings={[
          finding({ category: "no-tests", nodeIds: ["a"], nodeNames: ["Alpha"] }),
          finding({ category: "no-tests", nodeIds: ["b"], nodeNames: ["Beta"] }),
        ]}
        onSelectNode={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /⚠ 2/ }));
    expect(screen.getByText("no-tests")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();          // collapsed
    fireEvent.click(screen.getByText("no-tests"));
    expect(screen.getByText("Alpha")).toBeTruthy();          // …expanded on demand
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("truncates a finding that names many nodes instead of printing a paragraph", () => {
    render(
      <HealthFindingsPanel
        findings={[finding({ category: "dangling-branch", severity: 2, nodeIds: ["a", "b", "c"], nodeNames: ["Alpha", "Beta", "Gamma"] })]}
        onSelectNode={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /⚠ 1/ }));
    fireEvent.click(screen.getByText("dangling-branch"));
    expect(screen.getByText("Alpha +2 more")).toBeTruthy();
  });

  it("selects the finding's node and closes — the doctor → node hand-off", () => {
    const onSelectNode = vi.fn();
    render(<HealthFindingsPanel findings={[finding({ category: "no-tests", nodeIds: ["chip"], nodeNames: ["Chip"] })]} onSelectNode={onSelectNode} />);
    fireEvent.click(screen.getByRole("button", { name: /⚠ 1/ }));
    fireEvent.click(screen.getByText("no-tests"));
    fireEvent.click(screen.getByText("Chip"));
    expect(onSelectNode).toHaveBeenCalledWith("chip");
    expect(screen.queryByTestId("ds-health-panel")).toBeNull(); // …and gets out of the way
  });

  it("the badge TOGGLES — clicking it again closes the panel", () => {
    // Regression guard for the ignore-ref: without `badgeRef` passed to useClickOutside, the dismissing
    // outside-click lands on the badge and its onClick re-opens the panel, so it can never be closed by
    // the control that opened it.
    render(<HealthFindingsPanel findings={[finding({ category: "no-tests" })]} onSelectNode={vi.fn()} />);
    const badge = screen.getByRole("button", { name: /⚠ 1/ });
    fireEvent.click(badge);
    expect(screen.getByTestId("ds-health-panel")).toBeTruthy();
    fireEvent.click(badge);
    expect(screen.queryByTestId("ds-health-panel")).toBeNull();
  });
});
