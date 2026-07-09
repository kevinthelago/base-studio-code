// TeamsPanel (#2193/#2333/#2742) — navigation is IN the graph now: the panel opens on the Teams
// overview (team cards), and you click a card to enter a team. Tests enter a team first, then exercise
// the per-team behavior (#2333 no auto-focus, pools, auto-organize).
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TeamsPanel } from "./TeamsPanel";
import { useAppStore } from "@/store";
import { nodeBox } from "./lib/orgLayout";

// The drill lives in the store since #2492 (nav-history integration) — reset it so a drill from one
// test can't leak a drilled canvas into the next render. Also start at the overview (orgId is local).
beforeEach(() => useAppStore.setState({ teamsDrill: null }));

/** Enter a team from the Teams overview by clicking its card (the [data-node] wrapper). */
const teamCard = (name: string): HTMLElement =>
  screen.getAllByText(name).map((el) => el.closest("[data-node]")).find(Boolean) as HTMLElement;
const enter = (name: string) => fireEvent.click(teamCard(name));
const FLEET = "Fleet Alpha";

describe("Teams overview — the top navigation level (#2742)", () => {
  it("opens on the Teams overview: team cards + a New team card, and NO org dropdown", () => {
    render(<TeamsPanel />);
    expect(screen.queryByRole("combobox")).toBeNull();            // the header org-switcher is gone
    expect(teamCard(FLEET)).toBeTruthy();                          // each team is a card
    expect(screen.getByText("New team")).toBeTruthy();            // + the trailing New team card
    expect(screen.getAllByText("Teams").length).toBeGreaterThan(0); // breadcrumb/rail title
  });

  it("clicking a team card enters it (per-team toolbar), and the Teams crumb climbs back", () => {
    render(<TeamsPanel />);
    enter(FLEET);
    // Inside the team: the position actions appear; the overview's New team card is gone.
    expect(screen.getByText("⤢ Auto organize")).toBeTruthy();
    expect(screen.queryByText("New team")).toBeNull();
    // Climb back via the "Teams" breadcrumb crumb → the overview returns.
    fireEvent.click(screen.getByText("Teams"));
    expect(screen.getByText("New team")).toBeTruthy();
    expect(screen.queryByText("⤢ Auto organize")).toBeNull();
  });
});

describe("TeamsPanel initial selection (#2333)", () => {
  it("entering a team focuses nothing — the inspector shows no 'Persona' section", () => {
    render(<TeamsPanel />);
    enter(FLEET);
    expect(screen.queryByText("Persona")).toBeNull();
  });

  it("entering a different team also auto-focuses nothing", () => {
    render(<TeamsPanel />);
    const second = useAppStore.getState().teams[1].name;
    enter(second);
    expect(screen.queryByText("Persona")).toBeNull();
  });

  it("hides the inspector panel until a node is selected, then shows it", () => {
    render(<TeamsPanel />);
    enter(FLEET);
    expect(screen.queryByText("Persona")).toBeNull();
    fireEvent.click(screen.getByText("＋ new"));                   // add a position → selects it
    expect(screen.getByText("Persona")).toBeTruthy();
  });
});

describe("pool card gesture — drag moves the stack, click drills (#2439)", () => {
  // Fleet Alpha's two engineers stack (#2436), so the entered panel renders one pool card. The card
  // is the [data-node] wrapper around the drill hint.
  const poolCard = (): HTMLElement => {
    const hint = screen.getByText(/click to open/i);
    return hint.closest("[data-node]") as HTMLElement;
  };

  it("a plain click drills into the pool (unchanged)", () => {
    render(<TeamsPanel />);
    enter(FLEET);
    const card = poolCard();
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(card, { clientX: 101, clientY: 101 }); // < DRAG_THRESHOLD → click
    // Now in the pool sub-graph — the breadcrumb shows the pool crumb (× count).
    expect(screen.getByText(/pool · ×/)).toBeTruthy();
  });

  it("a drag shifts every member by the same delta and does NOT drill", () => {
    render(<TeamsPanel />);
    enter(FLEET);
    const orgBefore = useAppStore.getState().teams[0];
    const before = new Map(orgBefore.positions.map((p) => [p.nodeId, nodeBox(p)]));
    const members = orgBefore.positions.filter((p) => p.personaId === "persona-worker").map((p) => p.nodeId);
    expect(members.length).toBeGreaterThanOrEqual(2); // sanity: the stacked engineers

    const card = poolCard();
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { clientX: 160, clientY: 140 }); // > DRAG_THRESHOLD → drag
    fireEvent.pointerUp(card, { clientX: 160, clientY: 140 });

    expect(screen.queryByText(/pool · ×/)).toBeNull(); // a drag never drills
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
    enter(FLEET);
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
    enter(FLEET);
    const before = new Map(workers().map((p) => [p.nodeId, nodeBox(p)]));
    expect(before.size).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByText("⤢ Auto organize"));

    const deltas = workers().map((p) => {
      const b = before.get(p.nodeId)!;
      return { dx: (p.x ?? 0) - b.x, dy: (p.y ?? 0) - b.y };
    });
    for (const d of deltas) expect(d).toEqual(deltas[0]);
  });

  it("drilled view: auto-organize moves ONLY the members — boundary/parent nodes stay fixed", () => {
    render(<TeamsPanel />);
    enter(FLEET);
    const card = poolCard();
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(card, { clientX: 100, clientY: 100 });
    expect(screen.getByText(/pool · ×/)).toBeTruthy();

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
