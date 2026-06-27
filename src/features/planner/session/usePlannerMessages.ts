// usePlannerMessages (#1775, extracted from Planning.tsx) — while the relay is paired, poll the
// planner PTY's transcript (newest 50 turns) so a phone mirrors the real chat, not the raw terminal.
// Empty + inert when not paired. (#934/#987)
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PlanMessage } from "@/features/tunnel/lib/tunnel";

export function usePlannerMessages(tunnelRunning: boolean, paneId: string): PlanMessage[] {
  const [plannerMessages, setPlannerMessages] = useState<PlanMessage[]>([]);
  useEffect(() => {
    if (!tunnelRunning) return;
    let cancelled = false;
    const load = () => invoke<PlanMessage[]>("read_pane_messages", { paneId, limit: 50 })
      .then((m) => { if (!cancelled) setPlannerMessages(m ?? []); })
      .catch(() => {});
    load();
    const id = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tunnelRunning, paneId]);
  return plannerMessages;
}
