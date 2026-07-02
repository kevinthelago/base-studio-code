// usePlannerMessages (#1775, extracted from Planning.tsx) — while the relay is paired, poll the
// planner PTY's transcript (newest 50 turns) so a phone mirrors the real chat, not the raw terminal.
// Empty + inert when not paired. (#934/#987)
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePoll } from "@/shared/hooks/usePoll";
import type { PlanMessage } from "@/features/tunnel/lib/tunnel";

export function usePlannerMessages(tunnelRunning: boolean, paneId: string): PlanMessage[] {
  const [plannerMessages, setPlannerMessages] = useState<PlanMessage[]>([]);
  usePoll((isCancelled) => {
    if (!tunnelRunning) return;
    return invoke<PlanMessage[]>("read_pane_messages", { paneId, limit: 50 })
      .then((m) => { if (!isCancelled()) setPlannerMessages(m ?? []); })
      .catch(() => {});
  }, 3000, [tunnelRunning, paneId]);
  return plannerMessages;
}
