// Pure mappers for the per-agent page (#499): turn a worker's AgentProfile +
// AgentFlow into the render rows the page shows. Free of React/Tauri so the
// mapping is unit-testable and shared with the component.

import type { AgentProfile, ToolKey, Tier } from "../agents/agentProfiles";
import type { AgentFlow } from "./agentFlow";

/** Tool display order, matching the design's two-column Permissions card. */
export const TOOL_ORDER: ToolKey[] = ["read", "glob", "write", "web", "grep", "edit", "bash", "task"];

export interface PermRow { key: ToolKey; tier: Tier; }
/** Per-tool posture rows from the profile (empty when no profile is assigned). */
export function permissionRows(profile: AgentProfile | undefined): PermRow[] {
  if (!profile) return [];
  return TOOL_ORDER.map((key) => ({ key, tier: profile.tools[key] }));
}

export interface FlowRow { key: string; value: string; desc: string; }
/** The execution-flow rows (autonomy / push / trigger / gate) with descriptions. */
export function flowRows(flow: AgentFlow): FlowRow[] {
  return [
    { key: "autonomy", value: flow.autonomy, desc: "how it handles underspecified decisions" },
    { key: "push",     value: flow.push,     desc: "what / whether it pushes to GitHub" },
    { key: "trigger",  value: flow.trigger,  desc: "when a push fires" },
    { key: "gate",     value: flow.gate,     desc: "how a confirm pause is enforced" },
  ];
}

/** Parse a pane id "t{tab}p{pane}" into its tab + pane indices (or nulls). */
export function paneCoords(paneId: string): { tab: number; pane: number } | null {
  const m = /^t(\d+)p(\d+)$/.exec(paneId);
  return m ? { tab: Number(m[1]), pane: Number(m[2]) } : null;
}
