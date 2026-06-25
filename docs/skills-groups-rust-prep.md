# Skills task-groups — the Rust channel (#1338, an instance of #1325)

The **frontend** half of task groups (#skills-groups) is shipped and tested: the `SkillGroup` model +
resolver (`src/features/skills/lib/skills.ts`), the store slice (`skillGroups`, `sessionSkillGroups`,
+ actions, persisted), the launch wiring (`projects.ts` / `TerminalView.tsx` expand a session's groups
into `effectiveSessionSkills`), the redesigned **library** + the **per-session modal**.

**Decision — Solution B-global (#1338).** Skills + groups live in ONE **global** SQLite store +
a `bsc-skill` CLI injected into **every** session — NOT a per-project `plan.db`. Rationale: a group
authored in one session (the planner, or any session) must be reachable + resolvable by *every other
live session*, and a per-project `plan.db` reaches only that project's sessions (and would split groups
from their parent skills). Co-locating skills + groups in one global, CLI-addressable db is exactly
#1325's thesis (give a running session runtime debug access to app state + `bsc-*` functions).

**Key architectural fact (unchanged):** groups expand to skills *on the frontend* before anything
reaches the SKILL.md writer — `effectiveSessionSkills(...) → SkillCfg[] → ensure_session_settings →
write_session_skills`. So `write_session_skills` / `ensure_session_settings` keep receiving the final,
group-expanded skill list; groups are invisible to them. The global store is the **library** the
frontend (and any session's shell) reads/writes; it is not on the per-session SKILL.md write path.

## Phasing

### Slice 1 — the crate + CLI (DONE, this issue's first slice)
`crates/skilldb` — a Tauri-free SQLite store + the `bsc-skill` CLI, self-contained, validated in
isolation (per #1325's "one domain end-to-end first"). Lands the store + CLI; wires nothing into the app.

- **Store** (`crates/skilldb/src/lib.rs`): a global `skills.db` (default `~/.base-studio-code/skills.db`),
  opened with **WAL mode + a busy_timeout** so the CLI and the live app share it concurrently (#1325).
  - `skills` table — columns from the frontend `SkillDef` (`id` PK, `name`, `kind`, `source`, `desc`,
    `prompt`, `tools`/`profiles`/`projects` as JSON TEXT, `enabled`/`pinned`/`packaged` flags, +
    `position`/`updated_at`). The display-only telemetry fields are deliberately NOT persisted (they're
    derived from the usage log).
  - `skill_groups` table — `id` PK, `name`, `hue` (default `var(--accent)`), `skill_ids` JSON array,
    `position`, `updated_at` — mirrors the frontend `SkillGroup`.
  - Methods: skills `upsert / list / get / remove`; groups `group_add / group_upsert / group_list /
    group_get / group_remove / group_toggle_member`; and `resolve(group_id) → Vec<Skill>` (ordered,
    de-duped, existence-filtered — the frontend `expandGroups` + existing-skill filter semantics).
  - `serde` emits the **camelCase** JSON the frontend reads (`skillIds`, …).
- **CLI** (`crates/skilldb/src/bin/bsc-skill.rs`): `list` · `add` (JSON on stdin) · `group {add,list,
  get,remove,member}` · `resolve <group-id>`. JSON to stdout (like `bsc-plan`). Db located via
  `--db <path>`, `BSC_SKILL_DB`, else the default global path.

### Slice 2 — app integration (next)
- Thin `#[tauri::command]` wrappers over `crates/skilldb` (unchanged behavior; existing tests green).
- `console/pty.rs`: inject `BSC_SKILL_DB` + `bsc-skill` on PATH for **every** session (runtime access).
- Frontend store-source swap: read the library from the skilldb bridge (persist = cache).
- `AgentStream.groupIds?: string[]` (parallel to `mcp?`); `fleetStartProject` already merges
  `stream.groupIds ∪ sessionSkillGroups[key]` → `expandGroups`.
- `planner/directives.rs` authors groups via `bsc-skill group …`; `planner/templates.rs` documents the verbs.

### Slice 3 — hot-apply (optional follow-up)
A running session toggles a group → `write_session_skills` re-materializes its `.claude/skills/`
without a relaunch.

## Concurrency / liveness (the #1325 crux)
SQLite **WAL + busy_timeout** (set on open in slice 1); atomic (temp+rename) SKILL.md writes stay as
the app already does them. The live app caches the library in memory (Zustand); a CLI mutation to the
global db is reflected on the next read/poll — document the per-command refresh expectation when the
app integration (slice 2) wires the read path.
