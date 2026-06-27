import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutomationsScreen } from "./";
import { useAppStore } from "@/store";

beforeEach(() => {
  useAppStore.setState({
    automations: [],
    automationsTab: "schedules",
    tabs: [{ name: "orchestrator", layout: "2×2", state: "idle" }],
  });
});

const seed = (over = {}) =>
  useAppStore.getState().addAutomation({
    name: "X", armed: false,
    when: { kind: "simple", every: "day", at: "09:00" },
    targetTab: "orchestrator", targetPaneIdx: 0,
    action: "command", command: "echo hi",
    ...over,
  });

describe("AutomationsScreen (wired to the store)", () => {
  it("shows an empty state with no automations", () => {
    render(<AutomationsScreen />);
    expect(screen.getByText("No automations yet")).toBeTruthy();
  });

  it("creates an automation and edits its name", () => {
    const { container } = render(<AutomationsScreen />);
    fireEvent.click(screen.getByText("+ New automation"));
    expect(useAppStore.getState().automations.length).toBe(1);

    // Creating selects the new automation, opening its slide-in editor drawer.
    const nameInput = container.querySelector(".pane-head .name-input") as HTMLInputElement;
    expect(nameInput.value).toBe("New automation");
    fireEvent.change(nameInput, { target: { value: "Nightly digest" } });
    expect(useAppStore.getState().automations[0].name).toBe("Nightly digest");
  });

  it("arms an automation, which schedules a next run", () => {
    seed();
    const { container } = render(<AutomationsScreen />);
    fireEvent.click(screen.getByText("X")); // open the editor drawer for the seeded automation
    expect(useAppStore.getState().automations[0].nextRunAt).toBeNull();
    fireEvent.click(container.querySelector(".pane-head .toggle") as HTMLElement);
    expect(useAppStore.getState().automations[0].armed).toBe(true);
    expect(useAppStore.getState().automations[0].nextRunAt).toBeTypeOf("number");
  });

  it("switches an automation to cron recurrence", () => {
    seed();
    const { container } = render(<AutomationsScreen />);
    fireEvent.click(screen.getByText("X")); // open the editor drawer for the seeded automation
    fireEvent.click(screen.getByText("cron")); // the "cron" mode pill
    expect(useAppStore.getState().automations[0].when.kind).toBe("cron");
    const cronInput = Array.from(container.querySelectorAll(".pane-drawer input.input"))
      .some(el => (el as HTMLInputElement).value === "0 9 * * *");
    expect(cronInput).toBe(true);
  });

  it("opens the slide-in editor drawer on select, closes on done, removes on remove", () => {
    seed();
    const { container } = render(<AutomationsScreen />);
    // closed until a schedule is selected
    expect(container.querySelector(".pane-drawer.on")).toBeNull();
    fireEvent.click(screen.getByText("X"));
    expect(container.querySelector(".pane-drawer.on")).toBeTruthy();
    // "done" closes the drawer without deleting
    fireEvent.click(screen.getByText("done"));
    expect(container.querySelector(".pane-drawer.on")).toBeNull();
    expect(useAppStore.getState().automations.length).toBe(1);
    // reopen and remove
    fireEvent.click(screen.getByText("X"));
    fireEvent.click(screen.getByText("remove"));
    expect(useAppStore.getState().automations.length).toBe(0);
    expect(container.querySelector(".pane-drawer.on")).toBeNull();
  });

  it("shows recorded runs in History, filterable by status", () => {
    seed({ armed: true });
    const id = useAppStore.getState().automations[0].id;
    const t = Date.now();
    useAppStore.getState().recordAutomationRun(id, { at: t, status: "ok", note: "ran command" });
    useAppStore.getState().recordAutomationRun(id, { at: t + 1, status: "skipped", note: "target not open" });

    const { container } = render(<AutomationsScreen />);
    fireEvent.click(screen.getByText("History")); // switch to the History tab
    expect(screen.getByText("success rate")).toBeTruthy();
    const dataRows = () => container.querySelectorAll(".hist-table .hist-row:not(.head)").length;
    expect(dataRows()).toBe(2);
    fireEvent.click(container.querySelector('.status-chip[data-st="skipped"]') as HTMLElement);
    expect(dataRows()).toBe(1);
  });
});
