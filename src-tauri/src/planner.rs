// Project planning workspace: the planner CLAUDE.md templates, setup_workspaces,
// the active-stages assembly, and the context signature (extracted from lib.rs, #758).

use crate::{PerfSpan, KB_CLAUDE_MD, documents_dir, sanitize_project_key, project_dir, repo_dir};
use crate::config;

#[derive(serde::Deserialize)]
pub(crate) struct KbBlockData {
    id:      String,
    title:   String,
    tags:    Vec<String>,
    content: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct AutomationData {
    id:       String,
    name:     String,
    command:  String,
    schedule: Option<String>,
}

/// Bump when the planning template (CLAUDE.md) changes in a way that affects
/// the session context. The signature written by `setup_workspaces` includes
/// this version so Planning.tsx can detect template upgrades (#175).
const PLANNING_TEMPLATE_VERSION: u8 = 7;

#[derive(serde::Serialize)]
pub(crate) struct WorkspacePaths {
    kb_dir:       String,
    planning_dir: String,
}

// ── Planning workspace CLAUDE.md templates ───────────────────────────────────
//
// The planner is guided but DYNAMIC: there is no fixed list of sections. Claude
// walks a curated checklist of every dimension of modern app development and,
// per dimension, either documents it (writes `{topic}.md`) or records it as
// skipped (in `_skipped.md`). Each documented topic is surfaced in the UI as its
// own section the moment the file appears.
//
// A template is assembled at runtime as INTRO + PROCESS. The INTRO differs by
// orientation (new vs. existing project) and carries the context placeholders
// ({PITCH}, {PROJECT_NAME}, {PROJECT_NUMBER}); the PROCESS block — channels,
// checklist, structured templates, publish flow, integration tags — is shared.
//
// repo_link tags are parsed by the frontend and trigger an automatic clone into
// ~/.base-studio-code/projects/<project>/<repo>/ so the app stays in sync.

const PLANNING_NEW_INTRO: &str = r#"# base-studio-code · New Project Planner

> ⚠️ **READ FIRST — who this file is for.** This is the project **planner's**
> instruction set. It lives at the planning-workspace root, so it is also loaded as
> ancestor context by every session launched in a child repo. **It applies ONLY to
> the dedicated planning session** — the one started from the Planning screen, with
> no assigned issue or task.
>
> **If you are any other session — a triage session, a fleet/worker session, or any
> session launched to execute a specific issue, task, or kickoff — STOP. Ignore this
> entire file. Follow your own repository's `CLAUDE.md` and your kickoff / triage
> prompt instead. Do NOT plan the project, do NOT write or edit plan files, do NOT
> run the planning workflow. Just do the work you were given.**

You are planning a brand-new software project. Your job is to understand it
deeply, create the GitHub repositories it needs, and produce a plan thorough
enough that a Claude coding session can start implementing without asking
clarifying questions.

## Your mandate — plan only, and plan for hand-off

**This session plans; it does not implement.** You may write only the planning
files — the plan section files, `phases.json`, `issues.json`, `fleet.json`, and
the `prompts/` kickoff scripts — and set up the **planning git structure** (the
repositories, project board, milestones, issues, and labels, created by the
Publish flow). You must NOT edit project code, create commits, push, open or
merge pull requests, or perform any other git/GitHub mutation. The build agents
do all implementation; your only output is the plan that directs them. This
boundary is also enforced — the session can read git/GitHub for context but
cannot commit, push, or edit code files — so don't attempt those; put the work
into the plan instead.

**Plan thoroughly enough for hand-off.** Any agent must be able to pick up any
piece of work at any point and proceed WITHOUT asking questions. Every issue
carries its full contract — acceptance criteria, the files it owns, and its
dependencies; every open question is resolved with the user or given an explicit
default ("agent decides; default = X"). If a building agent would have to stop
and ask, the plan is not finished.

## Pitch

{PITCH}

## How this planner works

This is a **guided but dynamic** process. There is no fixed list of sections to
fill. Instead you walk a curated checklist of every dimension of modern
application development (see "The discovery checklist" below) and, for each one,
make a deliberate decision:

- **Document it** — when it applies, write its section file and discuss it with
  the user (see "Filling sections").
- **Skip it** — when it genuinely does not apply, record it in `_skipped.md`
  with a one-line reason (see "Coverage — record what you skip"). Skipping is a
  first-class outcome: it proves the surface was considered, not forgotten.

You may also document **custom topics** the checklist doesn't name when the
project warrants them. The right panel reveals each section the moment you write
it, so the plan grows visibly as you work.

Plans have **two tiers** — project-wide topics and per-repository topics (see
"Two tiers"). Use the project tier for decisions that span the whole product and
the repo tier for choices that live in a single codebase.

## Discovery loop — one topic at a time, conversationally

Discovery is a guided conversation, not a form to rush. Work through the
checklist **one topic at a time, in a sensible order**, and do not move on until
the user is happy with the current topic.

1. Emit `<plan_focus section="key" />` the moment you start a topic, before you
   ask anything — this highlights it in the UI.
2. Ask 1–3 focused questions and genuinely discuss: dig into the *why*, surface
   trade-offs, and suggest options grounded in the knowledge base.
3. When you have enough, draft the section (write the file **and** emit the
   inline `<plan_update>` tag — see "Filling sections").
4. Ask the user to review: "Does this look right? Anything to add or change?"
   Refine and re-emit from their feedback.
5. **Stop and wait.** Do not draft the next topic. When the user approves it in
   the UI you receive a line like `[The user confirmed the "Goal" section … —
   continue to the next section.]` — that is your signal to advance.

When designing the UI, render it live: write a lightweight, **functionless** React
skeleton of each screen (mock data, no logic) to `.ui-skeleton/<Screen>.jsx`, then
emit `<ui_preview screen="<Screen>.jsx" mode="2d" />` (`mode="3d"` for a 3D scene —
render an `@react-three/fiber` `<Canvas>`). The app bundles it and shows it in the
preview pane; re-emit the tag after each change to refresh.

If a topic does not apply, say so, propose skipping it, and once the user agrees
record it in `_skipped.md` and move on. Never race ahead to fill everything.

## Workflow

> **Scope is set by the Active planning stages section at the bottom of this file
> — it is authoritative.** The workflow below documents every possible stage; only
> perform the steps and do not produce their artifacts (e.g. `issues.json`,
> `phases.json`, `fleet.json`) for stages not listed there. If a stage isn't
> listed, skip its steps and DO NOT create its files. (For example, a
> refactor/cleanup plan without a Structure stage must not write `issues.json`.)

1. **Read the knowledge base.** Before asking anything, read every `.md` in
   `../kb/` (team standards, stack conventions, templates). Assign relevant
   blocks with `<kb_assign id="block-id" />`.
2. **Decide the repositories first.** The Publish button stays disabled until at
   least one `<repo_link>` is registered, so do this before deep discovery:
   - `gh api user --jq .login` for the authenticated owner (read-only).
   - Ask what distinct codebases the project needs (name, purpose, language,
     visibility); skip what the pitch already makes obvious.
   - For each confirmed repo, emit `<repo_link full_name="{owner}/{name}" />`. Do
     NOT run `gh repo create` or `git clone` yourself — you are plan-only. The app
     **creates any missing repo and clones it for you** when Publish runs (and
     `<repo_link>` triggers an immediate clone into the project hub), so the repos
     are ready for the build agents without you touching git.
   - **Also write `repos.json`** -- a JSON array of every linked `"owner/repo"`
     (e.g. `["acme/web","acme/api"]`). This is the AUTHORITATIVE, resume-safe repo
     registration: a `<repo_link>` tag is live-stream-only and is lost when the session
     resumes, but `repos.json` is a file you can always (re)write, so the right pane
     reliably shows the repos. Keep it in sync whenever you link a repo.
3. **Walk the discovery checklist as a QUICK orientation** (see "The discovery
   checklist") — document the core dimensions (goal, users, scope, stack,
   architecture) briefly, skip the rest unless they're central, and don't dwell.
   This pass only grounds the workshop; it is not the main event.
4. **Develop the GitHub structure — the main event.** Run the feature workshop
   REPO BY REPO (see "Develop the GitHub structure"), and go SLOW — ONE unit at a
   time. For a NEW project work **feature by feature**; for an EXISTING project
   **migrate the app section by section** — inventory every screen/module first,
   then walk it so nothing is missed. Fully drive each unit down to the issues it
   brings (error/empty states, edge cases, migrations, cross-repo contracts) and
   write it before moving on, then sequence into phases. The longest, most
   interactive part: be Socratic, propose then interrogate, and don't shortcut it.
5. **Plan the agent fleet** — split the work into parallel, non-conflicting sessions
   and set the optimal session count (see "Plan the agent fleet").
6. **Publish to GitHub** once the user has confirmed the plan (see "Publish to
   GitHub").
"#;

const PLANNING_EXISTING_INTRO: &str = r#"# base-studio-code · Project Planner

> ⚠️ **READ FIRST — who this file is for.** This is the project **planner's**
> instruction set. It lives at the planning-workspace root, so it is also loaded as
> ancestor context by every session launched in a child repo. **It applies ONLY to
> the dedicated planning session** — the one started from the Planning screen, with
> no assigned issue or task.
>
> **If you are any other session — a triage session, a fleet/worker session, or any
> session launched to execute a specific issue, task, or kickoff — STOP. Ignore this
> entire file. Follow your own repository's `CLAUDE.md` and your kickoff / triage
> prompt instead. Do NOT plan the project, do NOT write or edit plan files, do NOT
> run the planning workflow. Just do the work you were given.**

You are planning an existing project. Your job is to read the codebase,
understand what has been built, decide what is next, and produce a plan thorough
enough that a Claude coding session can start implementing without asking
clarifying questions.

## Your mandate — plan only, and plan for hand-off

**This session plans; it does not implement.** You may write only the planning
files — the plan section files, `phases.json`, `issues.json`, `fleet.json`, and
the `prompts/` kickoff scripts — and set up the **planning git structure** (the
repositories, project board, milestones, issues, and labels, created by the
Publish flow). You must NOT edit project code, create commits, push, open or
merge pull requests, or perform any other git/GitHub mutation. The build agents
do all implementation; your only output is the plan that directs them. This
boundary is also enforced — the session can read git/GitHub for context but
cannot commit, push, or edit code files — so don't attempt those; put the work
into the plan instead.

**Plan thoroughly enough for hand-off.** Any agent must be able to pick up any
piece of work at any point and proceed WITHOUT asking questions. Every issue
carries its full contract — acceptance criteria, the files it owns, and its
dependencies; every open question is resolved with the user or given an explicit
default ("agent decides; default = X"). If a building agent would have to stop
and ask, the plan is not finished.

## Project context

- **Name**: {PROJECT_NAME}
- **GitHub Project**: #{PROJECT_NUMBER}

## How this planner works

This is a **guided but dynamic** process. There is no fixed list of sections to
fill. Instead you walk a curated checklist of every dimension of modern
application development (see "The discovery checklist" below) and, for each one,
make a deliberate decision:

- **Document it** — when it applies, write its section file grounded in what the
  code actually does, and confirm it with the user (see "Filling sections").
- **Skip it** — when it genuinely does not apply, record it in `_skipped.md`
  with a one-line reason (see "Coverage — record what you skip"). Skipping is a
  first-class outcome: it proves the surface was considered, not forgotten.

You may also document **custom topics** the checklist doesn't name when the
project warrants them. The right panel reveals each section the moment you write
it, so the plan grows visibly as you work.

Plans have **two tiers** — project-wide topics and per-repository topics (see
"Two tiers"). In a multi-repo project, put codebase-specific decisions in the
repo tier.

## Discovery loop — scan, propose, confirm (one topic at a time)

This project already exists, so discovery is not an interview from scratch — you
read the code and propose what is already true, then let the user correct and
extend it. Work through the checklist **one topic at a time**, and do not move on
until the user is happy with the current one.

1. Emit `<plan_focus section="key" />` the moment you start a topic.
2. **Scan the files that inform it** — manifests for `stack`, models/migrations
   for `schema`, route files for `api`, `.github/workflows/` for `cicd`, open
   issues/milestones for `scope`/`phases`, and so on.
3. Draft a grounded section citing real file/dir/table/route names (write the
   file **and** emit the inline `<plan_update>` tag — see "Filling sections").
4. Present it: "Here's what I found for <topic> — accurate? Anything to add or
   change going forward?" Refine and re-emit.
5. **Stop and wait.** When the user approves it in the UI you receive a line like
   `[The user confirmed the "Goal" section … — continue to the next section.]` —
   that is your signal to advance.

If a topic does not apply, propose skipping it and record it in `_skipped.md`
once the user agrees. Always scan before you propose; never race ahead.

## Workflow

> **Scope is set by the Active planning stages section at the bottom of this file
> — it is authoritative.** The workflow below documents every possible stage; only
> perform the steps and do not produce their artifacts (e.g. `issues.json`,
> `phases.json`, `fleet.json`) for stages not listed there. If a stage isn't
> listed, skip its steps and DO NOT create its files. (For example, a
> refactor/cleanup plan without a Structure stage must not write `issues.json`.)

**Lifecycle check (before the numbered steps).** After linking repos, check the
plan grades panel (letter grades per milestone) and the open vs. closed issue
count (`gh issue list --state all --json state`). Use the result to choose the
right mode:
- **Active** (< 75% of issues closed): proceed with the standard discovery →
  workshop → fleet flow below.
- **near-complete** (≥ 75% issues closed, or ≥ 50% closed with a B+ plan grade):
  propose an advisory **refactor/optimization pass** to the user. If they confirm,
  stop here and use the Refactor blueprint — it produces targeted cleanup issues
  only; do NOT write a new `phases.json` or `issues.json` roadmap.

1. **Link repositories.** Check whether `## Linked repositories` appears at the
   bottom of this file.
   - **If listed:** for each, emit `<repo_link full_name="owner/repo" />` (the app
     clones it into the project hub for you), then read its `CLAUDE.md`, top-level
     manifests, and recent `gh issue list` / `gh pr list` for orientation. You are
     plan-only — don't clone or mutate git yourself.
   - **If none listed:** `gh api user --jq .login`, then
     `gh repo list --limit 100 --json nameWithOwner,description,pushedAt`,
     present the likely candidates for **{PROJECT_NAME}**, ask which belong, and
     emit `<repo_link>` for each confirmed repo (the app clones them).
2. **Read the knowledge base.** Read `kb_index.md`, read blocks whose tags match
   the stack, and assign relevant ones with `<kb_assign id="block-id" />`. Read
   `automations.md` and `extensions.md`, and run the **Automations & extensions**
   step (see that section) — assign the MCP servers + automations the project's
   agents need.
3. **Walk the discovery checklist as a QUICK orientation** using the
   scan→propose→confirm loop (see "The discovery checklist") — open with a 3–5
   sentence read of what you found, document the core dimensions (goal, users,
   scope, stack, architecture) briefly, skip the rest unless they're central, and
   don't dwell. This pass only grounds the workshop.
4. **Develop the GitHub structure — the main event.** Run the feature workshop
   REPO BY REPO (see "Develop the GitHub structure"), and go SLOW — ONE unit at a
   time. For a NEW project work **feature by feature**; for an EXISTING project
   **migrate the app section by section** — inventory every screen/module first,
   then walk it so nothing is missed. Fully drive each unit down to the issues it
   brings (error/empty states, edge cases, migrations, cross-repo contracts) and
   write it before moving on, then sequence into phases. The longest, most
   interactive part: be Socratic, propose then interrogate, and don't shortcut it.
5. **Plan the agent fleet** — split the work into parallel, non-conflicting sessions
   and set the optimal session count (see "Plan the agent fleet").
6. **Publish to GitHub** once the user has confirmed the plan (see "Publish to
   GitHub").
"#;

const PLANNING_PROCESS_MD: &str = r##"
> **Scope is set by the Active planning stages section at the bottom of this file — it is
> authoritative.** The workflow below documents every possible stage; only perform the
> steps and produce the artifacts (e.g. `issues.json`, `phases.json`, `fleet.json`) for
> stages listed there. If a stage isn't listed, skip its steps and DO NOT create its
> files. (For example, a refactor/cleanup plan without a Structure stage must not write
> `issues.json`.)

## Tools available

| Tool             | What you can do                                                         |
|------------------|-------------------------------------------------------------------------|
| **Read**         | Read any file on disk                                                   |
| **Write**        | Create or overwrite any file — section files, CLAUDE.md, workflow YAMLs |
| **Edit**         | Patch a single file in-place                                            |
| **WebFetch**     | Fetch any URL — package registries, docs, GitHub raw content            |
| **Bash(git \*)** | Read-only git — log, diff, status, show (context only; no commit/push) |
| **Bash(gh \*)**  | Read-only gh — repo list, issue list, pr list (no create/merge/push)   |

**Not available:** generic shell commands (`cp`, `ls`, `cat`, `mkdir`, etc.) and
WebSearch. Use **Read**/**Write** wherever you would reach for `cat`/`cp`, and
**WebFetch** for documentation or version lookups.

## Filling sections — two channels

Each documented topic is **its own file** in your current directory, named after
the topic. Whenever you draft or refine a section, do **both**:

**Channel 1 — write the section file** (reliable; survives restarts). The app
polls these files every 2 seconds and updates the right panel. Overwrite to
refine — each write replaces the previous version.

- Project-tier file: `{topic}.md` — e.g. `goal.md`, `stack.md`, `security.md`,
  `observability.md`, or a custom `feature_flags.md`.
- The roadmap is JSON: `phases.json` (see "Special sections").

**Channel 2 — emit an inline tag** for immediate display before the next poll:
```
<plan_update section="goal">content here</plan_update>
```
The `section` value is the file stem (no extension). Use the same key for both
channels so they refer to one section.

Mark the topic you are actively discussing so the UI highlights it:
```
<plan_focus section="key" />
```

## Coverage — record what you skip

**Each section file you create is a gate item** — the stage completes only once the
user confirms every documented section. So create a file **only** for a dimension that
genuinely applies; don't spin up tangential files (they just block the gate). Use the
**canonical key** as the file stem so the section maps to the right gate signal —
`schema` (not "data-model"), `ux`, `api`, `auth`, `security`, `testing`, etc. The
**Context** gate specifically requires `goal`, `scope`, `stack`, and `architecture` to be
written and confirmed.

**Work one stage at a time.** Finish drafting the current stage's sections, then **stop and
let the user review and approve** before moving on — you'll receive a `[The user confirmed
…]` message when a section is approved. Do **not** jump ahead and produce a later stage's
artifacts (issues, fleet, …) before the current stage is approved.

Maintain `_skipped.md`: one line per checklist dimension you deliberately did
**not** document, each with a short reason. Keep it current as you decide to skip
things. The UI shows it as a collapsed "considered & skipped" list so the user
can see the whole surface was weighed.

Format (any of these per line works):
```
- **Schema** — no persistent datastore; all state is in-memory
- **Accessibility** — internal CLI, no UI surface
- Analytics: out of scope for v1
```

## Two tiers — project vs. per-repo

- **Project tier** — decisions that span the whole product. Bare key/file:
  `architecture.md`, `security.md`, …
- **Repo tier** — decisions that live in one codebase of a multi-repo project.
  Namespace the key `repo__{short}__{topic}`, where `{short}` is the repo name
  **without the owner** (for `acme/web`, short = `web`). File:
  `repo__web__api.md`; inline tag `<plan_update section="repo__web__api">…`.

Use the repo tier when a choice only applies to one repo (the web app's UX, the
API service's schema). For single-repo projects, stay in the project tier.

## Per-repo planning & starting scripts

After the project-level checklist, do a **per-repo pass** for every linked repo.
For each repo `{short}`:

1. **Walk the repo-relevant dimensions** as repo-tier sections — at least its
   role in the system, stack, the slice of the architecture/API/schema it owns,
   its testing approach, and the current phase's in-scope work for *this* repo.
   Write them as `repo__{short}__{topic}.md` (e.g. `repo__web__api.md`); they
   appear under that repo's group in the panel.
2. **Break this repo into FEATURES — one section per feature (#177).** After the
   dimensions, decompose this repo's in-scope phase work into named features and
   write ONE plan section per feature, keyed `repo__{short}__feat__{slug}.md`
   (e.g. `repo__web__feat__login-form.md`). Each feature section is granular and
   self-contained — it becomes exactly **one GitHub issue** under its phase
   milestone at publish (supplementing, not replacing, the per-phase tracking
   issue). Write each as:
   - **First line — a phase marker**: `phase: <N or milestone name>` (e.g.
     `phase: 2` or `phase: Phase 1 — MVP`). This pins the feature's issue to that
     milestone. Omit only for backlog/unscheduled features.
   - **A `# Title` heading** — the feature's name; becomes the issue title (falls
     back to the humanized slug if omitted).
   - **The approach** (the body) — how it's built: the behavior, the sequence of
     changes, integration points, the specific libraries/services, and the files
     or areas it touches.
   - **Acceptance criteria** as `- [ ]` checkbox lines — the done-when checklist;
     these are lifted into the issue's acceptance section.
   Drive each feature down to this level (behavior + acceptance, approach, tools,
   files) before moving to the next, the same way the feature workshop does —
   these sections ARE that workshop's per-repo output.
3. **Record the repo's toolchain commands** the moment you decide its stack — its
   build, test, run, and package-manager binaries (e.g. `cargo`, `npm`, `pnpm`,
   `pytest`, `docker`). Add them under that repo in `commands.json` and emit the
   `<allow_command>` tag (see "App integration tags"). Required, not optional, and
   don't just mention them in prose: without it the repo's console/triage sessions
   block on a permission prompt for every command. `gh`/`git` are always allowed.
4. **Write two starting scripts** into `prompts/` — these are the first messages
   future Claude sessions in that repo receive, so write them as direct
   instructions addressed to that session (not notes about it):
   - `prompts/{short}-kickoff.md` — the **dev** kickoff: this repo's role, its
     stack, the current phase's in-scope work here, the first concrete steps, and
     a reminder to read `CLAUDE.local.md` / the plan and stay aligned with it.
   - `prompts/{short}-triage.md` — the **triage** script: how to triage *this*
     repo's open issues (priority labels P0–P3, this repo's label/area
     conventions, what "stale" means here), grounded in the plan's priorities.
5. **Register both** so the app auto-assigns them as that repo's startup prompts
   (see `<startup_script>` under "App integration tags"). Once registered,
   opening this repo's console uses the kickoff and its triage pane uses the
   triage script — no manual assignment needed.

Keep the scripts plain and self-contained; the session has the repo checked out
and the plan available, but the script is what gets it moving.

## Automations & extensions

A deliberate step: decide which **MCP servers/extensions** the project's agents
should use, and which **automations** (scheduled or on-demand commands) the project
needs. Read `extensions.md` (the catalog of available MCP servers) and
`automations.md` first.

- **Extensions / MCP** — for each capability the work needs (a Postgres MCP for a
  DB-backed project, Sentry for error triage, Linear/Notion for issue/doc access,
  Brave Search for research), assign the server with `<mcp_assign name="Postgres" />`
  (see "App integration tags"). Each assignment is scoped to THIS project and loaded
  into every build & triage session the plan launches — written to the session's
  `.mcp.json` and pre-trusted, so an autonomous agent never blocks on a "trust these
  MCP servers?" prompt. Assign only what the project actually needs; never invent
  secret values (tokens/connection strings stay blank for the user to fill in the
  Extensions screen). A name not in the catalog creates a blank stdio entry to complete.
- **Automations** — assign scheduled/on-demand commands with `<automation_assign>`
  (omit `schedule` for on-demand). Suggest the ones that fit the stack (a daily
  `npm audit`, a lint/test sweep, a dependency-bump check).

Both surface in the project's Automations & extensions UI and persist with the plan.

## Attached skills & knowledge

If `skills.md` exists at the project root, it holds the reusable skills / knowledge the
user paired with this blueprint — project-wide and per-stage. **Read the section for the
stage you're on** and let it inform that stage's work; it's authoritative context the
user chose for this project.

## File intake — route files the user drops in

The user can drag files (design exports, mockups, components, anything) into the
**file-intake** pipeline. Dropped files are staged under `.intake/` in the project
hub, with a manifest at `.intake/intake.json` (`[{ name, kind, size }]`, where `kind`
is a hint: image / vector / markup / style / component / data / doc). When the user
clicks **Route** you are asked to place them; you may also check `.intake/` whenever
the user mentions added files.

For each staged file: examine it, then route it to the right place using `repos.json`
(the linked repos and their roles):

- Pick the relevant repo — e.g. design assets and UI components go to the repo that
  owns the UI. In a multi-repo project, **only attach UI assets to the UI-bearing
  repo**, never to a headless service repo.
- Copy the file into that repo's directory (a sensible subpath like
  `<repo>/design/` or `<repo>/src/components/`), and **reference it in the relevant
  section file** (e.g. cite a mockup in the repo's `ui` section, or wire a dropped
  component into the structure issues that consume it).
- If a file's destination is genuinely ambiguous, **ask the user** before placing it
  rather than guessing.

The pipeline only stages files; the routing decision is yours — that's why it hands
them to you instead of dropping them somewhere fixed.

## Plan the agent fleet

After the per-repo pass, design how multiple Claude sessions will build this project
in parallel — the **fleet**. The goal is maximum parallelism with minimum conflict:
several sessions working at once, each in its own lane, so they rarely touch the same
files and rarely need a human.

1. **Partition the current phase's in-scope work into streams.** A *stream* is one
   session with a focused role ("Auth UI", "API endpoints", "DB schema"). Split by
   concern so that two streams never write the same files.
2. **Give each stream a non-overlapping ownership boundary** — the dirs/globs it
   owns. No path may belong to two streams. A shared file (schema, shared types,
   config, a contract) must be owned by exactly ONE stream; any stream that needs it
   lists that stream in `depends_on` (interface-first: the owner lands it, then the
   dependents build on it).
3. **Assign each stream the issues it owns** — the deliverables from `phases`/scope
   for its area.
4. **Decide the optimal concurrent session count.** There is **no hard limit** on how
   many sessions can run at once: the app shows each session as a pane, a single tab
   holds up to **4×4 = 16** panes, and the user can open **many tabs**. So 16 is only
   a per-tab layout limit, never a ceiling on the fleet. The real bound is how many
   sessions the user can realistically **review and steer** — ask them, and set the
   recommended count to that. Recommend the largest number of genuinely independent
   (non-overlapping, dependency-free) streams they can keep up with, and explain the
   reasoning. (The one-click launch fills one build tab with up to 16 of them; run the
   rest from additional tabs.)
5. **Recommend a director** when the fleet is non-trivial (2+ streams, or multiple
   repos). The director is an *async-integrator* session at the project root: it
   reviews/merges PRs, resolves the cross-stream decisions workers log, and keeps
   milestones/issues/the board current. It does NOT write feature code.
6. **Write `fleet.json`** (authoritative — the app polls it) AND emit the inline
   `<fleet_plan>` + `<agent_assign>` tags (fast path). Keep both current as the fleet
   firms up. Shape:
   ```
   {
     "recommended": 4,
     "reasoning": "Phase 1 splits into four non-overlapping areas; the api-client lands the contract first, the rest are independent.",
     "director": { "enabled": true, "role": "async integrator: review/merge PRs, resolve logged decisions, keep milestones current" },
     "streams": [
       {"id":"auth-ui","name":"Auth UI","repo":"owner/web","owns":["src/auth/**","src/components/login/**"],"issues":["#12","#15"],"dependsOn":[],"prompt":"prompts/auth-ui-kickoff.md"},
       {"id":"api-client","name":"API client","repo":"owner/web","owns":["src/lib/api/**"],"issues":["#18"],"dependsOn":[],"prompt":"prompts/api-client-kickoff.md"}
     ]
   }
   ```
   Each stream may also carry **`"profile"`** — an AgentProfile id that scopes its
   session's auto-approved commands, per-tool permissions, and write-paths (least
   privilege, layered on top of the role). After the commands step has discovered the
   project's toolchain, either reuse an existing profile or, in the fleet card, click
   **Generate least-privilege profiles** to derive one per agent from its role + `owns`
   + the project's commands; `<agent_assign … profile="…">` assigns one inline.
7. **Write a kickoff script per stream** to `prompts/{id}-kickoff.md` (and
   `prompts/director-kickoff.md` if a director). These are the first messages those
   sessions receive — design them for autonomy (next).

**How agents run** (so you design ids + kickoffs right): at launch the app gives each
worker its own **git worktree** of its repo, checked out to a **branch named after the
stream `id`** — so make ids lowercase-hyphen slugs, since they become branch names.
Workers commit on their branch and, under the default self-merge strategy, integrate to develop themselves (rebase + push develop); the director only watches develop CI and flags breakage. (Under the pr-ci strategy workers open PRs and the director merges them.) Because each
worker has its own worktree, several streams can share one repo without touching the
same working tree. (The worktree also carries the plan: `CLAUDE.local.md` is copied in.)

### Stream kickoff scripts — designed for autonomy

Each kickoff is the first message a worker session gets; its job is to let that
session run with as little human input as possible. Every worker kickoff must:

- State the stream's role and that the full plan is in `CLAUDE.local.md` — read it
  first; it is authoritative.
- State the ownership boundary: "you own <globs>; do not modify files outside them —
  another stream owns them; coordinate through the plan, not by editing their files."
- State that it runs in its **own git worktree on a branch named after the stream**:
  commit there and integrate per the fleet strategy — self-merge (default): rebase onto develop and push develop yourself, do NOT open a PR; pr-ci: open a PR for the director to merge — never switch branches or edit
  another agent's worktree. (The app creates the worktree + branch at launch.)
- List the issues the stream owns and this phase's in-scope work for it.
- Carry the **autonomy rule**: *Do not stop to ask. When something is underspecified,
  make the smallest reversible choice consistent with the plan's goal and
  architecture, then record it — pipe a one-line note into `bsc-note` on stdin (e.g.
  `echo "used cursor pagination for /items per the api section" | bsc-note`). Only if
  you are genuinely blocked and cannot proceed, pipe a one-line reason into
  `bsc-blocked`. Verify against the repo's tests and CI rather than asking whether
  your work is correct. Keep working through every owned issue, self-merging each to develop; do not end your turn while any owned issue remains unintegrated.*
- Carry the **checkpoint rule** (so a relaunched session resumes where it left off):
  *When you pause or finish a work session, pipe a short "where I left off + the next
  step" into `bsc-checkpoint` on stdin.* The live conversation usually resumes too
  (each agent has its own worktree/cwd), but the checkpoint is the reliable carry.

The **director kickoff** instead tells it to watch each agent's branch/PR, the open
issues, and each repo's `DECISIONS.md`; under the default self-merge strategy the director only watches develop's CI and, on red, reverts the breaking commit and pings the owning worker to fix-forward (it does NOT merge or assign work); under pr-ci it merges the agents' green branches via PRs (resolving conflicts); resolve or escalate the cross-stream decisions workers log; and keep
milestones/the board current — never writing feature code itself.

## The discovery checklist — a quick orientation, not the main event

Discovery here is a SHORT grounding pass. Its only job is to give the feature
workshop (the real work — see "Develop the GitHub structure") enough shared
context to stand on. Document the core dimensions briefly and move on fast; do
NOT turn this into a dozen set-piece conversations. `goal`, `phases`, `issues`,
and `risks` apply to almost every project.

**Core orientation — document these, briefly (each line is the template).**

> **REQUIRED for the Context gate — always create and confirm four files: `goal.md`,
> `scope.md`, `stack.md`, and `architecture.md`.** Do this for EVERY project, even a trivial
> one (keep them short if so, but never skip them — the "skip what doesn't apply" guidance
> below does NOT cover these four). The Context stage cannot complete until all four exist and
> the user has confirmed each. `users` is helpful orientation but is NOT gate-required.

- `goal` **(gate-required)** — what it does, who it's for, and the measurable signal of
  success (2–4 sentences). Drives the GitHub project title and description.
- `users` — primary personas, their jobs-to-be-done, and the one workflow each
  cares most about. One tight paragraph.
- `scope` **(gate-required)** — two lists: **In scope** (concrete deliverables) and **Out of
  scope** (explicit exclusions that prevent scope creep).
- `stack` **(gate-required)** — one line per layer (runtime, framework, datastore, auth,
  hosting) with versions and a justification for non-obvious picks. As soon as the
  toolchain is decided, record its build/test/run/package binaries in
  `commands.json` and emit `<allow_command>` (see "App integration tags").
- `architecture` **(gate-required)** — named components + a one-sentence responsibility each,
  how they communicate, and the 2–3 key cross-component flows. For a multi-repo
  project, say which repo owns what.

**Capture only where it materially shapes the build — otherwise fold it into the
feature that needs it, or skip:**
- `security` — threat-model highlights, secret management, supply-chain controls,
  encryption at rest/in transit. Note any legal-doc update a data change forces.
- `testing` — the unit/integration/E2E split, frameworks, and the CI gate that
  enforces it (usually one short section every repo reuses).
- `cicd` — pipeline stages, deploy mechanism, and branching/release strategy.

**Captured per feature in the workshop, NOT as standalone project sections:**
`api`, `schema`, `auth`, and `integrations` — a feature's endpoints, tables,
identity needs, and third-party calls belong to that feature's issues, where an
agent will actually build them. Only lift one to its own section if it is a
shared contract many features depend on.

**Skip by default — one line in `_skipped.md` unless the product is centrally
about it:** `ux`, `observability`, `performance`, `infra`, `data_lifecycle`,
`docs`, `analytics`, `accessibility`, `cost`. Document one only when it is a
first-class concern (e.g. `ux` for a design tool, `performance` for a database).

**Planning — the real output (see "Special sections" + the feature workshop):**
- `phases` — the roadmap as a JSON array; each phase a crisp "done when", no time
  estimates.
- `issues` — every feature decomposed into granular, self-contained GitHub issues,
  each carrying a concrete title, **acceptance criteria**, the **files/dirs it
  owns**, its **dependencies**, **labels**, its **phase** (→ milestone), and — for
  a multi-repo project — its **`repo`** and **`stream`**. **This is the most
  important output for execution.** A building agent picks up ONE issue and must
  finish it WITHOUT asking. Don't stop at an overview — the plan isn't done until
  every feature, and the problems it brings, are decomposed to this level.
- `risks` — per risk: what could go wrong, likelihood (low/med/high), impact, and
  mitigation. Add continuously as you spot them.
- `open_questions` — unresolved decisions. Drive to **zero** before the fleet
  launches: resolve each with the user, or record an explicit default ("agent
  decides; default = X") so a building session never has to stop and ask.
- `fleet` — the parallel-execution plan: how the work splits into concurrent
  sessions, who owns which files/issues, and the optimal session count (see "Plan
  the agent fleet"). Written as `fleet.json`.

Document custom topics beyond this list when the project needs them — name the
file after the topic (`feature_flags.md`, `offline_sync.md`).

## Worked examples

```
<plan_update section="goal">
A CLI that runs Postgres migrations against any instance with zero local driver
setup. Users are backend engineers on CI and local dev. Success = migrations run
reliably across environments with no manual driver install.
</plan_update>
```
```
<plan_update section="api">
POST /v1/migrations/up   body {target?:string}  -> 200 {applied:[{version}]}
GET  /v1/migrations/status                       -> 200 {pending:[],applied:[]}
Auth: bearer service token. Errors: {error:{code,message}} with 4xx/5xx.
Pagination: cursor via ?after=; page size capped at 100.
</plan_update>
```
```
<plan_update section="security">
Secrets: DATABASE_URL from the runner's secret store, never logged. Input: DSNs
validated against a scheme allowlist. Supply chain: pinned go.mod + govulncheck in
CI. Transit: TLS-required connections. No PII stored — no legal-doc change.
</plan_update>
```
```
<plan_update section="observability">
Logging: structured JSON, levels error/warn/info/debug, request id propagated.
Metrics: migrations_applied_total, migration_duration_seconds (histogram).
Tracing: one span per migration. Alert: page on migration failure rate above 0.
</plan_update>
```
```
<plan_update section="phases">[
  {"name":"Phase 1 — Working CLI","description":"up/down/status work against a real Postgres; single binary builds cross-platform"},
  {"name":"Phase 2 — Production ready","description":"integration suite passes; release pipeline ships v1.0.0"}
]</plan_update>
```
```
<plan_update section="issues">[
  {"ref":"F1","title":"Add POST /v1/migrations/up","phase":1,"acceptance":["applies pending migrations in order","returns 200 {applied:[{version}]}","integration test against real Postgres"],"owns":["src/api/migrations.go"],"dependsOn":[],"labels":["scope:core","area:api"],"stream":"api"},
  {"ref":"F2","title":"Wire `status` to GET /v1/migrations/status","phase":1,"acceptance":["lists pending + applied","exit 0"],"owns":["src/cli/status.go"],"dependsOn":["F1"],"labels":["scope:core","area:cli"],"stream":"cli"}
]</plan_update>
```

### Worked example — dissecting a hard unit
A hard unit becomes a **sourced approach → a generated Skill → the sub-issues that
consume it** (see "Hard topics" in the feature workshop). One unit, end to end:

*Unit: "Render 10k+ nodes in the graph view at 60 fps" — too vague to hand off, so
dissect it.*

1. **Sourced approach** — WebGL instanced rendering via `three` (r160) `InstancedMesh`;
   one draw call for all nodes, per-instance matrices updated on layout tick; GPU
   picking via an id-color buffer. Pitfall: per-frame matrix churn → batch into a
   `Float32Array` and `needsUpdate` once.
2. **Generated Skill** (written into `skills.json`, scoped to this project + pinned so
   the fleet picks it up — see "Manage the Skills library"):
```
[{"name":"WebGL instanced graph render","kind":"scaffold","description":"Set up a three.js InstancedMesh scene graph with GPU picking for 10k+ nodes at 60 fps","prompt":"1. Create the InstancedMesh with a capacity of N. 2. On each layout tick, write per-node matrices into one Float32Array and set instanceMatrix.needsUpdate. 3. Add an id-color picking pass on a separate render target. 4. Verify 60 fps at 10k nodes via the perf harness.","tools":["Read","Edit","Bash"],"profiles":["build"],"projects":["<this-project-key>"],"pinned":true}]
```
3. **Sub-issues that consume it** (each `dependsOn` the prior; the skill carries the how):
```
<plan_update section="issues">[
  {"ref":"G1","title":"InstancedMesh scene graph for nodes","phase":2,"acceptance":["one draw call for all nodes","capacity grows without re-alloc churn"],"owns":["src/graph/render/scene.ts"],"dependsOn":[],"labels":["scope:core","area:graph"],"stream":"graph-render"},
  {"ref":"G2","title":"Per-tick instance-matrix batching","phase":2,"acceptance":["matrices written into one Float32Array","instanceMatrix.needsUpdate set once per tick","60 fps at 10k nodes in the perf harness"],"owns":["src/graph/render/layoutSync.ts"],"dependsOn":["G1"],"labels":["scope:core","area:graph"],"stream":"graph-render"},
  {"ref":"G3","title":"GPU id-color picking pass","phase":2,"acceptance":["hover/click resolves the node under the cursor","picking target separate from the visible pass"],"owns":["src/graph/render/picking.ts"],"dependsOn":["G1"],"labels":["scope:core","area:graph"],"stream":"graph-render"}
]</plan_update>
```

## Special sections

- **`goal`** — always document it; its first sentence becomes the GitHub project
  board title and its opening line the description.
- **`phases`** — write `phases.json` as a JSON array of `{"name","description"}`
  objects (the inline tag carries the same JSON). Each phase needs a "done when"
  definition; never include time estimates or week numbers. The publish flow
  turns each phase into a milestone and a tracking issue per repo.
- **`issues`** — write `issues.json` as a JSON array of issue objects:
  `{"ref","title","phase","acceptance":[],"owns":[],"dependsOn":[],"labels":[],"stream"?,"repo"?}`.
  `ref` is a stable planner-local id used by `dependsOn` (NOT the GitHub number,
  which is assigned at publish); `phase` is the 1-based phase number or its name
  (→ that milestone). The publish flow creates ONE GitHub issue per entry — title,
  a body built from the acceptance checklist + owned paths + dependencies, pinned to
  its milestone, with its labels and a `stream:<id>` label. A fleet stream owns its
  issues by listing their refs. Define enough that the agent who picks one up needs
  nothing else.
- **`_skipped`** — the coverage record described under "Coverage" above.

## Develop the GitHub structure — the feature workshop (the main event)

This is the heart of planning and where the MAJORITY of the session goes. After
the short orientation, you turn the project into its real GitHub structure — the
features each repo will have, the issues each brings, and the path to build them.
The output is `issues.json` + `phases.json` (the milestones → issues Publish
creates). It is a real, Socratic back-and-forth: **propose, then interrogate** —
lead with a concrete proposal from the codebase + goal, then push the user to
correct, fill gaps, and confront what each piece breaks.

**Pace: go slow, ONE unit at a time.** This is where plans get missed when rushed.
Hold only the CURRENT unit in focus and fully finish it — its spec, the issues it
brings, confirmed and written to `issues.json` — before you touch the next. Working
one unit at a time keeps the context tight and is the only way to guarantee nothing
is skipped. Do NOT sketch the whole project at once.

**What a "unit" is depends on the project — pick the mode and tell the user which
you're using:**

- **A NEW project → go feature by feature.** First agree a short **feature list**
  (the agenda: named capabilities, no detail yet). Then take the features ONE at a
  time: fully drive the current feature down to its issues (see "Drive a unit down"
  below), confirm it, write it, and only THEN move to the next. Never batch the
  depth pass across features.

- **An EXISTING project → migrate section by section.** You are bringing the whole
  existing app into the plan, so a missed section is missed real work. First build a
  **section inventory** — every screen / route / page / component area / module /
  service in the codebase, listed as a checklist (scan the router, the directory
  tree, the nav). Confirm with the user that the inventory is complete. Then walk it
  ONE section at a time: read that section's code, capture what it does today and
  every piece of work to bring it into the plan (its issues), confirm, **check it
  off**, and move on. Do not finish until every inventoried section is accounted for.

**Go repo by repo.** A project is the sum of what each repo/app does, so run the
workshop once PER linked repo (its own feature list or section inventory), then
sequence across them. Every issue carries its `repo`, so the structure panel groups
it under the repo it belongs to.

**Be Socratic — interrogate every unit.** Pull the complete picture out of the user;
don't accept the first answer. For each unit probe: the happy path, the
error/empty/loading states, the edge cases, what data it migrates, what it breaks
elsewhere, and the cross-repo contracts it depends on. Each problem you surface is
itself an issue — a unit is not "mapped" until the issues it BRINGS are mapped too.

**Hard topics — dissect into a sourced approach + reusable Skills.** When a unit
needs a non-trivial or specialized solution — a physics / protein-folding
simulation, a neural-net architecture, 3D graphics/rendering, a novel algorithm, a
gnarly migration, anything where "build it somehow" would leave the agent stuck —
STOP and ground the approach before you write its issues. **This dissection is the
single highest-leverage moment in planning**: the user's understanding of the hard
problem should leave as a durable, reusable **Skill** the building agent can invoke,
not a one-off prose sketch it has to re-derive:

1. **Research + source.** Name the established approach from what you know (the
   standard technique, the canonical library/framework, the reference architecture).
   Source it: ask the user for papers / docs / a reference implementation they trust,
   and `WebFetch` any concrete URL you or they name (a library API page, a spec, a
   GitHub raw file) to verify it — you can fetch a known URL but not search, so ask
   for the link rather than guessing. **Pin the specifics**: the exact library +
   version, the algorithm/architecture, the data structures, the known pitfalls, and
   the perf/accuracy constraints.
2. **Break the problem into one or more Skills.** Instead of leaving the grounded
   approach as prose, emit a **Skill** — a reusable capability bundle (prompt +
   bundled tools + profile guardrails) — into `skills.json` (see "Manage the Skills
   library"). The skill encodes the procedure you and the user worked out: the ordered
   steps, the named tools, the guardrails, and the success checks. The agent that
   builds the unit **invokes the skill** rather than re-deriving the approach.
   - **Scope it to this project** so the fleet picks it up: set the skill's
     `projects` to this project's key and leave it `pinned` (the default) — pinned,
     project-scoped skills are auto-available to every worker on the project. (There
     is no per-stream assignment tag; the `skills.json` entry + `projects`/`pinned`
     scoping IS the assignment.)
   - Planner-generated skills are carried into each worker's worktree at fleet launch
     (`.claude/skills/<slug>/SKILL.md`), the same way `CLAUDE.local.md` is.
3. **Fold the grounded approach into the issues.** The sourced approach becomes each
   issue's **How / build approach** and **Tools & tech** (named, not "a library"),
   sharpens its **acceptance** (e.g. "renders 10k instances at 60 fps via
   InstancedMesh"), and drives the **epic → sub-issue decomposition** the technique
   implies (e.g. an epic "WebGL renderer" → sub-issues for scene graph, instancing,
   picking). The agent building it should never have to re-derive the approach.
4. **Capture the source** so the agent inherits the provenance: write a short
   reference section (a `{topic}.md` plan section, e.g. `research_renderer.md`)
   and/or assign a Knowledge Base block (`<kb_assign>`) scoped to the project so it
   lands in the agent's prompt — preferred over a loose note; failing that, link the
   source in the issue body.

A hard unit left as a generic sketch is a happy-path stub — treat it like a missing
issue: research, source, **dissect into Skills**, and decompose it before the plan is
"done." (See "Worked example — dissecting a hard unit" for the end-to-end shape.)

### Drive a unit (feature or section) down to its issues
For the current unit, propose a complete spec, then interrogate to correct and fill
it before moving on. Do not move on until ALL of these are concrete:
- **Behavior + acceptance** — the HARD GATE. A feature cannot produce issues until
  BOTH are documented: (a) the behavior — the approach/body with a description of
  what the feature does, AND explicit edge/error/empty states (what happens when
  things fail, the list is empty, a conflict occurs, a timeout fires — enumerate
  these; do NOT skip them); (b) at least one acceptance criterion (the done-when
  checklist the agent verifies against). A feature-section file (`- [ ]` lines = AC)
  that has no approach text or no acceptance criteria will NOT be published to GitHub.
  Interrogate each unit until BOTH are present before writing the section file.
- **The issues it brings** — every problem the unit introduces: error/empty/loading
  states, edge cases, validation, migrations/backfills, security and auth needs, and
  the cross-repo contracts it depends on. Make each its own issue — this is what
  turns a happy-path sketch into a complete plan.
- **How — the build approach** — the concrete steps/design: the sequence of changes,
  the integration points, the shape of the solution.
- **Tools & tech** — the specific libraries, services, and frameworks. Name them
  ("Postgres via sqlx", not "a database").
- **Owned files + dependencies** — the files/dirs each issue owns and which issues
  must land first.
Write each issue into `issues.json` the moment it's nailed — with its `repo`,
`stream`, `acceptance`, `owns`, `dependsOn`, and `labels` — so the structure panel
fills in as you go and nothing is lost. Then, and only then, move to the next unit.

### Sequence the path (how we get there)
Once every unit (every feature, or every inventoried section) is decomposed, agree
the ORDER with the user: the first shippable slice, what builds on what, the path
from nothing to the finished product. Group the ordered work into phases
(`phases.json`) — each a dependency-respecting milestone with a crisp "done when,"
not an arbitrary bucket. Phases span repos; each issue's `phase` points at its
milestone and its `repo` places it under that repo in the structure.

**Completeness gate.** The plan is done only when EVERY unit is decomposed — for a
new project, every feature on the list; for an existing project, every section in
the inventory, with the inventory itself confirmed complete. The repo-first
structure panel is your scorecard: an empty repo, or a milestone with no issues, is
unfinished work. For an existing app, a screen or module that exists in the code but
has no issues means you missed it — go back and migrate it.

When the units are done, the user sees the assembled structure (repos → milestones →
issues → dependencies) in the panel, and Publish turns it into the real project
board — every issue the product of this conversation, carrying everything an agent
needs to pick it up and finish without asking.

## Publish to GitHub — the APP does this, not you

You are plan-only: do NOT run `gh repo create`, `gh issue create`, `gh label
create`, `gh api … --method POST`, `git commit`, or `git push`. Those are denied
for this session and, more importantly, the **app's Publish button owns every
git/GitHub mutation**. Your job is to get the plan files right; the app turns them
into the real structure.

When the user clicks **Publish**, the app — using the project owner's credentials —
performs all of this idempotently (check-then-create), per linked repository:
- **Repositories** — creates any `<repo_link>` repo that doesn't exist yet and clones it.
- **Project board** — creates / adopts the same-title board (title + description from `goal`).
- **Milestones** — one per `phases.json` entry.
- **Issues** — one per `issues.json` entry, pinned to its phase milestone, with its
  labels + a `stream:<id>` label (falling back to a per-phase tracking issue when no
  issues are defined).
- **Labels + repo metadata** + the consolidated **`PROJECT_PLAN.md`** committed into
  each repo's `.github/`.

So your only outputs are the plan artifacts — the section files, `phases.json`,
`issues.json`, `fleet.json`, `repos.json`, the `prompts/` kickoffs, and the
`<repo_link>` / `<plan_update>` tags. Get those right and Publish does the rest.

## App integration tags

**Link a repository** (emit once per repo the moment it's confirmed — created,
listed, or discovered; duplicates are harmless):
```
<repo_link full_name="owner/repo" />
```
**Assign a knowledge block** (read `kb_index.md` for ids):
```
<kb_assign id="block-id" />
```
**Suggest an automation** (read `automations.md` first; omit `schedule` for
on-demand commands — otherwise it's a cron expression):
```
<automation_assign name="Daily audit" command="npm audit" schedule="0 9 * * 1-5" description="Runs every weekday morning" />
```
**Assign an MCP server/extension** to this project (#174; read `extensions.md`
for the catalog). `name` is a catalog entry (e.g. `Postgres`, `Sentry`); the
server is scoped to this project and loaded into every build & triage session the
plan launches (`.mcp.json`, pre-trusted). Idempotent — re-emitting the same name
is harmless. Never put secret values in the tag; the user fills env in the
Extensions screen:
```
<mcp_assign name="Postgres" />
```
**Register a per-repo starting script** (emit once you've written the file to
`prompts/`; `mode` is `dev` or `triage`, `path` is relative to this directory).
The app auto-assigns it so that repo's future sessions launch with it:
```
<startup_script repo="owner/repo" mode="dev" path="prompts/web-kickoff.md" />
<startup_script repo="owner/repo" mode="triage" path="prompts/web-triage.md" />
```

**Allow shell commands** so the repo's future console/triage sessions run them
without a permission prompt — the stack's build, test, run, and package-manager
binaries (e.g. `cargo`, `npm`, `pnpm`, `pytest`, `docker`). `gh`/`git` are always
allowed, so don't list them. Use BOTH channels — the file is authoritative:

- **Write `commands.json`** in this directory — the reliable channel the app
  polls (an inline tag in the chat stream can be missed). Project-wide commands
  under `project`, per-repo under `repos` keyed by full_name. Overwrite the whole
  file as the stack firms up:
  ```
  {"project":["cargo"],"repos":{"owner/web":["npm","pnpm"],"owner/api":["pytest"]}}
  ```
- **Inline tag** (fast path; omit `repo` for project scope):
  ```
  <allow_command cmd="cargo" />
  <allow_command repo="owner/repo" cmd="npm" />
  ```

**Declare the agent fleet** (the parallel-execution plan). `fleet.json` is the
authoritative channel; these tags are the fast path. Emit the header once, then one
`agent_assign` per stream. List attributes (`owns`, `issues`, `depends_on`) are
comma-separated; `depends_on` is comma-separated stream ids. An optional `profile`
attribute carries an AgentProfile id that scopes the stream's session (commands +
tools + write-paths) — generate one per agent or reuse an existing profile.

Each stream also carries an optional **flow** (#297) — how it runs and pushes —
via four attributes, all defaulting if omitted:
- `autonomy` = `continuous` (never pause; default) | `checkpoint` (pause at stage/PR
  boundaries and wait) | `confirm` (ask before non-trivial decisions)
- `push` = `auto-pr` (commit+push+open PR on green; default) | `push-confirm`
  (commit+test, then wait for the user before pushing) | `commit-only` (commit, don't
  push) | `none` (read-only; no commit/push/PR)
- `trigger` = `per-issue` (default) | `per-stage` | `on-green` — when a push fires
- `gate` = `hard` (default; the push/PR command prompts for approval) | `soft` (the
  kickoff just instructs the agent to ask). `gate` only matters for `push-confirm`.
Default = `continuous` + `auto-pr` + `per-issue` + `hard`. Set a tighter flow for an
agent whose work you want to review before it lands (e.g. `push=push-confirm gate=hard`),
or `push=none` for a pure reviewer/explorer.
```
<fleet_plan recommended="4" reasoning="..." director="true" director_role="async integrator: review/merge PRs, resolve logged decisions, keep milestones current" />
<agent_assign id="auth-ui" name="Auth UI" repo="owner/web" owns="src/auth/**,src/components/login/**" issues="#12,#15" depends_on="" prompt="prompts/auth-ui-kickoff.md" profile="auth-ui-dev" autonomy="continuous" push="auto-pr" trigger="per-issue" gate="hard" />
```

**Manage the Skills library** (reusable procedures the fleet can invoke). Write
`skills.json` in this directory — the authoritative channel the app polls (the file
is the channel of record). It is a JSON array of skill objects; overwrite the whole
file to update the set. This is where the feature workshop's **"dissect hard problems
→ Skills"** step deposits each capability it distils (see "Hard topics"):
```
[{"name":"Open a clean PR","kind":"workflow","description":"<one line>","prompt":"<the procedure the agent follows>","tools":["create_pr","git_diff"],"profiles":["build","auto"],"projects":["<this-project-key>"],"pinned":true}]
```
- `kind` — one of `workflow|scaffold|codemod|review|docs` (defaults to `workflow`).
- `description` — one line summarizing what the skill does (the parser also accepts `desc`).
- `prompt` — the reusable procedure body the agent follows when it invokes the skill.
- `tools` — the tool names bundled with the skill.
- `profiles` — the permission profiles allowed to invoke it (`build|review|docs|auto|sandbox`; defaults to `build`).
- `projects` — the project keys this skill is scoped to. Set it to **this project's
  key** so the skill is the fleet's, not global noise.
- `pinned` — defaults to `true` for planner skills; pinned + project-scoped skills are
  **auto-available to every worker on the project**.

**Assignment is by scoping, not a tag.** There is no per-stream assignment and no
inline tag — a skill's `projects` + `pinned` fields ARE its assignment. The app
upserts each `skills.json` entry into the global Skills library and, at fleet launch,
copies every pinned skill scoped to this project into each worker's worktree
(`.claude/skills/<slug>/SKILL.md`), the same way `CLAUDE.local.md` is. So to "hand the
agent the means to solve a hard unit," write the skill into `skills.json` with this
project's key in `projects` and leave it pinned.

## GitHub tools — read-only orientation

`GH_TOKEN` is pre-loaded for **reading** GitHub to ground the plan. You are
plan-only: use `gh` only to inspect (login, repo list, open issues/PRs). Do NOT
create repos, milestones, issues, or labels, and do NOT commit/push — the app's
Publish button performs every mutation from your plan files. Read
`github_context.md` for the authenticated login + linked repos.
```
gh api user --jq .login
gh repo list --limit 100 --json nameWithOwner,description,pushedAt
gh issue list --repo owner/repo --state open --limit 20
gh pr list   --repo owner/repo --state open --limit 20
```
"##;

/// One-line directive per planning stage (#542/#666) for the assembled active-stages
/// section. Unknown ids fall back to a generic line.
fn stage_directive(id: &str) -> String {
    let line = match id {
        "context"     => "**Context** — discovery, one topic at a time. The gate REQUIRES these four files, written and confirmed: `goal.md`, `scope.md`, `stack.md`, `architecture.md` — always create them. Cover other dimensions ONLY where they genuinely apply, using the canonical key as the file stem (`users`, `ux`, `schema`, `api`, `security`, `testing`, …); record every dimension you don't document in `_skipped.md`. Each file you create is a gate item the user must confirm — do NOT create files for tangential topics, or the gate can't complete.",
        "repos"       => "**Repos** — decide and link the repositories (emit `<repo_link>`, write `repos.json`).",
        "ui"          => "**UI** — design the screens: write functionless React skeletons to `.ui-skeleton/<Screen>.jsx` and emit `<ui_preview screen=\"…\" mode=\"2d|3d\" />` to render them live.",
        "structure"   => "**Structure** — run the feature workshop (new project → feature-by-feature; existing → section-by-section migration — inventory every screen/module first), then write `phases.json` + agent-ready `issues.json`. Go ONE unit at a time; never move on until the current unit is fully decomposed and written.",
        "permissions" => "**Permissions** — plan the agent fleet (`fleet.json`): non-overlapping streams + least-privilege profiles.",
        "automations" => "**Automations** — propose cron automations (emit `<automation_assign>`).",
        "skills"      => "**Skills** — select reusable skills from the library (`skills.json`).",
        // transform / operate stages (#666) — these do NOT produce issues.json.
        "refactor"     => "**Refactor** — identify improvement opportunities (dead code, simplification, performance); write one targeted cleanup issue per area. Do NOT produce `phases.json` or `issues.json`.",
        "cleanup"      => "**Dead & legacy code** — scan for unused/dead code & dependencies, verify each finding, and triage them into refactor units. Do NOT write `issues.json` — the refactor units drive the fleet directly.",
        "testing" | "testing-informational" => "**Testing** — define the coverage strategy and the test safety net for the changes.",
        "transform"    => "**Transform** — plan the migration to a new pattern, version, or framework; write migration issues in strict dependency order.",
        "boundaries"   => "**Service boundaries** — map the bounded contexts and the seams to split the monolith along.",
        "extraction"   => "**Extraction plan** — sequence the incremental, shippable steps to carve out each service.",
        "consolidation" => "**Consolidation** — plan merging the services, unifying data stores and contracts.",
        "migration"    => "**Migration plan** — the from→to mapping and an incremental, reversible cutover.",
        "hardening"    => "**Security hardening** — threat-model, audit (authz / secrets / deps), and plan concrete fixes.",
        other         => return format!("**{other}** — configured stage."),
    };
    line.to_string()
}

/// Assemble the "Active planning stages" section from the project's ENABLED stages
/// (in order). Stages not listed are declared out of scope, so a disabled stage is
/// never instructed (#512/#542). Empty input ⇒ "" (section omitted; no behavior change).
fn build_active_stages_md(stages: &[String]) -> String {
    if stages.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "\n## Active planning stages\n\nWork these stages, in this order. **Stages not listed here are OUT OF SCOPE for this project — do not produce their artifacts.**\n\n",
    );
    for (i, id) in stages.iter().enumerate() {
        s.push_str(&format!("{}. {}\n", i + 1, stage_directive(id)));
    }
    s
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn setup_workspaces(
    kb_blocks: Vec<KbBlockData>,
    repo_full_names: Vec<String>,
    automations: Vec<AutomationData>,
    is_existing: bool,
    project_name: String,
    project_number: u32,
    pitch: String,
    project_key: String,
    github_login: String,
    github_name: String,
    enabled_stages: Vec<String>,
) -> Result<WorkspacePaths, String> {
    let _perf = PerfSpan::new("setup_workspaces");
    config::sanitize_claude_config();
    // KB session CWD = the flat reusable document library (`documents/`).
    // Planner session CWD = the project hub (`projects/<key>`), holding plan
    // sections + control files FLAT alongside the project's CLAUDE.md.
    let kb_dir       = documents_dir();
    let safe_key     = sanitize_project_key(&project_key);
    // A blank key would resolve the project dir to `projects/` itself and scatter
    // `.claude/` and the plan sections across the parent — refuse it instead.
    if safe_key.is_empty() {
        return Err("setup_workspaces: empty project_key".to_string());
    }
    let planning_dir = project_dir(&project_key);

    for dir in &[
        kb_dir.join(".claude"),
        planning_dir.join(".claude"),
        planning_dir.join("prompts"),
    ] {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    // KB: read + write/edit markdown only; no web access or shell
    std::fs::write(
        kb_dir.join(".claude").join("settings.json"),
        r#"{"permissions":{"allow":["Read","Write","Edit"],"deny":["Bash","MultiEdit","WebFetch","WebSearch"]}}"#,
    ).map_err(|e| e.to_string())?;

    // Planning: read/write markdown + WebFetch + git + gh CLI
    // git: clone/fetch/log/status for linked repos
    // gh:  issues, PRs, releases, workflows — full GitHub access via GH_TOKEN env var
    std::fs::write(
        planning_dir.join(".claude").join("settings.json"),
        r#"{"permissions":{"allow":["Read","Write","Edit","WebFetch","Bash(git *)","Bash(gh *)"],"deny":["MultiEdit","WebSearch"]}}"#,
    ).map_err(|e| e.to_string())?;

    std::fs::write(kb_dir.join("CLAUDE.md"), KB_CLAUDE_MD)
        .map_err(|e| e.to_string())?;

    // Assemble the template: orientation-specific INTRO + shared PROCESS block.
    let mut planning_md = if is_existing {
        format!(
            "{}{}",
            PLANNING_EXISTING_INTRO
                .replace("{PROJECT_NAME}", &project_name)
                .replace("{PROJECT_NUMBER}", &project_number.to_string()),
            PLANNING_PROCESS_MD,
        )
    } else {
        format!("{}{}", PLANNING_NEW_INTRO.replace("{PITCH}", &pitch), PLANNING_PROCESS_MD)
    };

    // Modular planning stages (#512/#542): prepend the project's enabled stages (from
    // its blueprint) as the authoritative scope — disabled stages are declared out of
    // scope so the planner doesn't produce them. Empty ⇒ no change (all-stages default).
    let stages_md = build_active_stages_md(&enabled_stages);
    if !stages_md.is_empty() {
        planning_md.push_str(&stages_md);
    }

    // Append linked repos section for existing projects (always, even when
    // empty, so Claude knows the current state and acts accordingly).
    if is_existing {
        planning_md.push_str("\n## Linked repositories\n\n");
        if repo_full_names.is_empty() {
            planning_md.push_str("No repositories are currently linked to this project.\n");
        } else {
            for full_name in &repo_full_names {
                let local_path = repo_dir(&project_key, full_name);
                planning_md.push_str(&format!(
                    "- **{full_name}**\n  - local path: `{local_path}` — the app clones it here for you to read; don't clone it yourself.\n",
                    full_name  = full_name,
                    local_path = local_path.display(),
                ));
            }
        }
    }

    std::fs::write(planning_dir.join("CLAUDE.md"), planning_md)
        .map_err(|e| e.to_string())?;

    // Sync every KB block to disk as a markdown file (overwrite on each call)
    for block in &kb_blocks {
        let content = format!(
            "---\nid: {}\ntitle: {}\ntags: [{}]\n---\n\n{}",
            block.id,
            block.title,
            block.tags.join(", "),
            block.content,
        );
        std::fs::write(kb_dir.join(format!("{}.md", block.id)), content)
            .map_err(|e| e.to_string())?;
    }

    // Write a KB index so Claude can quickly see what's available without
    // reading every individual block file. The planner's session CWD is this
    // project hub (`projects/<key>`), and reusable KB blocks live in the flat
    // library (`documents/`), so the relative reference is `../../documents/{id}.md`.
    let mut kb_index = String::from(
        "# Knowledge Base Index\n\n\
         Read any block file at `../../documents/{id}.md` for full content.\n\
         Assign a block to this project with: `<kb_assign id=\"{id}\" />`\n\n"
    );
    if kb_blocks.is_empty() {
        kb_index.push_str("_No knowledge blocks in the store yet._\n");
    } else {
        for block in &kb_blocks {
            kb_index.push_str(&format!(
                "- `{}` — **{}** (tags: {})\n",
                block.id,
                block.title,
                if block.tags.is_empty() { "none".to_string() } else { block.tags.join(", ") },
            ));
        }
    }
    std::fs::write(planning_dir.join("kb_index.md"), kb_index)
        .map_err(|e| e.to_string())?;

    // Write automations catalogue so Claude can reference and assign them.
    let mut auto_md = String::from(
        "# Automations Catalogue\n\n\
         Suggest assigning an automation to this project with a single-line tag:\n\
         `<automation_assign name=\"...\" command=\"...\" schedule=\"0 9 * * 1-5\" description=\"...\" />`\n\n\
         The `schedule` field is a cron expression (omit for one-shot commands).\n\n"
    );
    if automations.is_empty() {
        auto_md.push_str("_No saved automations yet — suggest new ones using the tag above._\n");
    } else {
        auto_md.push_str("## Saved automations\n\n");
        for a in &automations {
            auto_md.push_str(&format!("- **{}** (`{}`)", a.name, a.id));
            if let Some(sched) = &a.schedule {
                auto_md.push_str(&format!(" · cron: `{}`", sched));
            }
            auto_md.push_str(&format!("\n  command: `{}`\n", a.command));
        }
    }
    std::fs::write(planning_dir.join("automations.md"), auto_md)
        .map_err(|e| e.to_string())?;

    // Write the extensions catalogue (#174) so the planner's "Automations &
    // extensions" step knows which MCP servers it can assign. The names mirror the
    // frontend catalog (src/lib/extensions.ts CATALOG_TEMPLATES) — the source of
    // truth for each server's transport/command/env; this file is guidance text.
    // Each `<mcp_assign>` scopes that server to THIS project; every build & triage
    // session the plan launches then loads it via its `.mcp.json` (pre-trusted, no
    // blocking prompt).
    let ext_md = String::from(
        "# Extensions Catalogue (MCP servers)\n\n\
         Assign an MCP server/extension to this project with a single-line tag:\n\
         `<mcp_assign name=\"Postgres\" />`\n\n\
         Each assigned server is scoped to THIS project and loaded into every build &\n\
         triage session this plan launches — written to the session's `.mcp.json` and\n\
         pre-trusted, so the agent never blocks on a \"trust these MCP servers?\" prompt.\n\
         Assign only the servers the project's agents actually need.\n\n\
         ## Available servers\n\n\
         - **Postgres** — query/inspect a Postgres database (env: POSTGRES_CONNECTION_STRING)\n\
         - **SQLite** — query a local SQLite database\n\
         - **Slack** — post/read Slack (env: SLACK_BOT_TOKEN, SLACK_TEAM_ID)\n\
         - **Brave Search** — web search (env: BRAVE_API_KEY)\n\
         - **Stripe** — Stripe API tools (env: STRIPE_SECRET_KEY)\n\
         - **Sentry** — error tracking (HTTP)\n\
         - **Linear** — issue tracking (HTTP)\n\
         - **Notion** — docs/notes (HTTP)\n\n\
         A name not in this list creates a blank stdio MCP entry the user completes in\n\
         the Extensions screen. Required env values (tokens, connection strings) are left\n\
         blank for the user to fill — never invent secrets.\n\n\
         Pair this with `<automation_assign …>` (see automations.md) in the planner's\n\
         \"Automations & extensions\" step.\n"
    );
    std::fs::write(planning_dir.join("extensions.md"), ext_md)
        .map_err(|e| e.to_string())?;

    // Write a github_context.md so Claude knows the authenticated user and
    // what repos are available without needing to run `gh api user` first.
    let mut gh_ctx = String::from("# GitHub Context\n\n");
    if !github_login.is_empty() {
        gh_ctx.push_str("## Authenticated user\n\n");
        gh_ctx.push_str(&format!("- **Login**: `{}`\n", github_login));
        if !github_name.is_empty() {
            gh_ctx.push_str(&format!("- **Name**: {}\n", github_name));
        }
        gh_ctx.push_str(&format!("- **Profile**: https://github.com/{}\n\n", github_login));
    }
    if !repo_full_names.is_empty() {
        gh_ctx.push_str("## Linked repositories\n\n");
        for full_name in &repo_full_names {
            let local_path = repo_dir(&project_key, full_name);
            gh_ctx.push_str(&format!(
                "- `{}` — local path: `{}`\n",
                full_name, local_path.display(),
            ));
        }
        gh_ctx.push('\n');
    }
    gh_ctx.push_str(
        "## Useful gh commands (read-only — the app's Publish button does all writes)\n\n\
         ```\n\
         gh api user                                    # confirm auth\n\
         gh repo list --limit 100 --json nameWithOwner  # all repos\n\
         gh issue list --repo {owner}/{repo}            # open issues\n\
         gh pr list   --repo {owner}/{repo}             # open PRs\n\
         ```\n"
    );
    std::fs::write(planning_dir.join("github_context.md"), gh_ctx)
        .map_err(|e| e.to_string())?;

    // Write a deterministic context signature so Planning.tsx can surface a
    // "context updated · refresh" badge when inputs diverge from this baseline (#175).
    {
        let kb_ids: Vec<String> = kb_blocks.iter().map(|b| b.id.clone()).collect();
        let sig = context_signature(&repo_full_names, &kb_ids, &enabled_stages);
        std::fs::write(planning_dir.join("context_signature.txt"), sig)
            .map_err(|e| e.to_string())?;
    }

    Ok(WorkspacePaths {
        kb_dir:       kb_dir.to_string_lossy().into_owned(),
        planning_dir: planning_dir.to_string_lossy().into_owned(),
    })
}

/// The single source of truth for the planning context signature (#175/#756): the template
/// version + the sorted inputs (repos, KB block ids, enabled stages). Used by BOTH
/// `setup_workspaces` (to record the baseline) and `compute_context_signature` (the live
/// value Planning.tsx compares against) so the two can never disagree on format/version.
fn context_signature(repos: &[String], kb_ids: &[String], stages: &[String]) -> String {
    let mut r = repos.to_vec(); r.sort();
    let mut k = kb_ids.to_vec(); k.sort();
    let mut s = stages.to_vec(); s.sort();
    format!("v{}|{}|{}|{}", PLANNING_TEMPLATE_VERSION, r.join(","), k.join(","), s.join(","))
}

/// Compute the CURRENT context signature for the given live inputs, the same way
/// `setup_workspaces` recorded the baseline — Planning.tsx compares the two to show the
/// "context updated · refresh" badge. (#756 — fixes the old v1-vs-v{version} mismatch.)
#[tauri::command]
pub(crate) fn compute_context_signature(repo_full_names: Vec<String>, kb_ids: Vec<String>, enabled_stages: Vec<String>) -> String {
    context_signature(&repo_full_names, &kb_ids, &enabled_stages)
}

/// Read back the context signature that `setup_workspaces` last wrote (#175).
/// Returns an empty string when the file doesn't exist yet.
#[tauri::command]
pub(crate) fn get_context_signature(project_key: String) -> String {
    let path = project_dir(&project_key).join("context_signature.txt");
    std::fs::read_to_string(path).unwrap_or_default()
}

#[cfg(test)]
mod tests {

    #[test]
    fn build_active_stages_md_includes_enabled_excludes_disabled() {
        // Empty → omitted (all-stages default, no behavior change).
        assert_eq!(super::build_active_stages_md(&[]), "");

        let md = super::build_active_stages_md(&["context".into(), "structure".into()]);
        assert!(md.contains("Active planning stages"));
        assert!(md.contains("OUT OF SCOPE"), "must declare unlisted stages out of scope");
        assert!(md.contains("**Context**") && md.contains("**Structure**"));
        // a stage not in the enabled list is absent
        assert!(!md.contains("**UI**"), "disabled stage must not be instructed");
        // ordered + numbered
        assert!(md.find("**Context**").unwrap() < md.find("**Structure**").unwrap());

        // unknown id → generic line, never panics
        assert!(super::build_active_stages_md(&["custom-x".into()]).contains("**custom-x**"));
    }

    /// Context directive must name the four gate-required files so the planner
    /// doesn't create tangential sections that block the gate (#672).
    #[test]
    fn stage_directive_context_names_four_gate_files() {
        let d = super::stage_directive("context");
        assert!(d.contains("goal.md"),         "missing goal.md");
        assert!(d.contains("scope.md"),        "missing scope.md");
        assert!(d.contains("stack.md"),        "missing stack.md");
        assert!(d.contains("architecture.md"), "missing architecture.md");
        assert!(d.contains("_skipped.md"),     "must mention _skipped.md fallback");
    }

    /// Structure directive must mention both workshop modes (#355).
    #[test]
    fn stage_directive_structure_mentions_workshop_modes() {
        let d = super::stage_directive("structure");
        assert!(d.contains("feature-by-feature"), "missing new-project mode");
        assert!(d.contains("section-by-section"), "missing existing-project mode");
        assert!(d.contains("ONE unit"), "missing pace mandate");
    }

    /// Custom/refactor-blueprint stages get real directives, not the generic fallback (#666).
    #[test]
    fn stage_directive_custom_stages_have_real_directives() {
        for id in &["refactor", "cleanup", "testing", "testing-informational", "transform"] {
            let d = super::stage_directive(id);
            assert!(
                !d.ends_with("configured stage."),
                "stage '{id}' fell back to generic — needs a real directive"
            );
        }
        // Refactor explicitly says NOT to produce phases.json/issues.json (#666).
        assert!(super::stage_directive("refactor").contains("NOT"), "refactor must exclude phases/issues");
    }

    /// PLANNING_PROCESS_MD Coverage section must carry the gate-item and Context gate text (#672).
    #[test]
    fn planning_process_md_coverage_names_context_gate_requirements() {
        let md = super::PLANNING_PROCESS_MD;
        assert!(md.contains("gate item"), "must explain the gate-item concept");
        assert!(md.contains("Context** gate"), "must name the Context gate");
        assert!(md.contains("goal`, `scope`"), "must list the required core files");
        assert!(md.contains("Work one stage at a time"), "must include the one-stage-at-a-time rule");
    }

    /// Both intros must carry the scope guard that makes the active-stages list
    /// authoritative over the fixed workflow steps (#666).
    #[test]
    fn planner_intros_carry_active_stages_scope_guard() {
        for t in [super::PLANNING_NEW_INTRO, super::PLANNING_EXISTING_INTRO] {
            assert!(
                t.contains("Active planning stages section at the bottom of this file"),
                "scope guard missing from intro"
            );
            assert!(
                t.contains("do not produce their artifacts"),
                "must declare that unlisted stages are out of scope"
            );
        }
    }

    /// PLANNING_EXISTING_INTRO must include the lifecycle check paragraph (#458).
    #[test]
    fn planning_existing_intro_has_lifecycle_check() {
        let intro = super::PLANNING_EXISTING_INTRO;
        assert!(intro.contains("Lifecycle check"), "lifecycle check section missing");
        assert!(intro.contains("near-complete"), "must mention near-complete threshold");
        assert!(intro.contains("refactor"), "must mention refactor pass for near-complete projects");
    }

    #[test]
    fn planner_template_is_plan_only_no_git_mutations() {
        // The planner is plan-only (#503): it must not be instructed to create repos,
        // milestones, issues, or labels, nor commit/push — the app's Publish flow owns
        // every git/GitHub mutation. (The prohibition prose uses bare backticked forms
        // like `gh repo create`; here we guard the args-bearing INSTRUCTION forms that
        // only ever appeared as commands to run.)
        for t in [super::PLANNING_NEW_INTRO, super::PLANNING_EXISTING_INTRO, super::PLANNING_PROCESS_MD] {
            assert!(!t.contains("--method POST --field"), "planner template instructs `gh api … --method POST`");
            assert!(!t.contains("gh label create \""), "planner template instructs `gh label create`");
            assert!(!t.contains("gh issue create --repo"), "planner template instructs `gh issue create`");
            assert!(!t.contains("gh repo create owner"), "planner template instructs `gh repo create`");
            assert!(!t.contains("gh repo create {owner}"), "planner template instructs `gh repo create`");
            assert!(!t.contains("gh repo create {login}"), "planner template instructs `gh repo create`");
        }
        // Positive: the plan-only publish framing is present.
        assert!(super::PLANNING_PROCESS_MD.contains("Publish button"), "publish-by-app framing missing");
        assert!(super::PLANNING_PROCESS_MD.contains("plan-only"), "plan-only framing missing");
    }

    #[test]
    fn context_signature_is_versioned_sorted_and_order_independent() {
        // One source of truth (#756): setup_workspaces (baseline) + compute_context_signature
        // (live) call this, so they can never disagree on format/version.
        let a = super::context_signature(
            &["b".into(), "a".into()], &["k2".into(), "k1".into()], &["s2".into(), "s1".into()]);
        let b = super::context_signature(
            &["a".into(), "b".into()], &["k1".into(), "k2".into()], &["s1".into(), "s2".into()]);
        assert_eq!(a, b, "order-independent (inputs are sorted)");
        assert_eq!(a, format!("v{}|a,b|k1,k2|s1,s2", super::PLANNING_TEMPLATE_VERSION));
        // carries the real template version, not a hardcoded constant — fixes the v1/v{N} mismatch.
        assert!(a.starts_with(&format!("v{}|", super::PLANNING_TEMPLATE_VERSION)));
    }

    #[test]
    fn custom_stage_directives_and_scope_guard() {
        // Custom transform/operate stages get real directives, not the generic fallback.
        let cleanup = super::stage_directive("cleanup");
        assert!(cleanup.contains("refactor units"), "cleanup has a real directive");
        assert!(cleanup.to_lowercase().contains("do not write"), "cleanup forbids issues.json");
        assert!(super::stage_directive("boundaries").contains("bounded contexts"));
        // The active-stages section for a refactor-like set (no `structure`) doesn't list
        // Structure — so its issues.json step is out of scope.
        let md = super::build_active_stages_md(&[
            "context".to_string(), "repos".to_string(), "cleanup".to_string(),
            "testing".to_string(), "permissions".to_string(),
        ]);
        assert!(md.contains("OUT OF SCOPE"), "scope guard present");
        assert!(!md.contains("Structure"), "no Structure stage → no issues.json step");
        assert!(super::PLANNING_PROCESS_MD.contains("authoritative"), "process defers to the active-stages list");
        // The context directive names the four gate-required files so the planner creates
        // exactly what the gate keys on (#671 follow-up).
        let ctx = super::stage_directive("context");
        for f in ["goal.md", "scope.md", "stack.md", "architecture.md"] {
            assert!(ctx.contains(f), "context directive names {f}");
        }
        assert!(ctx.contains("_skipped.md"), "context directive points non-applicable dimensions at _skipped");
        assert!(super::PLANNING_PROCESS_MD.contains("gate item"), "coverage section frames created files as gate items");
        // The discovery checklist itself flags the four files as gate-required and tells the
        // planner the gate can't pass without them — so they aren't lost to "skip" guidance (#736).
        let proc = super::PLANNING_PROCESS_MD;
        assert!(proc.contains("REQUIRED for the Context gate"), "checklist has the required-files callout");
        assert!(proc.contains("gate-required"), "checklist marks the four required dimensions");
        for f in ["goal.md", "scope.md", "stack.md", "architecture.md"] {
            assert!(proc.contains(f), "checklist callout names {f}");
        }
    }
}

