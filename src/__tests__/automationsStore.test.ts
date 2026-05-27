import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";

const base = {
  name: "Nightly digest", armed: true,
  when: { every: "day" as const, at: "09:00" },
  targetTab: "orchestrator", targetPaneIdx: 0,
  action: "command" as const, command: "echo hi",
};

beforeEach(() => useAppStore.setState({ automations: [] }));

describe("automations store slice", () => {
  it("addAutomation seeds id/runs and computes nextRunAt when armed", () => {
    useAppStore.getState().addAutomation(base);
    const a = useAppStore.getState().automations[0];
    expect(a.id).toMatch(/^auto_/);
    expect(a.runs).toEqual([]);
    expect(a.lastRunAt).toBeNull();
    expect(a.nextRunAt).toBeTypeOf("number");
  });

  it("addAutomation leaves nextRunAt null when disarmed", () => {
    useAppStore.getState().addAutomation({ ...base, armed: false });
    expect(useAppStore.getState().automations[0].nextRunAt).toBeNull();
  });

  it("setAutomationArmed toggles the next-run schedule", () => {
    useAppStore.getState().addAutomation({ ...base, armed: false });
    const id = useAppStore.getState().automations[0].id;
    useAppStore.getState().setAutomationArmed(id, true);
    expect(useAppStore.getState().automations[0].nextRunAt).toBeTypeOf("number");
    useAppStore.getState().setAutomationArmed(id, false);
    expect(useAppStore.getState().automations[0].nextRunAt).toBeNull();
  });

  it("recordAutomationRun prepends the run, sets lastRunAt, and reschedules", () => {
    useAppStore.getState().addAutomation(base);
    const id = useAppStore.getState().automations[0].id;
    const t = Date.now();
    useAppStore.getState().recordAutomationRun(id, { at: t, status: "ok", note: "ran" });
    const a = useAppStore.getState().automations[0];
    expect(a.runs[0]).toEqual({ at: t, status: "ok", note: "ran" });
    expect(a.lastRunAt).toBe(t);
    expect(a.nextRunAt).toBeGreaterThan(t);
  });

  it("removeAutomation drops it", () => {
    useAppStore.getState().addAutomation(base);
    const id = useAppStore.getState().automations[0].id;
    useAppStore.getState().removeAutomation(id);
    expect(useAppStore.getState().automations).toEqual([]);
  });
});
