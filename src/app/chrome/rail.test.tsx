import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Rail } from "@/app/chrome/Rail";
import { useAppStore } from "@/store";

// The rail's top→bottom order is product-defined (#872); lock it so a stray reorder is caught.
// Buttons carry the screen label as their `title`. Console is opt-in (#2372) — hidden by default.
const FULL = [
  // "Skills" was here until it moved onto the Teams page and stopped being a rail destination
  // (skills-move-to-teams-and-pair-with-personas).
  // "MCP" was here until mcp-moves-to-teams — an MCP server is agent capability, so it is READ on
  // the Teams page beside the agents that get it rather than owning a rail destination.
  "Console", "Glance", "Planner", "Automations",
  "GitHub", "Logs", "Settings",
];
const NO_CONSOLE = FULL.filter((l) => l !== "Console");

const titlesOf = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".rail button")).map((b) => b.getAttribute("title"));

beforeEach(() => useAppStore.setState({ showConsolePage: false }));

describe("Rail", () => {
  it("hides the Console destination by default (#2372)", () => {
    const { container } = render(<Rail active="glance" onNavigate={() => {}} />);
    expect(titlesOf(container)).toEqual(NO_CONSOLE);
  });

  it("shows Console first when the toggle is on, in the defined order (#872)", () => {
    useAppStore.setState({ showConsolePage: true });
    const { container } = render(<Rail active="console" onNavigate={() => {}} />);
    expect(titlesOf(container)).toEqual(FULL);
  });

  it("labels the Logs screen and navigates by its key", () => {
    // Was the Agents/Security destination; the Security workspace dissolved into Logs
    // (the-logs-workspace-scaffold-and-activity). The rail reads WORKSPACES, so the label and the
    // key it dispatches come from ONE registry entry -- this pins that they are the new pair.
    const onNavigate = vi.fn();
    const { container } = render(<Rail active="glance" onNavigate={onNavigate} />);
    const logs = container.querySelector('.rail button[title="Logs"]') as HTMLElement;
    expect(logs).toBeTruthy();
    expect(container.querySelector('.rail button[title="Security"]')).toBeNull();
    fireEvent.click(logs);
    expect(onNavigate).toHaveBeenCalledWith("logs");
  });

  it("no longer exposes Design Studio as a rail destination (#move-to-planner — it's a Planner tab now)", () => {
    const { container } = render(<Rail active="glance" onNavigate={() => {}} />);
    expect(container.querySelector('.rail button[title="Design Studio"]')).toBeNull();
  });

  it("marks the active screen", () => {
    const { container } = render(<Rail active="github" onNavigate={() => {}} />);
    const active = container.querySelector(".rail button.active") as HTMLElement;
    expect(active.getAttribute("title")).toBe("GitHub");
  });
});
