// The Plan tab as it is actually wired into the open node (#4102) — the integration the pure tests
// cannot see: the tab exists, switching reaches the plan screen, and the terminal SURVIVES the switch.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlanceChatDock } from "./GlanceChatDock";

// xterm cannot init in jsdom, and the Logs tab polls `bsc` — same stubs the sibling dock/morph tests use.
vi.mock("@/app/console/terminal/TerminalSlot", () => ({
  TerminalSlot: ({ paneId }: { paneId: string }) => <div data-testid="terminal" data-pane={paneId} />,
}));
vi.mock("./GlanceSessionLog", () => ({ GlanceSessionLog: () => <div data-testid="logs" /> }));
vi.mock("@/shared/lib/core/safeInvoke", () => ({ fireInvoke: vi.fn() }));

const PLAN = {
  refs: ["#3871", "#3992"],
  states: new Map([["3871", true], ["3992", false]]),
  progress: { done: 1, total: 2 },
};

describe("the open node's Plan screen (#4102)", () => {
  it("offers Plan beside Stream and Logs, and shows the worker's issues", () => {
    render(<GlanceChatDock paneId="studio-code:console" name="console" role="worker" plan={PLAN} onClose={() => {}} />);
    const tab = screen.getByRole("button", { name: "Plan" });
    fireEvent.click(tab);
    expect(screen.getByText("#3871")).toBeInTheDocument();
    expect(screen.getByText("#3992")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("keeps the terminal MOUNTED while the Plan tab is showing", () => {
    // The load-bearing one: the terminal is re-parented into this dock by the single TerminalHost, so
    // unmounting it on a tab switch would drop its claim and tear down the agent's view. Stream and
    // Logs already rely on this (hidden, not unmounted) — Plan must not be the tab that breaks it.
    render(<GlanceChatDock paneId="studio-code:console" name="console" plan={PLAN} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-pane", "studio-code:console");
  });

  it("omits the Plan tab for a node that owns no plan at all", () => {
    // A studio / debug session is not a planned worker; an always-empty tab would read as a bug.
    render(<GlanceChatDock paneId="studio:designer" name="designer" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stream" })).toBeInTheDocument();
  });

  it("still lists the issues when GitHub is unavailable", () => {
    render(
      <GlanceChatDock
        paneId="studio-code:console" name="console" onClose={() => {}}
        plan={{ refs: ["#3871"], states: new Map(), unresolved: true }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.getByText("#3871")).toBeInTheDocument();
    expect(screen.getByText("state unknown")).toBeInTheDocument();
  });
});
