// Automations feature store slice (#1309) — schedules, commands, and cron automations. Extracted
// from the former grab-bag `automations` slice (which kept LLM config / active-project state, now
// in store/slices/core.ts). Composed into the app store by store/index.ts.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import { type Automation, type AutomationRun, appendRun, computeNextRun } from "./lib/scheduler";
import type { Schedule, Command } from "@/shared/data/mock";

export interface AutomationsSlice {
  schedules: Schedule[];
  addSchedule: () => void;
  updateSchedule: (id: string, patch: Partial<Schedule>) => void;
  removeSchedule: (id: string) => void;
  commands: Command[];
  addCommand: () => void;
  updateCommand: (id: string, patch: Partial<Command>) => void;
  removeCommand: (id: string) => void;
  automations: Automation[];
  addAutomation: (input: Omit<Automation, "id" | "lastRunAt" | "nextRunAt" | "runs">) => void;
  updateAutomation: (id: string, patch: Partial<Automation>) => void;
  removeAutomation: (id: string) => void;
  setAutomationArmed: (id: string, armed: boolean) => void;
  recordAutomationRun: (id: string, run: AutomationRun) => void;
}

export const createAutomationsSlice: StateCreator<AppStore, [], [], AutomationsSlice> = (set) => ({
  schedules: [],
  addSchedule: () =>
    set((s) => {
      const id = `S-${String(s.schedules.length + 1).padStart(2, "0")}`;
      const newSched: Schedule = {
        id, name: "New schedule", on: false,
        when: "every day · 02:00", target: "",
        action: "command", detail: "",
        lastRun: "—", nextRun: "—",
      };
      return { schedules: [...s.schedules, newSched] };
    }),
  updateSchedule: (id, patch) =>
    set((s) => ({ schedules: s.schedules.map((sc) => (sc.id === id ? { ...sc, ...patch } : sc)) })),
  removeSchedule: (id) =>
    set((s) => ({ schedules: s.schedules.filter((sc) => sc.id !== id) })),

  commands: [],
  addCommand: () =>
    set((s) => {
      const id = `cmd_${Math.random().toString(36).slice(2, 8)}`;
      const newCmd: Command = { id, name: "New command", cmd: "", used: 0, tags: [] };
      return { commands: [...s.commands, newCmd] };
    }),
  updateCommand: (id, patch) =>
    set((s) => ({ commands: s.commands.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  removeCommand: (id) =>
    set((s) => ({ commands: s.commands.filter((c) => c.id !== id) })),

  automations: [],
  addAutomation: (input) =>
    set((s) => {
      const id = `auto_${Math.random().toString(36).slice(2, 8)}`;
      const nextRunAt = input.armed ? computeNextRun(input.when, Date.now()) : null;
      const a: Automation = { ...input, id, lastRunAt: null, nextRunAt, runs: [] };
      return { automations: [...s.automations, a] };
    }),
  updateAutomation: (id, patch) =>
    set((s) => ({
      automations: s.automations.map((a) => {
        if (a.id !== id) return a;
        const next = { ...a, ...patch };
        // Editing the trigger or arming re-derives the next fire time.
        if ("when" in patch || "armed" in patch) {
          next.nextRunAt = next.armed ? computeNextRun(next.when, Date.now()) : null;
        }
        return next;
      }),
    })),
  removeAutomation: (id) =>
    set((s) => ({ automations: s.automations.filter((a) => a.id !== id) })),
  setAutomationArmed: (id, armed) =>
    set((s) => ({
      automations: s.automations.map((a) =>
        a.id === id
          ? { ...a, armed, nextRunAt: armed ? computeNextRun(a.when, Date.now()) : null }
          : a),
    })),
  recordAutomationRun: (id, run) =>
    set((s) => ({
      automations: s.automations.map((a) =>
        a.id === id
          ? { ...a, runs: appendRun(a.runs, run), lastRunAt: run.at, nextRunAt: computeNextRun(a.when, run.at) }
          : a),
    })),
});
