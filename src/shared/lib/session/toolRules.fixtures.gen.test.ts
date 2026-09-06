// The session's tool rules and bypass posture, captured from the LIVE TypeScript so the Rust
// composition can be proved equal.
//
// This is the `permissions` block `ensure_session_settings` writes, plus the `bypass` flag that decides
// whether `permissions.deny` is honoured AT ALL. Under bypass every deny in this same block stops
// applying and only the PreToolUse hooks still gate — which is why the hook chain, the denies and the
// write scope all matter as much as they do.
//
// TWO THINGS THIS FIXTURE EXISTS TO PIN:
//   · `flowPermissionRules` FAILS CLOSED. Its default branch denies. It used to fall through to "no
//     rules", which under the broad Bash allow PERMITS push and PR — and `self-merge` reached the
//     remote through exactly that branch.
//   · `bypass` is a three-way precedence, not a boolean: always-on for a full-capability debug session,
//     never for a restricted role, and the global toggle for everything else.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/session/toolRules.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildSessionSettings } from "@/app/console/lib/sessionLaunch";
import { roleCapability, type SessionRole } from "@/shared/lib/session/sessionRoles";
import { DEBUG_STUDIO_SESSION_ID, DEBUG_STUDIO_PANE_PREFIX } from "@/shared/lib/session/systemSessions";
import type { AppStore } from "@/store/types";

const FIXTURE = join(process.cwd(), "src/shared/lib/session/toolRules.fixtures.json");
const PANE = "p1";

const BASE = {
  deniedCommands: [], paneRoles: {}, paneRoleGlobs: {}, paneProfiles: {}, agentProfiles: [],
  paneFlows: {}, surfaceCatalog: [], fleetPaneStreams: {}, appRepoRoot: "/repo", bscBaseDir: "/base",
  mcpServers: [], skills: [], sessionSkillOverrides: {}, sessionSkillGroups: {}, skillGroups: [],
  paneSkills: {}, personas: [], panePersonas: {}, bypassPermissions: false,
};

const PROFILE = {
  id: "pf_x", name: "x", color: "#000", category: "user", desc: "", mode: "ask",
  commands: ["cargo test"], tools: { read: "allow", write: "deny", bash: "ask" },
  paths: { allow: ["src/**"], deny: ["**/*.env"] }, net: { allow: [] },
};

/** Every push policy, INCLUDING one that is not a case — the fail-closed branch. */
const PUSHES = ["auto-pr", "self-merge", "push-confirm", "local", "commit-only", "none", "a-policy-nobody-added-yet"];

const ROLES: SessionRole[] = [
  "planner", "worker", "director", "triage", "reviewer", "juror",
  "documentor", "designer", "architect", "librarian", "marketer",
] as SessionRole[];

type Case = { label: string; pane?: string; role?: string; profile?: boolean; push?: string; gate?: string; bypass?: boolean };

const SUBJECTS: Case[] = [
  { label: "UNGATED — no role, no profile" },
  ...ROLES.map((r) => ({ label: `role ${r}`, role: r })),
  { label: "a profile but no role", profile: true },
  { label: "a worker with a profile", role: "worker", profile: true },
  { label: "a designer — a RESTRICTED role with its own allow list", role: "designer" },

  // Every flow push value against a worker, plus the gate variants of push-confirm.
  ...PUSHES.map((p) => ({ label: `worker + push ${p}`, role: "worker", push: p })),
  { label: "worker + push-confirm with a SOFT gate", role: "worker", push: "push-confirm", gate: "soft" },
  { label: "worker + push-confirm with a HARD gate", role: "worker", push: "push-confirm", gate: "hard" },
  { label: "no flow at all — the default push is `local`", role: "worker" },

  // The three-way bypass precedence.
  { label: "BYPASS: global off, ordinary role", role: "worker", bypass: false },
  { label: "BYPASS: global ON, ordinary role — follows the toggle", role: "worker", bypass: true },
  { label: "BYPASS: global off, RESTRICTED role — never bypass", role: "designer", bypass: false },
  { label: "BYPASS: global ON, RESTRICTED role — still never bypass", role: "designer", bypass: true },
  { label: "BYPASS: the standing debug session — ALWAYS bypass", pane: DEBUG_STUDIO_SESSION_ID, bypass: false },
  { label: "BYPASS: a per-request debug session — always bypass too", pane: `${DEBUG_STUDIO_PANE_PREFIX}req-7`, bypass: false },
];

const settingsFor = (c: Case) => {
  const pane = c.pane ?? PANE;
  return buildSessionSettings(
    {
      ...BASE,
      bypassPermissions: !!c.bypass,
      paneRoles: c.role ? { [pane]: c.role } : {},
      paneProfiles: c.profile ? { [pane]: PROFILE.id } : {},
      agentProfiles: c.profile ? [PROFILE] : [],
      paneFlows: c.push ? { [pane]: { push: c.push, ...(c.gate ? { gate: c.gate } : {}) } } : {},
    } as unknown as AppStore,
    pane,
  );
};

describe("toolRules fixtures", () => {
  it("captures the permissions block over every role, profile and flow", () => {
    const cases = SUBJECTS.map((c) => {
      const s = settingsFor(c);
      const pane = c.pane ?? PANE;
      return {
        label: c.label,
        paneId: pane,
        role: c.role ?? null,
        hasProfile: !!c.profile,
        push: c.push ?? null,
        gate: c.gate ?? null,
        globalBypass: !!c.bypass,
        capability: c.role ? roleCapability(c.role as SessionRole, {}) ?? null : null,
        allowedCommands: s.allowedCommands,
        allowToolRules: s.allowToolRules,
        denyToolRules: s.denyToolRules,
        askToolRules: s.askToolRules,
        bashPosture: s.bashPosture,
        restrictedAllow: s.restrictedAllow,
        bypass: s.bypass,
      };
    });
    const next = { note: "GENERATED from @/app/console/lib/sessionLaunch buildSessionSettings — do not hand-edit; see the .gen.test.ts", cases };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("THE FLOW FAILS CLOSED: an unrecognised push value DENIES rather than permitting", () => {
    // `self-merge` reached the remote through a permissive fallthrough. This is that regression.
    const unknown = settingsFor({ label: "", role: "worker", push: "a-policy-nobody-added-yet" });
    expect(unknown.denyToolRules, "an unthought-of policy must not reach a remote").toEqual(
      expect.arrayContaining(["Bash(git push *)", "Bash(gh pr create *)"]),
    );
  });

  it("the .claude/** confinement deny is FIRST — a session must not rewrite its own permissions", () => {
    for (const c of SUBJECTS) {
      expect(settingsFor(c).denyToolRules[0], `${c.label}: confinement is not first`).toBe("Edit(.claude/**)");
    }
  });

  it("bypass is a THREE-WAY precedence, not a boolean", () => {
    expect(settingsFor({ label: "", pane: DEBUG_STUDIO_SESSION_ID, bypass: false }).bypass, "full-capability wins over the toggle").toBe(true);
    expect(settingsFor({ label: "", role: "designer", bypass: true }).bypass, "a restricted role is never bypass").toBe(false);
    expect(settingsFor({ label: "", role: "worker", bypass: true }).bypass).toBe(true);
    expect(settingsFor({ label: "", role: "worker", bypass: false }).bypass).toBe(false);
  });
});
