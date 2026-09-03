// The RENDERED settings a session actually launches with — the one artifact no other guard reads.
//
// Three defects shipped together in `surface-operator-runs-confined-to-its-own-noun`, and every gate
// leg was green for all of them, because each existed only in the composed result: a granted noun
// that `permissions.deny` also matched, a confined session writing into a shared tree, and a role the
// cage could not classify. The fixtures next door capture SHAPE per role; this asserts a PROPERTY of
// the composition — that the file does not contradict itself.
import { describe, it, expect } from "vitest";
import { buildSessionSettings } from "@/app/console/lib/sessionLaunch";
import { ROLE_DEFAULTS, type SessionRole } from "@/shared/lib/session/sessionRoles";
import type { AppStore } from "@/store/types";

const PANE = "p:0";

/** A REAL catalog, not `[]`. An empty one denies nothing extra by design, so a test that passed one
 *  would assert the invariant against a settings file with no surface denies in it at all — vacuous,
 *  and it passed the bite unchanged until this was fixed. These are the surfaces the operator's noun
 *  is drawn from plus a few it must never reach. */
const CATALOG = [
  { name: "studio" }, { name: "persona" }, { name: "teams" }, { name: "graph" }, { name: "ui" },
  { name: "plan" }, { name: "surface" }, { name: "request" }, { name: "errors" }, { name: "mem" },
  { name: "perf" }, { name: "logs" }, { name: "session" }, { name: "worktree" }, { name: "disk" },
  { name: "component", status: "deprecated" },
];

const BASE = {
  paneRoles: {}, paneProfiles: {}, agentProfiles: [], paneRoleGlobs: {}, deniedCommands: [],
  paneFlows: {}, surfaceCatalog: CATALOG, fleetPaneStreams: {}, appRepoRoot: "/repo", bscBaseDir: "/base",
  mcpServers: [], skills: [], sessionSkillOverrides: {}, sessionSkillGroups: {}, skillGroups: [],
  paneSkills: {}, personas: [], panePersonas: {}, bypassPermissions: false,
} as unknown as AppStore;

/** The command a `Bash(...)` rule names, or null for a whole-tool rule like `Read`. */
function bashPrefix(rule: string): string | null {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return null;
  return m[1].replace(/\s*\*$/, "").trim();
}

/**
 * Does `deny` swallow `allow`? Claude Code precedence is deny > ask > allow, so an allow the deny
 * list also matches is not a grant — it is a grant that silently does nothing.
 *
 * A trailing `*` makes a rule a PREFIX; without one it matches the bare command. Both directions
 * matter: `Bash(bsc studio *)` in deny swallows `Bash(bsc studio)` in allow, which is exactly the
 * pair the operator shipped with.
 */
function denySwallows(deny: string, allow: string): boolean {
  const d = bashPrefix(deny), a = bashPrefix(allow);
  if (d === null || a === null) return false;
  return deny.includes("*") ? a === d || a.startsWith(`${d} `) : a === d;
}

function contradictions(settings: { allowedCommands?: string[]; deniedCommands?: string[] }) {
  const allow = (settings.allowedCommands ?? []).map((c) => `Bash(${c})`);
  const deny = (settings.deniedCommands ?? []).map((c) => `Bash(${c})`);
  const out: string[] = [];
  for (const a of allow) for (const d of deny) if (denySwallows(d, a)) out.push(`${a} is granted, and ${d} denies it`);
  return out;
}

const settingsFor = (role: string | undefined, profile?: Record<string, unknown>) =>
  buildSessionSettings(
    {
      ...BASE,
      paneRoles: role ? { [PANE]: role } : {},
      paneProfiles: profile ? { [PANE]: profile.id as string } : {},
      agentProfiles: profile ? [profile] : [],
    } as unknown as AppStore,
    PANE,
  ) as unknown as { allowedCommands?: string[]; deniedCommands?: string[] };

describe("a rendered session never denies what it grants", () => {
  // THE REGRESSION. The operator's noun arrives on a per-pane PROFILE, because a noun chosen per
  // session is not something a static role can name. The undeclared-surface complement was built from
  // the ROLE alone, so `Bash(bsc studio *)` landed in allow AND deny — and deny wins, leaving the one
  // command that session exists to run denied by the same change that granted it.
  it("a granted per-pane noun is not denied by the role's undeclared-surface complement", () => {
    const profile = {
      id: "gen_surface_studio", name: "op", color: "#000", category: "generated", desc: "", mode: "deny",
      commands: ["bsc studio", "bsc-ask", "bsc-answer"],
      tools: { read: "allow", grep: "allow", glob: "allow", edit: "deny", write: "deny", bash: "deny", web: "deny", task: "deny" },
      paths: { allow: [], deny: ["**/*"] }, net: { allow: [] },
    };
    const s = settingsFor("operator", profile);
    expect(s.allowedCommands ?? []).toContain("bsc studio");
    expect(contradictions(s)).toEqual([]);
  });

  // The property, over the whole table — so the next role added cannot reintroduce it quietly.
  it("holds for every role in the capability table", () => {
    for (const role of Object.keys(ROLE_DEFAULTS) as SessionRole[]) {
      expect(contradictions(settingsFor(role)), role).toEqual([]);
    }
  });

  it("holds for a pane with no role at all", () => {
    expect(contradictions(settingsFor(undefined))).toEqual([]);
  });
});
