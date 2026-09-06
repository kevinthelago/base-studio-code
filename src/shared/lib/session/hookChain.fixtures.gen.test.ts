// The session's PreToolUse hook chain, captured from the LIVE TypeScript so the Rust composition can be
// proved equal.
//
// Every gate this epic has moved into Rust is ENFORCED by one of these hooks: `bsc-deny` reads
// `$BSC_DENY_BASH`, `bsc-scope` reads `$BSC_SCOPE_GLOBS`, `bsc-confine` bounds the filesystem. Rust
// supplies all of them — `console/shell_rc/mod.rs` writes the shell functions and `crates/bsc-hook` is
// the binary. WHICH ONES ARE REGISTERED is decided here, so a hook can be perfectly implemented and
// perfectly configured in Rust and simply never installed.
//
// That has happened. `turn-hooks.ts` exists because the turn-accounting pair fell out of a launch path
// twice — tokens.log dead for ~3 weeks (#3452), and the planner's cost invisible (#3455). This fixture
// asserts those entries appear in EVERY branch, which is the property a shared constant alone cannot
// give a path that composes its own list.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/session/hookChain.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildSessionSettings } from "@/app/console/lib/sessionLaunch";
import type { AppStore } from "@/store/types";

const FIXTURE = join(process.cwd(), "src/shared/lib/session/hookChain.fixtures.json");
const PANE = "p1";

const BASE = {
  deniedCommands: [], paneRoles: {}, paneRoleGlobs: {}, paneProfiles: {}, agentProfiles: [],
  paneFlows: {}, surfaceCatalog: [], fleetPaneStreams: {}, appRepoRoot: "/repo", bscBaseDir: "/base",
  mcpServers: [], skills: [], sessionSkillOverrides: {}, sessionSkillGroups: {}, skillGroups: [],
  paneSkills: {}, personas: [], panePersonas: {}, bypassPermissions: false,
};

/** A minimal profile, so the "has a profile but no role" gate can be exercised on its own. */
const PROFILE = {
  id: "pf_x", name: "x", color: "#000", category: "user", desc: "", mode: "ask",
  commands: [], tools: {}, paths: { allow: [], deny: [] }, net: { allow: [] },
};

/** A resolved skill, enough to trip the skills gate. */
const SKILL = { id: "sk1", name: "s", body: "b" };

type Case = { label: string; role?: string; profile?: boolean; skills?: boolean };

const SUBJECTS: Case[] = [
  { label: "UNGATED — no role, no profile, no skills: the floor only" },
  { label: "a profile but NO role — the gate is capability OR profile", profile: true },
  { label: "role worker — adds the superseded edit gate", role: "worker" },
  { label: "role triage — gated, but no superseded gate", role: "triage" },
  { label: "role director", role: "director" },
  { label: "role planner", role: "planner" },
  { label: "role designer", role: "designer" },
  { label: "role reviewer", role: "reviewer" },
  { label: "worker WITH skills — adds the skill hooks", role: "worker", skills: true },
  { label: "skills but UNGATED — skill hooks without the gated set", skills: true },
  { label: "worker with a profile too", role: "worker", profile: true },
  { label: "a profile AND skills, no role", profile: true, skills: true },
];

const settingsFor = (c: Case) =>
  buildSessionSettings(
    {
      ...BASE,
      paneRoles: c.role ? { [PANE]: c.role } : {},
      paneProfiles: c.profile ? { [PANE]: PROFILE.id } : {},
      agentProfiles: c.profile ? [PROFILE] : [],
      paneSkills: c.skills ? { [PANE]: [SKILL] } : {},
    } as unknown as AppStore,
    PANE,
  );

/** The observability pair that has twice gone missing. Matched on the command PREFIX because each
 *  registers under several matchers. */
const TURN_ACCOUNTING = ["bsc-activity", "bsc-tokens"];

describe("hookChain fixtures", () => {
  it("captures the chain over every gate combination", () => {
    const cases = SUBJECTS.map((c) => ({
      label: c.label,
      role: c.role ?? null,
      hasProfile: !!c.profile,
      hasSkills: !!c.skills,
      // The WHOLE entry, in order — event and matcher are as load-bearing as the command.
      hooks: settingsFor(c).hooks,
    }));
    const next = {
      note: "GENERATED from @/app/console/lib/sessionLaunch buildSessionSettings — do not hand-edit; see the .gen.test.ts",
      cases,
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("THE FLOOR: an ungated pane still gets confinement and command denies", () => {
    const cmds = settingsFor({ label: "" }).hooks.map((h: { command: string }) => h.command);
    expect(cmds, "filesystem confinement is unconditional").toContain("bsc-confine");
    expect(cmds, "command denies are unconditional").toContain("bsc-deny");
  });

  it("the turn-accounting hooks appear in EVERY branch — they have fallen out twice", () => {
    for (const c of SUBJECTS) {
      const cmds = settingsFor(c).hooks.map((h: { command: string }) => h.command);
      for (const prefix of TURN_ACCOUNTING) {
        expect(
          cmds.some((cmd: string) => cmd.startsWith(prefix)),
          `${c.label}: ${prefix} missing — #3452 killed tokens.log for three weeks this way`,
        ).toBe(true);
      }
    }
  });

  it("is non-vacuous: the three gates each actually change the chain", () => {
    const len = (c: Case) => settingsFor(c).hooks.length;
    expect(len({ label: "", role: "worker" }), "the capability gate adds hooks").toBeGreaterThan(len({ label: "" }));
    expect(len({ label: "", role: "worker" }), "the worker gate adds one more than triage").toBeGreaterThan(len({ label: "", role: "triage" }));
    expect(len({ label: "", role: "worker", skills: true }), "the skills gate adds hooks").toBeGreaterThan(len({ label: "", role: "worker" }));
  });
});
