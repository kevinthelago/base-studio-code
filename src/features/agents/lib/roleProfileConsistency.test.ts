import { describe, it, expect } from "vitest";
import { ROLE_DEFAULTS, roleCapability, roleWriteRules, type SessionRole } from "@/shared/lib/session/sessionRoles";
import { roleProfileId } from "@/shared/lib/session/roleProfile";
import { PROFILES, APP_ROLES, type AgentProfile } from "./agentProfiles";

// Role → profile consistency (the unified model). Every session role maps to a DEFAULT profile
// (roleProfile.ROLE_PROFILE), which must (a) exist in the packaged set and (b) not escalate past the
// role's code tier — a code:none role's profile must never auto-ALLOW the file-write tools. The role
// gate is the backstop: it hard-denies the write tools for code:none roles regardless of the profile.

const ROLES = Object.keys(ROLE_DEFAULTS) as SessionRole[];
const ALL: AgentProfile[] = [...PROFILES, ...APP_ROLES];
const profileFor = (role: SessionRole) => ALL.find((p) => p.id === roleProfileId(role));
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

describe("role → profile consistency (sessionRoles ↔ roleProfile)", () => {
  it("every role maps to a packaged profile that exists", () => {
    for (const role of ROLES) {
      expect(profileFor(role), `role '${role}' → '${roleProfileId(role)}' resolves to no profile`).toBeTruthy();
    }
  });

  it("no code:'none' role's profile auto-allows the file-write tools", () => {
    for (const role of ROLES) {
      if (ROLE_DEFAULTS[role].code !== "none") continue;
      const p = profileFor(role)!;
      expect(p.tools.edit, `${role}: code:none profile must not allow edit`).not.toBe("allow");
      expect(p.tools.write, `${role}: code:none profile must not allow write`).not.toBe("allow");
    }
  });

  it("the role gate hard-denies the write tools for every code:none role (backstop)", () => {
    // Makes a looser profile safe: at launch the sessionRoles gate denies the file-write tools
    // outright for every code:none role (no commons carve-out), and Claude precedence is deny > allow.
    for (const role of ROLES) {
      if (ROLE_DEFAULTS[role].code !== "none") continue;
      const deny = roleWriteRules(roleCapability(role)).deny;
      for (const t of WRITE_TOOLS) {
        expect(deny, `${role}: role gate must deny ${t}`).toContain(t);
      }
    }
  });
});
