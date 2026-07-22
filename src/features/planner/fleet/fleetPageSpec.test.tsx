// The Fleet page's structure-as-data (#3504) — slice 3d of #3484.
//
// The acceptance bar for this slice is PARITY, not "it still renders", so these tests assert the
// things a spec migration silently loses: the grid template, the column assignment, the `minWidth: 0`
// that stops panels overflowing, and the `statgrid` class that carries the tile styling. A test that
// only checked "the page mounts" would have passed for every one of those regressions.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { KitRenderer, validateGeneralNode, visitNodes, type GeneralNode } from "@/shared/ui/spec";
import { FLEET_PAGE_SPEC, resolveFleetSpec } from "./fleetPageSpec";

/** Every slot name the spec expects the host to fill. */
function slotNames(): string[] {
  const names: string[] = [];
  visitNodes(FLEET_PAGE_SPEC, (n) => {
    if (n.type === "Slot") names.push(String(n.props?.name ?? ""));
  });
  return names;
}

/** Render the spec with every slot filled by an identifiable marker. */
function renderSpec(values: Record<string, unknown> = {}, on: Record<string, (...a: unknown[]) => void> = {}) {
  const slots = Object.fromEntries(slotNames().map((n) => [n, <div key={n} data-testid={`panel-${n}`} />]));
  return render(<KitRenderer node={FLEET_PAGE_SPEC} values={values} slots={slots} on={on} />);
}

describe("FLEET_PAGE_SPEC — the Fleet page's structure as data (#3504)", () => {
  it("validates against the real primitive contract", () => {
    expect(validateGeneralNode(FLEET_PAGE_SPEC)).toEqual([]);
  });

  it("names exactly the nine panels the host supplies, with no duplicates", () => {
    const names = slotNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([
      "costEnergy", "fleetHealth", "fleetLessons", "fleetStatus",
      "mergeQueue", "throughput", "timeToLand", "workerBoard",
    ]);
  });

  it("keeps the 1.6fr / 1fr split and puts each panel in its column", () => {
    const { container } = renderSpec();
    const split = container.querySelector('[style*="1.6fr"]') as HTMLElement;
    expect(split).toBeTruthy();
    expect(split.style.gridTemplateColumns).toBe("1.6fr 1fr");

    const [wide, narrow] = [...split.children] as HTMLElement[];
    const ids = (el: HTMLElement) =>
      [...el.querySelectorAll("[data-testid]")].map((n) => n.getAttribute("data-testid"));
    expect(ids(wide)).toEqual([
      "panel-workerBoard", "panel-fleetHealth", "panel-throughput", "panel-timeToLand",
    ]);
    expect(ids(narrow)).toEqual([
      "panel-fleetStatus", "panel-costEnergy", "panel-fleetLessons", "panel-mergeQueue",
    ]);
  });

  // Without `minWidth: 0` a grid child will not shrink below its content, and the wide panels
  // overflow their column. It is invisible in a render test that only asks "did it mount".
  it("keeps minWidth:0 on both columns so wide panels cannot overflow", () => {
    const { container } = renderSpec();
    const split = container.querySelector('[style*="1.6fr"]') as HTMLElement;
    for (const col of [...split.children] as HTMLElement[]) {
      expect(col.style.minWidth).toBe("0px");
    }
  });

  it("keeps the statgrid class and its six-column template", () => {
    const { container } = renderSpec();
    const grid = container.querySelector(".statgrid") as HTMLElement;
    expect(grid).toBeTruthy();
    expect(grid.style.gridTemplateColumns).toBe("repeat(6, 1fr)");
  });

  it("renders the six KPI tiles from host values, in order", () => {
    renderSpec({
      activeOfTotal: "3/7", needAttention: "2", idle: "4",
      landedToday: "5", prsMergedWeek: "9", avgLand: "6h",
    });
    for (const label of ["active workers", "need attention", "idle", "landed today", "PRs merged · 7d", "time-to-land"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const value of ["3/7", "2", "4", "5", "9", "6h"]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
  });

  it("binds the computed summary line rather than assembling prose in the spec", () => {
    renderSpec({ summary: "acme · 7 workers · 3 running · 2 need attention" });
    expect(screen.getByText("acme · 7 workers · 3 running · 2 need attention")).toBeInTheDocument();
  });

  it("wires both header actions to the host", () => {
    const refresh = vi.fn();
    const launchWorker = vi.fn();
    renderSpec({ refreshLabel: "↻ refresh" }, { refresh, launchWorker });
    screen.getByRole("button", { name: "↻ refresh" }).click();
    expect(refresh).toHaveBeenCalledOnce();
    screen.getByRole("button", { name: "launch worker" }).click();
    expect(launchWorker).toHaveBeenCalledOnce();
  });

  // The whole point of a slot is that the host fills it. A name with no entry must SAY so — a blank
  // panel is indistinguishable from a layout that meant to leave that space empty.
  it("an unfilled slot renders a visible marker, never a silent blank", () => {
    render(<KitRenderer node={FLEET_PAGE_SPEC} values={{}} slots={{}} />);
    expect(screen.getAllByText(/unfilled slot/).length).toBe(slotNames().length);
    expect(screen.getByText(/unfilled slot "workerBoard"/)).toBeInTheDocument();
  });
});

// The integration check that matters most: the SPEC asks for nine names and the HOST supplies nine
// names, and nothing in the type system connects the two — a typo on either side is a runtime hole.
// Rendering the real page and asserting no slot went unfilled is what makes that hole impossible to
// ship, and it is precisely the check a "does it mount" smoke test would pass straight through.
describe("Fleet — the host fills every slot the spec asks for (#3504)", () => {
  it("renders the real page with no unfilled slot", async () => {
    const { Fleet } = await import("./Fleet");
    const { container } = render(<Fleet />);

    // Assert the page is actually THERE first. "no unfilled slot" is trivially true of a page that
    // rendered nothing, so without these the interesting assertion below could pass vacuously.
    expect(screen.getByRole("heading", { name: "Fleet" })).toBeInTheDocument();
    expect(container.querySelector(".statgrid")).toBeTruthy();
    expect(screen.getByRole("button", { name: "launch worker" })).toBeInTheDocument();

    expect(screen.queryByText(/unfilled slot/)).toBeNull();
    expect(screen.queryByText(/unknown primitive/)).toBeNull();
  });
});

describe("resolveFleetSpec — the Fleet page skeleton comes from the store; the const is the fallback (#3569)", () => {
  it("returns the STORE spec when present and valid — so a Design Studio edit reflects on the page", () => {
    const stored: GeneralNode = { type: "Text", props: { children: "from the graph" } };
    expect(validateGeneralNode(stored)).toEqual([]); // precondition: it really is a valid tree
    expect(resolveFleetSpec(stored)).toBe(stored);
  });

  it("falls back to the packaged FLEET_PAGE_SPEC when the store node has no spec", () => {
    expect(resolveFleetSpec(undefined)).toBe(FLEET_PAGE_SPEC);
  });

  it("falls back to the seed when the store spec is INVALID — a malformed edit can't crash the page", () => {
    const bad = { type: "NotAPrimitive" } as unknown as GeneralNode;
    expect(validateGeneralNode(bad).length).toBeGreaterThan(0); // precondition: it really is invalid
    expect(resolveFleetSpec(bad)).toBe(FLEET_PAGE_SPEC);
  });
});
