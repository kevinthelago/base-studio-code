// The Teams axis (`define-the-axis-for-teams-data-and-sounds`) — the TEAM, not a technology.
//
// Every other graph tabs by technology. Teams deliberately does not, and the reason is worth keeping
// next to the code: the first proposal was to tab by HARNESS (claude-code vs bsc-agent), and the
// maintainer rejected it because a tab bar splitting agents by runtime "suggests one llm can't work
// with another". That is false, and it is the wrong claim to build into the chrome. It also had no data
// behind it — a persona carries id, name and role, and nothing else.
//
// A team IS the cooperation unit, and this page already modelled the drill (#2742): an overview of
// cards, click one to enter, a breadcrumb back. The tabs ARE that drill, so a team may hold personas on
// any model or harness with nothing in the UI implying otherwise.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TeamsPanel } from "@/features/teams/TeamsPanel";
import { useAppStore } from "@/store";

// The seeded teams, captured once — the store is a singleton and other suites empty it (#3033).
const SEEDED_TEAMS = useAppStore.getState().teams;

vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80; rows = 24; options: Record<string, unknown> = {};
    loadAddon = vi.fn(); open = vi.fn(); write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() })); focus = vi.fn(); dispose = vi.fn();
    attachCustomKeyEventHandler = vi.fn(); getSelection = vi.fn(() => "");
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // `teamsDrill` lives in the store since #2492 (nav-history); reset it so a drill from another test
  // cannot leak a drilled canvas into this render.
  // `activePageTab` carries the entered team now, so reset it or a team entered by one case is still
  // entered in the next.
  useAppStore.setState({ teamsDrill: null, teams: SEEDED_TEAMS, activePageTab: {} });
});

/** A team's name shows in the TAB, the rail row AND the overview card, so tab queries are scoped to
 *  the strip. Asserting on a bare name would pass against any of the three. */
const tabNamed = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll(".tabstrip .tab")].find((t) => t.textContent?.trim() === label) as HTMLElement | undefined;

describe("the Teams axis is the TEAM", () => {
  it("offers a tab per team, plus the overview as the leading one", () => {
    const { container } = render(<TeamsPanel />);
    const labels = [...container.querySelectorAll(".tabstrip .tab")].map((t) => t.textContent?.trim());
    expect(labels[0]).toBe("All teams");
    for (const o of SEEDED_TEAMS) expect(labels, `${o.name} has a tab`).toContain(o.name);
  });

  it("opens on the overview, and selecting a team tab enters it", () => {
    const { container } = render(<TeamsPanel />);
    // The overview is the default: no team is entered until one is chosen.
    fireEvent.click(tabNamed(container, SEEDED_TEAMS[0].name)!);
    // Entering a team shows its breadcrumb — `Teams › <name>` — which the overview does not render.
    expect(screen.getByText("›")).toBeTruthy();
  });

  it("the breadcrumb climbs back to the overview TAB rather than bypassing the bar", () => {
    // Two selectors for one concept is how they drift apart. The crumb selects the overview tab; it is
    // not a second, parallel way to change teams.
    const { container } = render(<TeamsPanel />);
    fireEvent.click(tabNamed(container, SEEDED_TEAMS[0].name)!);
    expect(screen.getByText("›")).toBeTruthy();
    fireEvent.click(screen.getByText("Teams")); // the crumb
    expect(screen.queryByText("›")).toBeNull();  // back on the overview
  });

  it("does NOT tab by harness, model or any technology facet", () => {
    // The rejected axis, pinned so it cannot come back by accident. None of these may appear as a tab:
    // a team's members are not partitioned by what runs them.
    const { container } = render(<TeamsPanel />);
    for (const forbidden of ["claude-code", "bsc-agent", "TypeScript", "Rust", "react"]) {
      expect(tabNamed(container, forbidden), `${forbidden} must not be a Teams tab`).toBeUndefined();
    }
  });
});
