// Deliver a queued planner prompt into the live planning session (#1371). The focused pane
// queues an ad-hoc prompt via `requestPlannerPrompt` (e.g. the file-intake "Route to project"
// ROUTE_PROMPT, which tells the planner to route the dropped design/ files into the repo). That
// value used to be a dead drop — set in the store but never delivered — so design files were
// staged and the UI gate auto-completed, yet the planner was never told to route them.
//
// This hook closes that gap: when a prompt is queued for the active project, it injects it into
// the planner PTY (via the caller's `sendPrompt`) and clears it. Delivery is user-initiated (a
// button click queued it), so this does NOT resurrect the removed auto-injecting conductor.

import { useEffect } from "react";
import { useAppStore } from "@/store";

/**
 * Drain `pendingPlannerPrompt[projectId]` into the live planner session.
 * @param projectId  the active planning session key (`effectiveProjectId`)
 * @param sendPrompt injects one prompt into the planner PTY (Planning.tsx's `sendPrompt`)
 */
export function usePlannerPromptDelivery(projectId: string, sendPrompt: (prompt: string) => void) {
  const pending = useAppStore((s) => (projectId ? s.pendingPlannerPrompt[projectId] : undefined));
  const clearPlannerPrompt = useAppStore((s) => s.clearPlannerPrompt);
  useEffect(() => {
    if (!projectId || !pending) return;
    sendPrompt(pending);
    clearPlannerPrompt(projectId);
  }, [projectId, pending, sendPrompt, clearPlannerPrompt]);
}
