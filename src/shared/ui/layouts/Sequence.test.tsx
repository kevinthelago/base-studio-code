// Sequence (#2477, epic #2197) — the ordered-steps page skeleton for linked-list-shaped data:
// a status-colored step strip (horizontal stepper / vertical timeline) with prev→next connectors,
// click-to-focus, and an active-step detail panel. Covers ordering, status rendering, controlled +
// uncontrolled selection, both orientations, and the overflow containers.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sequence, type SequenceStep } from "./Sequence";

const STEPS: SequenceStep[] = [
  { id: "plan", label: "Plan", status: "complete" },
  { id: "build", label: "Build", status: "active" },
  { id: "test", label: "Test", status: "blocked", hint: "awaiting CI" },
  { id: "ship", label: "Ship" }, // no status → upcoming
];

const detail = (s: SequenceStep) => <span>DETAIL:{s.id}</span>;

describe("Sequence (#2477) — ordering + status", () => {
  it("renders every step as a button, in array order (order is the point)", () => {
    const { container } = render(<Sequence steps={STEPS} />);
    const labels = [...container.querySelectorAll(".seq-step .seq-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Plan", "Build", "Test", "Ship"]);
  });

  it("carries each step's status on the node — ✓ complete, ! blocked, 1-based position otherwise", () => {
    const { container } = render(<Sequence steps={STEPS} />);
    const nodes = [...container.querySelectorAll(".seq-node")];
    expect(nodes.map((n) => n.textContent)).toEqual(["✓", "2", "!", "4"]);
    expect(nodes[0].className).toContain("complete");
    expect(nodes[1].className).toContain("active");
    expect(nodes[2].className).toContain("blocked");
    expect(nodes[3].className).toContain("upcoming"); // the default status
  });

  it("joins steps with n−1 connectors — solid after a completed node, dim otherwise", () => {
    const { container } = render(<Sequence steps={STEPS} />);
    const conns = [...container.querySelectorAll(".seq-conn")];
    expect(conns).toHaveLength(STEPS.length - 1);
    expect(conns.map((c) => c.className.includes("solid"))).toEqual([true, false, false]);
  });

  it("renders nothing step-shaped (and does not throw) for an empty sequence", () => {
    const { container } = render(<Sequence steps={[]} detail={detail} />);
    expect(container.querySelectorAll(".seq-step")).toHaveLength(0);
    expect(container.querySelectorAll(".seq-conn")).toHaveLength(0);
    // The detail panel frame still renders; it just has no focused step to show.
    expect(container.textContent).not.toContain("DETAIL:");
  });
});

describe("Sequence — focus + selection", () => {
  it("uncontrolled: auto-focuses the active step and marks it aria-current", () => {
    render(<Sequence steps={STEPS} detail={detail} />);
    expect(screen.getByText("DETAIL:build")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Build/ })).toHaveAttribute("aria-current", "step");
  });

  it("uncontrolled: falls back to the first step when no step is active", () => {
    const noActive = STEPS.map((s) => (s.status === "active" ? { ...s, status: "upcoming" as const } : s));
    render(<Sequence steps={noActive} detail={detail} />);
    expect(screen.getByText("DETAIL:plan")).toBeInTheDocument();
  });

  it("uncontrolled: click-to-focus moves the detail panel and fires onSelect", () => {
    const onSelect = vi.fn();
    render(<Sequence steps={STEPS} detail={detail} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Ship/ }));
    expect(onSelect).toHaveBeenCalledWith("ship");
    expect(screen.getByText("DETAIL:ship")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ship/ })).toHaveAttribute("aria-current", "step");
  });

  it("uncontrolled: defaultSelectedId seeds the initial focus", () => {
    render(<Sequence steps={STEPS} detail={detail} defaultSelectedId="test" />);
    expect(screen.getByText("DETAIL:test")).toBeInTheDocument();
  });

  it("controlled: selectedId drives the focus; a click only fires onSelect (no internal takeover)", () => {
    const onSelect = vi.fn();
    render(<Sequence steps={STEPS} detail={detail} selectedId="test" onSelect={onSelect} />);
    expect(screen.getByText("DETAIL:test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ship/ }));
    expect(onSelect).toHaveBeenCalledWith("ship");
    // Still the controlled step — the parent owns the transition.
    expect(screen.getByText("DETAIL:test")).toBeInTheDocument();
    expect(screen.queryByText("DETAIL:ship")).toBeNull();
  });

  it("degrades a stale selection id to the active step", () => {
    render(<Sequence steps={STEPS} detail={detail} selectedId="deleted-step" />);
    expect(screen.getByText("DETAIL:build")).toBeInTheDocument();
  });

  it("omits the detail panel entirely when no detail render prop is given (strip-only)", () => {
    const { container } = render(<Sequence steps={STEPS} />);
    expect(container.querySelector(".seq-detail")).toBeNull();
  });
});

describe("Sequence — variants + frame", () => {
  it("horizontal (default): strip above the detail, scrolling in its own container (x)", () => {
    const { container } = render(<Sequence steps={STEPS} detail={detail} />);
    const strip = container.querySelector(".seq-strip") as HTMLElement;
    expect(strip.className).toContain("seq-h");
    expect(strip.style.overflowX).toBe("auto");
    expect(strip.style.borderBottom).toContain("var(--border-soft)");
  });

  it("vertical: a fixed-width timeline rail beside the detail, scrolling in its own container (y)", () => {
    const { container } = render(<Sequence steps={STEPS} detail={detail} orientation="vertical" railWidth={300} />);
    const strip = container.querySelector(".seq-strip") as HTMLElement;
    expect(strip.className).toContain("seq-v");
    expect(strip.style.width).toBe("300px");
    expect(strip.style.flex).toContain("300px");
    expect(strip.style.overflowY).toBe("auto");
    expect(strip.style.borderRight).toContain("var(--border-soft)");
  });

  it("shows the hint line in the vertical timeline only (tooltip carries it in both)", () => {
    const h = render(<Sequence steps={STEPS} />);
    expect(h.container.querySelector(".seq-hint")).toBeNull();
    expect(h.getByRole("button", { name: /Test/ })).toHaveAttribute("title", "awaiting CI");
    const v = render(<Sequence steps={STEPS} orientation="vertical" />);
    expect(v.container.querySelector(".seq-hint")?.textContent).toBe("awaiting CI");
  });

  it("renders the toolbar slot above the sequence; omits it when absent", () => {
    render(<Sequence steps={STEPS} toolbar={<span>TOOLBAR</span>} />);
    expect(screen.getByText("TOOLBAR")).toBeInTheDocument();
    const { container } = render(<Sequence steps={STEPS} />);
    expect(container.textContent).not.toContain("TOOLBAR");
  });

  it("merges the strip/detail escape hatches over the frame styles", () => {
    const { container } = render(
      <Sequence steps={STEPS} detail={detail}
        stripStyle={{ background: "red" }} detailStyle={{ padding: "0px" }} />,
    );
    const strip = container.querySelector(".seq-strip") as HTMLElement;
    expect(strip.style.background).toBe("red");
    expect(strip.style.overflowX).toBe("auto"); // the frame survives the merge
    const det = container.querySelector(".seq-detail") as HTMLElement;
    expect(det.style.padding).toBe("0px");
  });
});
