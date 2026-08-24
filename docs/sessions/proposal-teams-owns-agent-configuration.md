# Teams owns agent configuration

> **SESSION ARTIFACT — not maintained.** A PROPOSAL, written for discussion and never implemented as written. Its direction largely arrived by another route: personas are read on the Teams page, `bsc persona` is the write surface, and the rail is now nine Workspaces rather than seven pages. The capability-collapse it argued for is tracked as `the-persona-is-the-whole-agent`.
> See [`README.md`](README.md) for why this lives here.

**Status:** proposal, for discussion. Nothing implemented.
**Scope:** the first slice of the "seven pages" refactor — collapse roles + personas + permission
profiles into the Teams page, and rebuild its right-hand panel to carry them.

---

## The recommendation in one paragraph

Today an "agent" is described by **three** overlapping records (a `SessionRole`, a `Persona`, and an
`AgentProfile`) edited on **three different surfaces** (Settings, the Teams inspector, the Security
workspace), and two of them are called "role" in the UI. Collapse it to **two**: a **Role** (the
capability floor — what a session is *allowed* to do) and a **Persona** (the behavioural identity —
*how* it works, on a role). `AgentProfile` stops being an authored record and becomes a **derivation**
of the role, which is what it already almost is. Teams becomes the one place both are managed, by
turning its left rail into the **library** (Teams · Personas · Roles) and its right panel into a
**persistent, sectioned inspector** that serves any selected entity from either the canvas or the rail.
The Security workspace then has nothing left that is configuration, so its live half (Assignments,
Activity, Flow) moves to Glance and the rail destination disappears.

---

## 1. Where the seven pages come from

The target is `glance · projects · teams · components · algorithms · sounds · data`. Six of the seven
already exist as **Planner tabs** (`PROJECT_MODES`, `features/planner/list/projectModes.ts`); Glance is
already a rail Workspace. So the end-state rail is *the Planner's tab strip, promoted*, and every other
rail destination has to find a home.

| Today (rail `Workspace`) | Destination | Note |
|---|---|---|
| `glance` | **Glance** | stays |
| `projects` (Planner) | **dissolves into its 6 tabs** | the tab strip becomes the rail |
| `security` | **Teams** (config) + **Glance** (runtime) | this proposal |
| `skills` | **Teams** | a skill is injectable agent context; it attaches to a persona |
| `mcp` | **Data** or **Glance** | MCP servers are already Glance nodes (`GNodeKind`) |
| `automation` | **Projects** | a cron rule dispatches into a project's pane |
| `github` | **Projects** | it is already a per-project board view |
| `console` | **Glance** | already opt-in (`showConsolePage`), already redirects to Glance when off |
| `settings` | **titlebar / overlay**, not a page | it is app preferences, not a pillar |

| Today (Planner tab) | Becomes |
|---|---|
| `projects` | **Projects** |
| `teams` | **Teams** |
| `designs` (labelled "Components") | **Components** |
| `algorithms` | **Algorithms** |
| `sounds` | **Sounds** |
| `data` | **Data** |

This document only does the `security → teams` half. The rest is listed so the seam is chosen once
rather than re-argued per page. **The seam is: Teams is design-time (who exists, what they may do);
Glance is run-time (who is running, what they did).**

---

## 2. What is actually fragmented today — measured

| Concept | Count | Defined in | Edited where | Persisted where |
|---|---|---|---|---|
| **`SessionRole`** | 17 | `data/permissions/role-capabilities.json` → `shared/lib/session/roleModel` | **nowhere** — read-only table in Settings → Security (`AgentRolesCard`) | a config-dir overlay file |
| **`AgentProfile`** — *labelled "role" in the UI* | 5 packaged + user | `src-tauri/data/roles/*.json` | Security → **Profiles** (full CRUD: "New role" / "Delete role") | zustand `agentProfiles`, per-pane `paneProfiles` |
| **`Persona`** | 18 packaged + user | `src-tauri/data/personas/*.json` | Teams inspector, **only when a position is selected** | `personas.db` via `bsc persona` |
| **`Team`/`Position`/`Relationship`** | 3 packaged teams | `data/teams/{orgs,archetypes,communication-forms}` | Teams page (inspect + delete; the architect session authors) | `orgs.db` via `bsc teams` |
| **`AgentFlow`** (autonomy/push/gate) | per-stream | `features/planner/fleet/agentFlow` | Planner → Streams | `plan.db` |

Three findings from that table drive everything below.

**(a) "Role" means two different things on screen.** Security's Profiles tab prompts *"New role"* and
*"Delete role"* while editing an `AgentProfile`; Settings shows a read-only table of the *other* thing,
also called roles. Whichever one a user learns first makes the other one wrong.

