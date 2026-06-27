// Agents — application-role display helpers (#740).
//
// Pure label/glyph derivation for the always-present application-role sessions
// (Project Planner, Planning Autopilot, …). Split out of AgentsScreen so the labels
// are React-free + unit-testable. Data-driven: known roles get a tailored icon/label;
// any future role derives one from its own fields.

import type { AgentProfile } from "./agentProfiles";

/** Short type chip for an app-session row, distinct per role (#740). */
export function appSessionTag(p: AgentProfile): string {
  switch (p.id) {
    case "sys_planner":             return "⌨ planner";
    case "sys_planning_autopilot":  return "◇ autopilot";
    default:                        return `${p.surfaceGlyph ?? "◆"} ${(p.name.split(" ")[0] ?? "role").toLowerCase()}`;
  }
}

/** The surface the app-role's "open … →" button points at — distinct per role (#740). */
export function appSessionOpenLabel(p: AgentProfile): string {
  switch (p.id) {
    case "sys_planner":             return "planner";
    case "sys_planning_autopilot":  return "settings";
    default:                        return (p.surface ?? "surface").toLowerCase();
  }
}

/** How other sessions interact with an app role — role-correct (the one-shot helpers aren't
 *  reached by other agents at all, so they don't get the planner/librarian reach note) (#740). */
export function appReachNote(p: AgentProfile): string {
  const first = p.name.split(" ")[0];
  switch (p.id) {
    case "sys_planner":   return `Other agents reach ${first} through the Plan surface — not by being assigned this role.`;
    default:              return `${first} runs on demand as a one-shot helper — it isn't reached by other agents, and can't be assigned to a pane.`;
  }
}
