# Skills task-groups — staged Rust changes (apply on go)

The **frontend** half of task groups (#skills-groups) is implemented and tested: the `SkillGroup`
model + resolver (`src/lib/session/skills.ts`), the store slice (`skillGroups`, `sessionSkillGroups`,
+ actions, persisted), the launch wiring (`projects.ts` / `TerminalView.tsx` expand a session's
groups into `effectiveSessionSkills`), the redesigned **library** (Surface A, `screens/skills/index.tsx`)
and the **per-session modal** (Surface B, `SessionSkillsModal.tsx`).

**Key architectural fact:** groups expand to skills *on the frontend* before anything reaches Rust —
`effectiveSessionSkills(...) → SkillCfg[] → ensure_session_settings → write_session_skills`. So
**no Rust change is needed for groups to take effect in a session.** The Rust work is only about the
**planner channel** — letting the *Claude planning session* author groups and toggle them onto a
fleet stream (the user can already do both manually via the UI). The Rust is under restructuring, so
this is staged, not applied.

## What to change, when you give the go

### 1. Planner channel — author + assign groups
Mirror the existing skills channel (`skills.json → upsertSkills`, #1086). Pick one:

- **File channel (lighter):** the planner writes `skill_groups.json` to the project hub
  (`~/.base-studio-code/projects/<key>/`). Frontend already has the parser (`parseSkillGroupsFile`)
  and store upsert (`upsertSkillGroups`) — wiring the read is a small **frontend** follow-up
  (poll + `upsertSkillGroups`, parallel to how `skills.json` is read). **Rust:** `setup_workspaces`
  in `src-tauri/src/lib.rs` should scaffold/allow `skill_groups.json`, and the planner spec
  (`CLAUDE.md` template / `src-tauri/templates/*.md`) must document the file + its shape:
  `[{ "name": "Release day", "hue": "var(--accent)", "skills": ["<skill name or slug>", …] }]`.

- **plan.db channel (more native, per [[plan-db-architecture]]):** add a `bsc-plan skill-group`
  verb to `crates/plandb` + the `bsc-plan` CLI (create/add-member/assign-to-stream), and a
  `skill_groups` table. Frontend reads via the existing plan.db bridge. Heavier, but consistent
  with how issues/features already flow.

### 2. Stream group assignment (`AgentStream` gains `groupIds`)
For "toggle a group onto a stream", the fleet stream model needs `groupIds: string[]`:
- **Frontend:** `AgentStream` type (`src/screens/planner/fleet/…`) + the planner fleet authoring.
- **Launch:** in `fleetStartProject` (`store/slices/projects.ts`), a worker's effective groups become
  `stream.groupIds ∪ sessionSkillGroups[key]` before the `expandGroups(...)` call already in place
  (one-line change — the resolver already accepts the merged set).
- **Rust:** wherever `fleet.json` / the stream schema is written/validated (lib.rs `setup_workspaces`,
  plan.db `crates/plandb`) gains the `groupIds` field; the planner spec documents assigning a group
  to a stream.

### 3. Planner spec / templates
Extend the planner `CLAUDE.md` template (in `src-tauri/src/lib.rs` / `src-tauri/templates/`) to teach
the planner the task-groups concept and the chosen channel from (1)/(2): author reusable groups,
attach a group to a stream, so a stream's workers get the whole bundle at launch.

### Explicitly NOT changing
- `write_session_skills` / `ensure_session_settings` — they keep receiving the final, group-expanded
  skill list; groups are invisible to them.
- SKILL.md format — groups are an app concept, not a Claude Code one.

## Suggested order
1. Decide channel: `skill_groups.json` (fast) vs `bsc-plan skill-group` (plan.db-native).
2. Rust: schema/scaffold (`groupIds` on streams; `skill_groups.json` or plan.db table) + planner spec.
3. Frontend follow-up: read the channel → `upsertSkillGroups` + stream-group merge in `fleetStartProject`.
