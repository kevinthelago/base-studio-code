// useProjectComplete (#2623) — whether a project's BUILD has finished, for the fleet-drill's preview node.
// Polls the project's plan.db issues and derives `projectComplete` (every planned issue complete/verified).
// A null/empty key is never complete. The Glance workspace passes the DRILLED project so the ▷ preview node
// appears exactly when there's a finished app to render.
import { useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { bscJson } from "@/shared/lib/core/bsc";
import { projectComplete } from "@/shared/lib/fleet/streamCompletion";
import type { PlanIssue } from "@/features/planner/issues/planIssues";

const POLL_MS = 20000;

export function useProjectComplete(projectKey: string | null): boolean {
  const [complete, setComplete] = useState(false);
  usePoll(async (isCancelled) => {
    if (!projectKey) { setComplete(false); return; }
    const issues = await bscJson<PlanIssue[]>(projectKey, ["plan", "list", "--full", "--json"], []);
    if (isCancelled()) return;
    setComplete(projectComplete(issues));
  }, POLL_MS, [projectKey]);
  return complete;
}