**(b) The Persona layer is currently a 1:1 shadow of the role table.** All 18 packaged personas map to a
distinct role except `juror`, which has two (`persona-juror`, `persona-auditor`). Every one of them has
**zero** attached skills. The persona/role split is real and worth keeping — but nothing in the shipped
set exercises it, which is why it reads as duplication.

**(c) The Profile layer carries almost no information the Role does not.** 5 packaged profiles serve 17
roles, and `roleProfileId` sends **12 of 17** to the same `pf_review`. The role gate already derives
`roleWriteRules` / `roleDeniedTools` / `roleDeniedCommands` / `bscAgentPerms` from the capability row —
and `roleProfileConsistency.test.ts` exists *solely* to prove the hand-maintained profile never
contradicts the derived gate. A test whose job is to police two encodings of one fact is the signal that
there should be one encoding.

And a fourth, smaller: **`PersonasPanel` is mounted nowhere.** It is exported from
`@/features/personas` and seeded as a record (`personaspanel`, builtin, rev 5), but no route renders it —
the standalone Personas tab was folded into Teams in #2199. So today a persona that is not *placed in a
team* is unreachable in the UI.

---

## 3. The vocabulary collapse — three layers to two

### Role — the capability floor (keep, make first-class)
`{ github, git, code, net, ui }` tiers + `writeGlobs` + `harvestRoots`. Packaged, non-deletable,
17 entries. This is the enforcement core and everything else reads through it.

### Persona — the behavioural identity (keep, give it a home)
`{ name, blurb, role, startPrompt, skills[], responsibilities[], model, pooled }`. Many personas → one
role. This is the user's authoring unit and the thing a fleet stream actually binds to.

### Profile — **derive it, stop authoring it**
`{ mode, commands[], tools{8 tri-states}, paths{allow,deny}, net{allow} }` becomes a **projection of the
role**, computed the same way `roleWriteRules` already computes half of it. The five packaged JSONs
become named *presets* on the role table (or vanish); "custom profiles" become **user-defined roles**.

