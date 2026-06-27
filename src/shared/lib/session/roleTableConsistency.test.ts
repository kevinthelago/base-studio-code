import { describe, it, expect } from "vitest";
import { ROLE_DEFAULTS, roleCapability, roleWriteRules, type SessionRole } from "./sessionRoles";
import { generateAgentProfile } from "./profileGen";
import type { AgentStream } from "@/features/planner/fleet/planFleet";

// Role-table consistency (#1759). Two tables encode the same per-role least-privilege model on
// different axes, with NO shared source — so they can silently drift:
//   sessionRoles.ROLE_DEFAULTS  — git / github / code / net ACCESS TIERS (the launch role gate)
//   profileGen.TOOLS_BY_ROLE    — read/edit/write/bash/web/task TRI-STATES (the generated profile)
//
// TOOLS_BY_ROLE isn't exported, so each role's tool policy is read through the public
// generateAgentProfile() — its `.tools` IS TOOLS_BY_ROLE[role]. The role set is derived from
// ROLE_DEFAULTS (the code), never hardcoded: a role added to one table but not the other, or a tier
// change that desyncs the two, fails here.

const ROLES = Object.keys(ROLE_DEFAULTS) as SessionRole[];
// generateAgentProfile only reads stream.id / .name / .owns.
const stream = { id: "s", name: "S", owns: ["src/"] } as unknown as AgentStream;
const toolsFor = (role: SessionRole) => generateAgentProfile(stream, role, []).tools;
// The file-write tools the role gate denies (mirrors WRITE_TOOLS in sessionRoles.ts).
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

describe("role-table consistency (sessionRoles ↔ profileGen)", () => {
  it("every role in ROLE_DEFAULTS has a tool policy in TOOLS_BY_ROLE", () => {
    for (const role of ROLES) {
      const tools = toolsFor(role);
      expect(tools, `TOOLS_BY_ROLE is missing role '${role}'`).toBeTruthy();
      // A fully-formed policy (catches a partially-specified role row).
      for (const k of ["read", "grep", "glob", "edit", "write", "bash", "web", "task"] as const) {
        expect(tools[k], `${role}.tools.${k} undefined`).toBeDefined();
      }
    }
  });

  it("no code:'none' role grants UNCONDITIONAL file writes (edit/write never 'allow')", () => {
    // An "ask" is tolerated (the role gate hard-denies it anyway — see the backstop test below);
    // an "allow" on a code:none role would be a genuine escalation the two tables disagree on.
    for (const role of ROLES) {
      if (ROLE_DEFAULTS[role].code !== "none") continue;
      const t = toolsFor(role);
      expect(t.edit, `${role}: code:none must not allow edit`).not.toBe("allow");
      expect(t.write, `${role}: code:none must not allow write`).not.toBe("allow");
    }
  });

  it("every code:'write' role can actually write (edit or write not both denied)", () => {
    for (const role of ROLES) {
      if (ROLE_DEFAULTS[role].code !== "write") continue;
      const t = toolsFor(role);
      expect(
        t.edit === "deny" && t.write === "deny",
        `${role}: code:write but its tool policy denies all writes`,
      ).toBe(false);
    }
  });

  it("net:'none' roles deny the web tools", () => {
    // Vacuous today (every role defaults net:'read'), but locks the invariant for a future
    // no-web role / planner toggle (#1107): the access tier and the tool tri-state must agree.
    for (const role of ROLES) {
      if (ROLE_DEFAULTS[role].net === "none") {
        expect(toolsFor(role).web, `${role}: net:none must deny web`).toBe("deny");
      }
    }
  });

  it("the role gate hard-denies the write tools for every code:none role (backstop over a loose profile)", () => {
    // This is the reconciliation that makes a looser profile safe: at launch the sessionRoles gate
    // denies the file-write tools outright for every code:none role with no commons carve-out, and
    // Claude Code precedence is deny > allow. So even where TOOLS_BY_ROLE is permissive (triage is
    // code:none yet edit/write:'ask', unlike director/tester/… which use 'deny'), writes are still
    // blocked. If a future edit removed this gate, a code:none role's profile tri-state would become
    // load-bearing — this test fails first.
    for (const role of ROLES) {
      if (ROLE_DEFAULTS[role].code !== "none") continue;
      const deny = roleWriteRules(roleCapability(role)).deny;
      for (const t of WRITE_TOOLS) {
        expect(deny, `${role}: role gate must deny ${t}`).toContain(t);
      }
    }
  });
});
