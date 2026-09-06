// Which skills a session receives, captured from the LIVE TypeScript so the Rust resolution can be
// proved equal.
//
// Everything AROUND this decision is already Rust: `crates/skilldb` is the store, `bsc skill` its CLI,
// and `src-tauri/src/extensions/skills.rs::write_session_skills` writes the resolved list into
// `.claude/skills`. Only the choice of WHICH was here.
//
// That split has a recorded cost: a `bsc-agent` session received NO skills at all, because the only
// writer of `.claude/skills` is reached from `ensure_session_settings`, which the frontend calls only
// for a CLAUDE pane. The runtime scanned a directory nothing had created and looked exactly like a
// session that legitimately had none.
//
// THE STEP A PORT MOST EASILY LOSES is `overridden`: it is `on !== baseline`, so an override that
// AGREES with the baseline is NOT a deviation. Setting it from "an override mentions this skill" flags
// every redundant choice.
//
//     UPDATE_FIXTURES=1 npx vitest run src/features/skills/lib/skillResolution.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sessionSkillState, effectiveSessionSkills } from "@/features/skills/lib/skillsSession";
import { toSkillCfgs } from "@/features/skills/lib/skillsPayload";
import type { SkillDef } from "@/features/skills";
import type { SessionSkillOverride } from "@/features/skills/lib/skillsSession";

const FIXTURE = join(process.cwd(), "src/features/skills/lib/skillResolution.fixtures.json");
const PROJECT = "studio-code";

const skill = (over: Partial<SkillDef> & { id: string }): SkillDef =>
  ({
    kind: "procedure", source: "user", desc: `desc of ${over.id}`, prompt: `body of ${over.id}`,
    tools: [], profiles: [], projects: [], enabled: true, pinned: false, name: over.id,
    ...over,
  }) as SkillDef;

/** One library covering every branch of the precedence chain. */
const LIBRARY: SkillDef[] = [
  skill({ id: "global-on", name: "Global On" }),
  skill({ id: "global-pinned", name: "Global Pinned", pinned: true }),
  skill({ id: "in-project", name: "In Project", projects: [PROJECT] }),
  skill({ id: "other-project", name: "Other Project", projects: ["something-else"] }),
  skill({ id: "disabled-global", name: "Disabled Global", enabled: false }),
  skill({ id: "disabled-in-project", name: "Disabled In Project", enabled: false, projects: [PROJECT] }),
  skill({ id: "group-only", name: "Group Only", projects: ["something-else"] }),
  skill({ id: "tooled", name: "Tooled", tools: ["Read", "Grep"] }),
  // A name that slugs to nothing — `toSkillCfgs` must skip it: there is no directory to key it on.
  skill({ id: "unslugabble", name: "!!!" }),
  // A malformed projects entry. This exists to separate `projects.includes(projectId)` from
  // `projectId && projects.includes(projectId)`: with an EMPTY project id the two agree for every
  // well-formed skill, so without this case a port that drops the emptiness guard passes. It is not
  // hypothetical data hygiene — the guard is in the source precisely because the check runs before
  // anything validates the id.
  skill({ id: "empty-project-entry", name: "Empty Project Entry", projects: [""] }),
];

type Case = { label: string; projectId?: string; override?: SessionSkillOverride; groupIds?: string[] };

const SUBJECTS: Case[] = [
  { label: "no override, no groups — the plain baseline" },
  { label: "a group carries an out-of-scope skill in", groupIds: ["group-only"] },
  { label: "an override ADDS an out-of-scope skill", override: { add: ["other-project"], remove: [] } },
  { label: "an override REMOVES an in-scope skill", override: { add: [], remove: ["global-on"] } },
  { label: "remove beats add for the same skill", override: { add: ["global-on"], remove: ["global-on"] } },
  { label: "an override cannot enable a DISABLED skill", override: { add: ["disabled-global"], remove: [] } },
  { label: "an override cannot enable a disabled in-project skill", override: { add: ["disabled-in-project"], remove: [] } },
  { label: "REDUNDANT add — the skill was already on", override: { add: ["global-on"], remove: [] } },
  { label: "REDUNDANT remove — the skill was already off", override: { add: [], remove: ["other-project"] } },
  { label: "a group AND an override removing the same skill", groupIds: ["group-only"], override: { add: [], remove: ["group-only"] } },
  { label: "a group whose skill is ALSO in scope", groupIds: ["in-project"] },
  { label: "no project id at all — only globals are in scope", projectId: "" },
  { label: "no project id, but a group carries one in", projectId: "", groupIds: ["in-project"] },
];

describe("skillResolution fixtures", () => {
  it("captures the state of every skill under every combination", () => {
    const cases = SUBJECTS.map((c) => {
      const projectId = c.projectId ?? PROJECT;
      const groups = c.groupIds ? new Set(c.groupIds) : undefined;
      const eff = effectiveSessionSkills(LIBRARY, projectId, c.override, groups);
      return {
        label: c.label,
        projectId,
        override: c.override ?? null,
        groupIds: c.groupIds ?? [],
        states: LIBRARY.map((s) => {
          const st = sessionSkillState(s, projectId, c.override, groups);
          return { id: s.id, on: st.on, reason: st.reason, overridden: st.overridden };
        }),
        effective: eff.map((s) => s.id),
        payload: toSkillCfgs(eff),
      };
    });
    const next = {
      note: "GENERATED from @/features/skills/lib/skillsSession + skillsPayload — do not hand-edit; see the .gen.test.ts",
      library: LIBRARY.map((s) => ({ id: s.id, name: s.name, desc: s.desc, prompt: s.prompt, tools: s.tools, projects: s.projects, enabled: s.enabled, pinned: s.pinned })),
      cases,
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("EVERY reason value is exercised — the precedence is layered, not a boolean", () => {
    const seen = new Set<string>();
    for (const c of SUBJECTS) {
      const groups = c.groupIds ? new Set(c.groupIds) : undefined;
      for (const s of LIBRARY) seen.add(sessionSkillState(s, c.projectId ?? PROJECT, c.override, groups).reason);
    }
    for (const r of ["disabled", "added", "removed", "pinned", "global", "project", "group", "out-of-scope"]) {
      expect(seen.has(r), `no case produced reason "${r}"`).toBe(true);
    }
  });

  it("a REDUNDANT override is not flagged as a deviation", () => {
    const on = sessionSkillState(LIBRARY[0], PROJECT, { add: ["global-on"], remove: [] });
    expect(on.on).toBe(true);
    expect(on.overridden, "an add that agrees with the baseline is not an override").toBe(false);
  });

  it("a DISABLED skill cannot be turned on by any override", () => {
    const st = sessionSkillState(skill({ id: "d", enabled: false }), PROJECT, { add: ["d"], remove: [] });
    expect(st.on).toBe(false);
    expect(st.reason).toBe("disabled");
  });

  it("a name that slugs to nothing is dropped from the payload", () => {
    expect(toSkillCfgs(LIBRARY).map((c) => c.id), "no directory to key an empty slug on").not.toContain("unslugabble");
  });
});