What that removes: the `agentProfiles` store slice, `src-tauri/data/roles/*.json` as an authored set,
`roleProfileId`'s hand-written 17-entry map, the Security → Profiles CRUD, and
`roleProfileConsistency.test.ts` (replaced by a derivation test — *the projection equals the gate*,
which is a stronger claim than *they don't disagree*).

**The one guard rail that must survive:** `clampTiers` in `roleModel.ts` exists because a stale config
mirror silently reverted a director-role narrowing — *"a security default that a stale file can silently
revert is not a default."* A UI that can **widen** a role is a privilege-escalation path. So: **roles are
viewable and *narrowable* in the UI, never wideable past the packaged ceiling.** Custom roles are minted
at or below an existing role's ceiling. This is the same contract `clampTiers` already enforces, just
extended to a second writer.

---

## 4. The Teams page

### 4.1 Three columns, always

```
+--------------+------------------------------------+----------------------+
|  LIBRARY     |  CANVAS                            |  INSPECTOR           |
|  (rail)      |  L0 team cards / L1 position graph |  (always present)    |
|              |                                    |                      |
| search...    |   +----+       +----+              | * Documentor         |
|              |   |    |------>|    |              |   persona - built-in |
| v Teams   3  |   +----+       +----+              | -------------------- |
|   Fleet Alpha|        \       /                   | v Summary            |
|   Studio Net |         +----+                     | v Behaviour          |
|   Build Swarm|         |    |                     | v Skills          0  |
|              |         +----+                     | v Runtime            |
| v Personas 18|                                    | v Charter         3  |
|   Worker  x4 |                                    | v Used by         2  |
|   Director   |                                    | -------------------- |
|   Reviewer ! |                                    | [clone]    [delete]  |
|              |                                    |                      |
| v Roles   17 |                                    |                      |
|   worker   W |                                    |                      |
|   director R |                                    |                      |
+--------------+------------------------------------+----------------------+
|  * Team architect - teams, personas & roles via bsc          [resize]    |
+--------------------------------------------------------------------------+
```

The canvas and the architect dock are unchanged. The two changes are the **rail** and the **inspector**.

### 4.2 The rail becomes the library

Today the rail shows teams at L0 and positions-grouped-by-department at L1 — it re-purposes itself per
level. Instead, give it **three persistent sections** using the `RailSection` / `useRailSections` /
`SearchField` machinery already on the page:

- **Teams · N** — click enters that team's graph *and* selects it into the inspector.
- **Personas · N** — grouped by role, each row showing its placement count; **unplaced personas are
  flagged** (the gap `PersonasPanel` was supposed to cover). Click selects into the inspector without
  moving the canvas.
- **Roles · 17** — grouped by posture (`write` / `read` / restricted-studio). Click selects.

One search box filters all three. At L1 the positions-by-department list becomes a **fourth section**
(*This team · N*) rather than replacing the rail wholesale, so the library stays reachable from inside a
team. That single change is what lets Teams absorb two other surfaces without gaining a tab strip.

### 4.3 The inspector — the part that needs the most work

**Problems with the current panel** (`teams-inspector`):

1. It is **hidden whenever `sel.id === ""`**, so the page is two columns most of the time and the layout
   jumps on every selection.
2. It knows **two** entity types (position, relationship) — no team, no persona, no role.
3. It **inlines the whole `PersonaEditor`** under a selected position. That is a *global library object*
   being edited from inside a *local graph node*, guarded by one line of prose ("changes reach every
   position that uses it"). It is the page's sharpest footgun.
4. It is **one unbroken scroll**. The `worker` and `director` personas carry the full protocol markdown
   in `startPrompt`; that alone makes the panel unusable at 344px.
5. Capability is **display-only** (`RoleTierChips`) with a bare `<select>` for the role — you can see the
   floor but not reason about it or change it.

**Proposed shape** — one component, one entity at a time, identical skeleton for every kind:

```
HEADER      glyph - name - kind badge - provenance chip (built-in / user) - breadcrumb
BODY        collapsible sections (SectionLabel idiom, per-kind, state remembered per kind)
FOOTER      pinned lifecycle actions - never at the bottom of a long scroll
```

| Selected | Sections |
|---|---|
| **Team** | Roster (by department) · **Coverage** (roles represented / missing) · Archetypes in use · Danger: delete |
| **Position** | Identity → the persona as a **link card**, not an inlined editor · Local label override · Communication (derived, as today) · Danger: delete position |
| **Persona** | Summary (blurb + role link card) · **Behaviour** (start prompt; collapsed, expands to full height) · Skills (chip picker) · Runtime (model · pooled) · Charter (responsibilities) · **Used by** (every team+position, clickable) · Actions: clone / delete |
| **Role** | **Capability** (5 axes, narrowable segmented controls, ceiling-clamped) · Write scope (globs) · Auto-run surface (`restrictedAllow` / denied commands, derived, read-only) · **Tool posture** (the 8 tri-states, *derived* — this is what the profile used to hand-hold) · Personas on this role · Actions: reset to packaged |
| **Relationship** | Archetype picker · the two form lanes · Danger: delete |
| **nothing** | **the current team's summary** (or, at L0, the library summary) — the panel is never blank |

Three consequences worth stating:

- **Persona editing moves out of the position inspector.** Selecting a position shows *which* identity it
  embodies and links to it; changing the identity itself is an explicit navigation to a global object.
  The footgun becomes a click.
- **The inspector needs a small back-stack.** position → persona → role is a natural drill; a breadcrumb
  in the inspector header (matching the page's existing `Teams › ‹team›` idiom) climbs back.
- **`Selection` widens** from `{ type: "node" | "edge"; id }` to a five-kind tagged union
  (`team | position | relationship | persona | role`). That is the only type change the canvas sees, and
  `TeamsCanvas` keeps emitting the two it already emits.

---

## 5. What gets deleted

| Thing | Why |
|---|---|
| `features/personas/PersonasPanel` (+ the `personaspanel` record + seed) | its function is the rail section + the persona inspector; it is currently mounted nowhere anyway |
| `features/settings/cards/AgentRolesCard` | a read-only role table superseded by a real, editable one |
| `features/settings/cards/AgentsCard` | already just a pointer to "the Permissions screen" plus two `opacity: 0.5` placeholders |
| Security → **Profiles** tab + `ProfilesTab` record | profiles derive from roles |
| `src-tauri/data/roles/*.json` as an **authored** set | becomes presets/derivation |
| `shared/lib/session/roleProfile.ts`'s hand-written map | derived |
| `features/security/lib/roleProfileConsistency.test.ts` | replaced by a derivation test |
| the `security` rail `Workspace` | nothing configuration-shaped is left on it |

Moved rather than deleted: **Assignments**, **Activity**, **Flow** → Glance (they are live-fleet views,
and Glance is already the cockpit).

---

## 6. What Teams does *not* take

- **Flows** (`autonomy` / `push` / `trigger` / `gate`) stay in **Projects → Streams**. They are a
  per-project binding of a global identity, not the identity. Same reasoning as
  `3151-epic-teams-in-the-planner`, which already exists for the project↔team binding.
- **Per-pane assignment** (`paneProfiles` / `paneRoles`) is runtime → Glance.
- **Skills** should land on Teams eventually (a skill is injectable agent context attached to a persona),
  as a fourth rail section — but not in this slice. `4228-lessons-belong-in-the-planner-not-skills` is
  already pulling the Skills page apart from the other end.

---

## 7. New backend surface: `bsc role`

There is no `bsc role` today — the role table is a build-time JSON with a config-dir overlay
(`overlayFile("permissions/role-capabilities.json")`). Making roles editable needs a real store, and the
cheapest correct one is the pattern `bsc persona` / `bsc teams` already use:
`bsc_json_store::cli::run` over a pure-data `CliSpec`, `list / get / set / remove`, backed by
`~/.base-studio-code/roles.db`.

Two non-negotiables carried over from `roleModel.ts`:

- **`clampTiers` applies to store writes too.** A stored role may narrow a packaged one; it may never
  widen it. A *custom* role is minted at or below the ceiling of the role it derives from.
- **`floorLists` (harvest roots) stays a union.** A stored copy may add a harvest root, never revoke one.

This slots cleanly into `epic-command-surfaces-are-nodes` — it is one more catalog-driven CLI, and the
architect session needs `bsc role` added to its `restrictedAllow` to author roles at all.

---

## 8. Slices

One item = one ref = one branch = one worktree, in order:

1. **`teams-inspector-is-a-persistent-entity-inspector`** — widen `Selection` to the five-kind union,
   rebuild `teams-inspector` with the header/sections/footer skeleton, add the team-summary empty state.
   Position + relationship behaviour unchanged. No new stores. *Teams-page-internal; nothing else moves.*
2. **`personas-become-a-first-class-library-on-teams`** — the rail's Personas section, the persona
   inspector, **Used by**, unplaced flagging; de-inline `PersonaEditor` from the position inspector;
   delete `PersonasPanel`.
3. **`bsc-role-the-capability-store`** — the Rust half: `roles.db` + `bsc role` + the ceiling clamp on
   writes + reconcile against the packaged table. No UI.
4. **`roles-are-managed-on-teams-and-profiles-are-derived`** — the Roles rail section + role inspector;
   derive the tool posture; retire `AgentProfile`, `agentProfiles`, `roleProfileId`'s map and
   `AgentRolesCard`; migrate `paneProfiles` → `paneRoles`.
5. **`the-security-workspace-dissolves`** — Assignments/Activity/Flow → Glance; drop `security` from
   `WORKSPACES`; persist-migrate a stored `activeWorkspace: "security"`.

Slices 1–2 are shippable on their own and already pay for themselves (the panel gets better, personas
become reachable). 3–5 are the vocabulary collapse and should not be split further.

---

## 9. Risks that have already bitten this repo

- **This UI is records, not files.** `teamspage`, `teams-inspector`, `personaeditor` are all seed-backed
  records (`builtin: true`, `seedHash` present, source files retired). Every change lands in
  `src-tauri/data/components/app/features/{teams,personas}/*.json` **and** the store, or a fresh install
  and this machine render different things — `4218-teams-and-designs-carry-harvested-store-records` is
  the write-up of exactly that failure, and it names the teams records specifically. They are stamped
  correctly *today*; re-check before the first write.
- **`bsc ui` writes hit the RUNNING app.** A worktree script has broken a live page this way before.
- **Retiring a profile must not widen a studio session.** `buildSessionSettings` *adds* a profile's
  `allowedCommands` to a role's `restrictedAllow`; `roleProfile.ts` warns in prose that assigning a
  profile to `designer`/`architect`/`librarian` would widen a session confined to one store CLI. The
  derivation must reproduce "no profile" for those roles, not "the pf_review profile".
- **`paneProfiles` → `paneRoles` needs a persist migration.** `paneRoles` already exists, which makes it
  tractable, but a pane carrying a profile and no role must resolve deterministically.
- **A widening UI is an escalation path.** Restated because it is the one thing here that is a security
  bug rather than a design regret.

---

## 10. The one open question

**Do custom roles exist at all?**

Everything above works either way, and it changes slice 3 materially:

- **Yes** — `bsc role` is a full store; users mint roles at-or-below a packaged ceiling; the Roles
  section has a `+ new`. Maximum flexibility, and it is the honest replacement for today's "custom
  profiles" (which users *can* create).
- **No** — the 17 packaged roles are the closed vocabulary; `bsc role` only ever *narrows* an existing
  one, and personas are the sole authoring unit. Much smaller surface, no minting rules, no ceiling
  arithmetic — and arguably right, because a role is an *enforcement* primitive that the hooks, the
  sandbox and the launch path all reason about, while a persona is free-form by design.

I lean **no** — closed role vocabulary, personas as the only authored identity — but this is a product
call about how much rope a user gets, not one I should make silently.
