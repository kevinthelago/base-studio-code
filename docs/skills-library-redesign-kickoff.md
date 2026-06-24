# Claude Design kickoff — Skills library at scale + per-session skill assignment

Paste this whole brief into a Claude Design session. Deliverable: functionless React **JSX skeletons** (Babel-standalone style, no real logic) for **(A)** a redesigned **Skills library** that stays fast and legible with **hundreds–thousands** of skills, and **(B)** a new **per-session skill assignment** surface (add/remove skills for one specific agent session), using the exact design tokens below — so they drop into base-studio-code with minimal rewiring. Companion screen this replaces/extends: the current `src/screens/skills/index.tsx`.

---

## 1. What you're designing

Two related surfaces that share one visual vocabulary:

1. **Skills library (redesign for scale).** Today the library is a two-column card grid with a single kind filter — great at ~15 skills, unusable at 500. Redesign it to **search, filter, sort, scan, and bulk-act on hundreds–thousands of skills** without losing the at-a-glance quality (kind, source, scope, telemetry) of the current cards. The existing edit **drawer** and **Runs/Catalog** tabs stay; you're reworking the **Library** view's browse/navigate layer and adding bulk operations.
2. **Per-session skill assignment (new).** A focused surface to choose **which skills a single session can invoke** — add or remove specific skills for *this* agent session, starting from what it would inherit. Reached from a session (a console pane's menu, a fleet worker, the planner). There is no UI for this today; design it from scratch.

Both must read as the same product — same cards, same chips, same density.

## 2. Product context (so it fits)

- **base-studio-code** is a desktop app (Tauri + React, dark-first) for running many Claude coding agents in parallel across repos. A **skill** is a reusable capability bundle — a named procedure (a prompt + bundled tools + permission-profile guardrails) any agent can invoke. Each enabled, in-scope skill is written into a launched session as a Claude Code **`.claude/skills/<slug>/SKILL.md`** file.
- A **session** is one agent: a console pane, a fleet **worker** (scoped to a repo + an issue), the **planner**, or a per-repo **triage**. Sessions run under a least-privilege **role** + **permission profile**.
- **Why scale matters now:** skills come from a packaged set, a **catalog**, **imports** (JSON), shared **blueprints**, and the **planner authoring them mid-session**. A mature install accumulates hundreds. The library is the place a user curates that mass; the per-session surface is where they aim a precise subset at one agent.
- Keep it **dense, technical, calm** — a power-user management surface, not marketing. Pulse/animation only for genuinely live state (a skill being invoked right now).

## 3. The data shapes (design against these exactly)

```ts
type SkillKind   = "workflow" | "scaffold" | "codemod" | "review" | "docs";
type SkillSource = "first-party" | "team" | "imported" | "community";
type SkillProfile = "build" | "review" | "docs" | "auto" | "sandbox"; // profiles allowed to invoke it

interface SkillDef {
  id: string;
  name: string;            // mono; slugs to the .claude/skills/<slug> dir
  kind: SkillKind;         // card glyph + accent color
  source: SkillSource;     // source tag
  desc: string;            // one line — card subtitle + SKILL.md frontmatter description
  prompt: string;          // the reusable procedure (SKILL.md body) — edited in the drawer
  tools: string[];         // bundled tool names → kbd chips
  profiles: SkillProfile[];// which permission profiles may invoke it
  projects: string[];      // [] = global (every project); else the project ids it's scoped to
  enabled: boolean;        // disabled skills are never written into a session
  pinned: boolean;         // pinned = auto-available to the fleet
  packaged?: boolean;      // code-owned (seeded); user/imported skills are not
  // live telemetry (from the skill-usage log; 0 until used)
  invocations: number;     // fleet-wide, last 7d
  success: number;         // success rate 0–100
  avgTokensK: number;
  trend: number[];         // 7-point sparkline
}
```

**Kind glyph/color** (match): `workflow ⌁` accent · `scaffold ▤` info · `codemod ⟐` violet · `review ✓` success · `docs ¶` warm-grey. **Source tags:** `first-party` (plain), `team` (info), `imported` (amber), `community` (plain). **Profiles** render as tiny colored dots + a mono label.

**Resolution rule (drives the per-session surface):** a skill *applies* to a session when `enabled && (projects.length === 0 || projects.includes(thisProject))`. **Pinned** skills are additionally auto-offered to the fleet. The per-session surface lets the user **override** that resolved set for one session — explicitly add a skill that wouldn't apply, or remove one that would.

## 4. Surface A — the Skills library at scale

The job: make 500+ skills **findable and curatable**. Design the Library view as a **command bar + a dense, virtualizable list** (with an optional compact-card density), plus **bulk actions** and **multi-facet filtering**. Keep the editor drawer and the KPI digest, but make the digest collapsible so it never costs scroll at scale.

**4.1 Command bar (sticky, top of the Library view)**
- **Search** — matches name + description + tools (+ source). The primary navigation tool; make it prominent. Show a live result count ("142 of 873").
- **Sort** — name (A–Z), most-invoked, success rate, recently used, recently added.
- **Density toggle** — **List** (default at scale: one skill per row, ~32–36px) ↔ **Cards** (the current rich 2-up, for smaller sets / browsing). Use the segmented `Seg` pattern.
- **Bulk affordance** — a "select" mode (row checkboxes) that reveals a bulk action bar.

**4.2 Facet filters (a left filter column OR a row of multi-select chips — your call, but multi-facet)**
Faceted, not single-axis. Each facet shows counts and is multi-select:
- **Kind** (workflow/scaffold/codemod/review/docs)
- **Source** (first-party/team/imported/community)
- **Scope** (global · project-scoped · this-project)
- **Status** (enabled · disabled · pinned)
- **Usage** (used 7d · never run)
Active filters appear as removable chips with a "clear all". The combination of search + facets is how a user gets from 873 → the 6 they care about.

**4.3 The dense list row (the scale workhorse)**
One skill per row, scannable, no wasted height. Each row: kind glyph · **name** (mono) · source tag · a few tool chips (truncate with "+N") · scope marker (global / project pill) · pinned ★ (toggle) · enabled toggle · invocations + success meter + sparkline · row click → opens the editor drawer. It should look right whether there are 12 rows or 1,200 (assume the list is virtualized; design the row, the header, and the sticky column alignment). Include a grouped variant (group-by **kind** or **source**) with collapsible section headers carrying counts.

**4.4 Bulk actions** (shown when ≥1 row is selected): enable / disable · pin / unpin · set scope (global ↔ pick projects) · delete · export selected. A select-all-in-filter affordance ("select all 142 matching").

**4.5 Keep + adapt**
- The **edit/new drawer** (right slide-over) is good — keep it as-is for editing a single skill (name, enabled/pinned, kind, source, description, prompt textarea, bundled tools, allowed profiles, project assignment).
- The **KPI digest + leaderboard** stay but **collapse** into a compact one-line summary by default at scale (expandable), so browsing 800 skills isn't gated behind a tall header.
- **Empty / loading / no-match** states for the list.

## 5. Surface B — per-session skill assignment (new)

A focused panel/modal: **"Skills for this session."** Opened for one specific session (show its identity in the header — e.g. `worker · payments-api · stream:checkout`, or `planner`, or `console · myrepo`). The user picks exactly which skills this session can invoke.

Design around the **inherit-then-override** model:
- Each skill row shows its **effective state for this session** and **why**: `on · global`, `on · pinned`, `on · project-scoped`, `off · out of scope`, or an explicit `added` / `removed` (a user override for this session, visually distinct — e.g. an accent ring or an "override" pill).
- A per-row control toggles **include / exclude for this session**, layering an override on top of the inherited state. A "reset to inherited" clears a row's override; a header "reset all overrides" clears them.
- Same **search + facets** as the library (this list is just as long), plus a quick filter: **Assigned to this session** (the effective-on set) vs **All skills**.
- A header summary: "**23 skills** available to this session · 3 overrides". 
- Read-only context note: these are written as that session's `.claude/skills/<slug>/SKILL.md` on its next launch/relaunch.

This surface reuses the library's row + chips; it adds the **effective-state column** and the **override control**. Design the panel and the row in both states (inherited, overridden).

## 6. Placement / chrome

- **Library** is a full rail screen with the existing **TabBar** (Library · Runs · Catalog) — design only the **Library** tab body (command bar + facets + list/cards + bulk bar + drawer). Show the tab bar lightly for context.
- **Per-session** is a slide-over drawer or centered modal launched from a session (a pane menu item "Manage skills…", or the planner's Skills stage). Design it as an overlay with a scrim, matching the existing drawer chrome.

## 7. Design system — match these EXACTLY

Dark is primary. Tokens (CSS custom properties — use them, don't hardcode hex):

```css
:root{
  --bg-canvas:oklch(0.13 0.005 250); --bg-panel:oklch(0.17 0.005 250);
  --bg-elev:oklch(0.21 0.006 250);   --bg-elev2:oklch(0.26 0.006 250);
  --border:oklch(0.30 0.006 250);    --border-soft:oklch(0.24 0.006 250);
  --fg:oklch(0.94 0.004 250); --fg-muted:oklch(0.66 0.008 250); --fg-dim:oklch(0.46 0.008 250);
  --accent:oklch(0.80 0.14 70); --accent-dim:oklch(0.55 0.10 70);
  --success:oklch(0.74 0.13 145); --info:oklch(0.72 0.10 230);
  --violet:oklch(0.72 0.12 300); --danger:oklch(0.68 0.18 25);
  --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  --sans:"Inter",-apple-system,"Segoe UI",system-ui,sans-serif;
  --r-sm:4px; --r-md:6px; --r-lg:10px;
}
```

Conventions (match so it's indistinguishable from the rest of the app):
- **Type:** titles/labels in `--sans`; skill names, tool names, counts, slugs, "code-ish" text in `--mono`. Section headers small (10px) mono, uppercase, `letter-spacing:.08em`, `--fg-dim`.
- **Cards / rows:** `background:var(--bg-panel)`, `1px solid var(--border-soft)`, `border-radius:var(--r-lg)`. Dense list rows alternate `--bg-elev` / `--bg-panel`; sticky list header on `--bg-panel`.
- **Kind glyph tile:** rounded square, `color-mix(in oklch, <kindColor> 22%, var(--bg-elev))` bg + tinted border, the glyph in the kind color.
- **Pills/tags:** `border-radius:99px`, mono ~9.5px, tinted via `color-mix(in oklch, <hue>, transparent 88–90%)` bg + `…transparent 70–78%` border. `--accent`=attention/inferred, `--info`=team/scope, `--violet`=codemod, `--success`=enabled/ok/high-success, `--danger`=disabled/low-success, `--fg-dim`=inert.
- **Tool chips:** the `kbd` style — tiny mono, `--bg-elev2`, soft border.
- **Toggles:** the existing pill `toggle` (on = `--accent`). **Pin** = ★ (accent when pinned, `--fg-dim` otherwise).
- **Success meter:** a thin `meter` bar + mono %; color by threshold (≥95 `--success`, ≥85 `--accent`, else `--danger`). Sparkline = a small inline `Spark`.
- **Segmented controls (`Seg`):** bordered row, active segment on `--bg-elev2` + `--fg`, others transparent + `--fg-dim`.
- **Override (per-session):** an explicit override row carries an accent ring / `override` pill so it's distinct from an inherited state.
- No drop shadows except menus/modals/drawers. Pulse/animation only for a live invocation.
- Fonts via Google Fonts: `Inter` (400–700) + `JetBrains Mono` (400–600).

## 8. Sample data (use realistic data + ENOUGH of it to prove scale)

Generate **~120–300 skills** so the list, search, facets, virtualization feel, and bulk bar are real — don't ship 8. Mix all kinds/sources; vary scope (most global, some project-scoped), enabled/pinned, and telemetry (many never-run, a few heavy hitters). Realistic names, e.g.:
- `Open a clean PR` (workflow · first-party · pinned · 412×, 97%)
- `Scaffold a Tauri command` (scaffold · first-party · 88×, 99%)
- `SOC 2 evidence checklist` (review · team · project-scoped · 24×, 91%)
- `Rename a symbol safely` (codemod · first-party · 0×, never run)
- `GDPR data-handling review` (review · community · imported · 12×, 83%)
- `Generate API reference docs` (docs · team · 31×, 95%)
- …plus ~110+ more spanning the kinds/sources so facet counts and search are meaningful.

For **Surface B**, pick one session (e.g. `worker · payments-api · stream:checkout`) and show a realistic effective set: ~20 inherited-on (global + pinned + project-scoped), the rest off, and **2–3 explicit overrides** (one added that's normally out of scope, one removed that's normally on).

## 9. Deliverable

Functionless React JSX skeleton(s) (Babel-standalone style, no real logic; a single file is fine) using the tokens above:
- **Surface A — Library:** the sticky command bar (search · sort · density · select), the facet filters with counts + active-filter chips, the dense **list** row + sticky header (the scale default) AND the compact **card** density, a grouped variant with collapsible headers, the bulk-action bar (selection mode), the collapsed KPI digest, and the empty/no-match states. Reuse the existing edit drawer (show it open on one skill).
- **Surface B — Per-session:** the overlay panel with the session-identity header, the summary line, search + the "assigned ↔ all" filter, and the row in its states (`on · global`, `on · pinned`, `on · project-scoped`, `off · out of scope`, `added`, `removed`) with the include/exclude + reset controls.
- Drive both from simple `view` / `density` / `mode` props or stacked sections so every state is visible without real state. Hardcode the sample data inline.

Goal: drop-in skeletons that look indistinguishable from base-studio-code and make **hundreds of skills** effortless to browse, filter, curate, and aim at a single session.
