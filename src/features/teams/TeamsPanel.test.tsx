// TeamsPanel (#2193/#2333) — the Team designer opens with NO node selected (the empty sentinel), not
// focused on the first position (the director). Regression guard for #2333.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TeamsPanel } from "./TeamsPanel";
import { useAppStore } from "@/store";
import { nodeBox } from "./lib/orgLayout";

// The drill lives in the store since #2492 (nav-history integration) — reset it so a drill from one
// test can't leak a drilled canvas into the next render.
beforeEach(() => useAppStore.setState({ teamsDrill: null }));

describe("TeamsPanel initial selection (#2333)", () => {
  it("opens with nothing selected — the inspector shows no position (no 'Persona' section)", () => {
    render(<TeamsPanel />);
    // Sanity: the panel mounted over the seeded built-in library (Fleet Alpha is teams[0]).
    expect(screen.getByText("Fleet Alpha")).toBeTruthy();
    // The inspector's persona section only renders when an agent node is selected. With the empty
    // sentinel default, nothing is selected → no 'Persona' section. (Under the old bug the first
    // position — the director, an agent — was pre-selected and this section rendered.)
    expect(screen.queryByText("Persona")).toBeNull();
  });

  it("switching teams does not auto-focus a node either", () => {
    render(<TeamsPanel />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "org-swarm" } });
    expect(select.value).toBe("org-swarm");
    // Still nothing selected after the switch.
    expect(screen.queryByText("Persona")).toBeNull();
  });

  it("hides the inspector panel until a node is selected, then shows it", () => {
    render(<TeamsPanel />);
    // Open state: nothing selected → the inspector column is not rendered at all (no TeamsInspector
    // content). Previously the empty panel showed regardless of selection.
    expect(screen.queryByText("Persona")).toBeNull();
    // Adding a position selects it → the inspector appears (its 'Persona' section renders for the
    // new agent node).
    fireEvent.click(screen.getByText("＋ new"));
    expect(screen.getByText("Persona")).toBeTruthy();
  });
});

describe("pool card gesture — drag moves the stack, click drills (#2439)", () => {
  // Fleet Alpha's two engineers stack (#2436), so the seeded panel renders one pool card. The card
  // is the [data-node] wrapper around the drill hint.
  const poolCard = (): HTMLElement => {
    const hint = screen.getByText(/click to open/i);
    return hint.closest("[data-node]") as HTMLElement;
  };

  it("a plain click drills into the pool (unchanged)", () => {
    render(<TeamsPanel />);
    const card = poolCard();
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(card, { clientX: 101, clientY: 101 }); // < DRAG_THRESHOLD → click
    expect(screen.getByText("← back")).toBeTruthy();
  });

  it("a drag shifts every member by the same delta and does NOT drill", () => {
    render(<TeamsPanel />);
    const orgBefore = useAppStore.getState().teams[0];
    const before = new Map(orgBefore.positions.map((p) => [p.nodeId, nodeBox(p)]));
    const members = orgBefore.positions.filter((p) => p.personaId === "persona-worker").map((p) => p.nodeId);
    expect(members.length).toBeGreaterThanOrEqual(2); // sanity: the stacked engineers

    const card = poolCard();
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { clientX: 160, clientY: 140 }); // > DRAG_THRESHOLD → drag
    fireEvent.pointerUp(card, { clientX: 160, clientY: 140 });

    expect(screen.queryByText("← back")).toBeNull(); // a drag never drills
    // Every member shifted by ONE shared (dx, dy) — the centroid follows the drop, the pool's
    // internal arrangement is preserved for the drill-in.
    const after = useAppStore.getState().teams[0];
    const deltas = members.map((m) => {
      const b = before.get(m)!;
      const p = after.positions.find((x) => x.nodeId === m)!;
      return { dx: (p.x ?? 0) - b.x, dy: (p.y ?? 0) - b.y };
    });
    expect(deltas[0].dx).not.toBe(0);
    for (const d of deltas) expect(d).toEqual(deltas[0]);
  });

  it("node cards are not text-selectable (drag never highlights labels)", () => {
    render(<TeamsPanel />);
    expect(poolCard().style.userSelect).toBe("none");
  });
});

describe("auto-organize lays out the rendered graph (#2451)", () => {
  const poolCard = (): HTMLElement =>
    screen.getByText(/click to open/i).closest("[data-node]") as HTMLElement;
  const workers = () =>
    useAppStore.getState().teams[0].positions.filter((p) => p.personaId === "persona-worker");

  it("parent view: members translate by ONE shared delta (cluster preserved for drill-in, #2439)", () => {
    render(<TeamsPanel />);
    const before = new Map(workers().map((p) => [p.nodeId, nodeBox(p)]));
    expect(before.size).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByText("⤢ Auto organize"));

    const deltas = workers().map((p) => {
      const b = before.get(p.nodeId)!;
      return { dx: (p.x ?? 0) - b.x, dy: (p.y ?? 0) - b.y };
    });
    // one shared (dx, dy) — the pool moved as a unit onto its collapsed-layout spot
    for (const d of deltas) expect(d).toEqual(deltas[0]);
  });

  it("drilled view: auto-organize moves ONLY the members — boundary/parent nodes stay fixed", () => {
    render(<TeamsPanel />);
    // drill into the pool (a plain click)
    const card = poolCard();
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(card, { clientX: 100, clientY: 100 });
    expect(screen.getByText("← back")).toBeTruthy();

    const memberIds = new Set(workers().map((p) => p.nodeId));
    const othersBefore = useAppStore.getState().teams[0].positions
      .filter((p) => !memberIds.has(p.nodeId))
      .map((p) => ({ nodeId: p.nodeId, x: p.x, y: p.y }));

    fireEvent.click(screen.getByText("⤢ Auto organize"));

    const after = useAppStore.getState().teams[0].positions;
    for (const o of othersBefore) {
      expect(after.find((p) => p.nodeId === o.nodeId)).toMatchObject({ x: o.x, y: o.y });
    }
  });
});
