// Agents — profile → session-settings bridge (#255).
//
// Translates an editable `AgentProfile` (base mode + command allowlist + per-tool
// tri-states + path globs) into the exact inputs `ensure_session_settings` consumes —
// the SAME channel the role gate (#219) uses (allowedCommands / deniedCommands /
// allowToolRules / denyToolRules). Assigning a profile to a console pane therefore
// enforces it for real at session launch, not just in the UI. Pure + unit-testable.

import type { AgentProfile, ToolKey, Tier } from "./agentProfiles";
import { editPathRule } from "@/shared/lib/session/sessionRoles";

/** The Claude Code tool name(s) each profile capability maps to (bare, whole-tool rules). `edit`
 *  covers the in-place edit tools; `write` is creation; `web` is both fetch + search. No `MultiEdit`
 *  — it was removed from Claude Code (#3534). */
const TOOL_NAMES: Record<ToolKey, string[]> = {
  read: ["Read"],
  grep: ["Grep"],
  glob: ["Glob"],
  edit: ["Edit", "NotebookEdit"],
  write: ["Write"],
  bash: ["Bash"],
  web: ["WebFetch", "WebSearch"],
  task: ["Task"],
};

/** Settings-rule inputs for `ensure_session_settings`, identical to the role gate's. */
export interface ProfileSessionSettings {
  /** Shell prefixes auto-approved (wrapped as `Bash(<cmd> *)` by the backend). */
  allowedCommands: string[];
  /** Command prefixes to deny (the role gate supplies git/gh denies; profiles add none). */
  deniedCommands: string[];
  /** Verbatim tool-permission allows (`Read`, `Edit(src/**)`, …). */
  allowToolRules: string[];
  /** Verbatim tool-permission denies (deny wins over allow). */
  denyToolRules: string[];
  /** The catch-all shell disposition (the profile's bash tier) the backend uses to scale how
   *  generous the auto-approve baseline is (#1572): `allow` doers get the read-only + build
   *  baselines, `ask` coordinators get read-only only, `deny` gets neither. */
  bashPosture: Tier;
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/**
 * Map a profile to session settings.
 *
 * - **commands** → `allowedCommands` (auto-approve those shell prefixes).
 * - **tools** tri-states → `allow` (tier `allow`) / `deny` (tier `deny`) tool rules;
 *   `ask` is left unlisted so Claude Code prompts (the default).
 * - **paths** → file-write tool rules scoped per glob (`Edit(<glob>)` etc.); deny wins.
 *
 * Two deliberate edges:
 * - **`bash` is never blanket-denied.** A bare `Bash` deny would also kill the
 *   guaranteed `gh`/`git`; shell control flows through the command allowlist + the
 *   role gate instead. (Bash `allow` is harmless — the backend already allows it.)
 * - **`mode`** (the base policy) and **`net`** are advisory here: every capability the
 *   gate can express is enumerated by the per-tool tiers + paths, and host-level
 *   network limits aren't expressible via `settings.json`.
 */
export function resolveProfileSettings(profile: AgentProfile): ProfileSessionSettings {
  const allowToolRules: string[] = [];
  const denyToolRules: string[] = [];

  for (const [key, tier] of Object.entries(profile.tools) as [ToolKey, Tier][]) {
    if (tier === "deny") {
      if (key === "bash") continue; // see docstring — never blanket-deny Bash
      denyToolRules.push(...TOOL_NAMES[key]);
    } else if (tier === "allow") {
      allowToolRules.push(...TOOL_NAMES[key]);
    }
  }

  // Path-scoped file rules are `Edit(<glob>)` ONLY (#3534): Claude Code matches file-permission rules
  // on the Edit tool alone, and that one rule covers every file-editing tool. `Write(<glob>)` etc. were
  // never enforced — a silent no-op for an allow, an unenforced deny for a deny.
  for (const g of profile.paths.allow) allowToolRules.push(editPathRule(g));
  for (const g of profile.paths.deny) denyToolRules.push(editPathRule(g));

  return {
    allowedCommands: dedupe(profile.commands),
    deniedCommands: [],
    allowToolRules: dedupe(allowToolRules),
    denyToolRules: dedupe(denyToolRules),
    bashPosture: profile.tools.bash,
  };
}
