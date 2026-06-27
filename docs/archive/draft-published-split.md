# Archived: Draft/published on-disk split

Separating unpublished (draft) projects from published ones into different on-disk directories. Reverted in favor of an in-place `projects/<key>/.published` marker — hubs never move — in #922.

Deleted from GitHub; full content below. Machine-readable mirror: `draft-published-split.jsonl`.

**Issues (1):** #904

---

## #904 — Separate draft (unpublished) projects from published projects on disk

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, rust, stream:ia-restructure
- **created:** 2026-06-16T22:32:44Z · **closed:** 2026-06-18T12:08:01Z

## Problem

All project hubs currently live together under one directory regardless of whether the project has been published to GitHub:

```
~/.base-studio-code/projects/<key>/
```

`<key>` is the title-derived, sanitized folder name (`sanitize_project_key` — `src-tauri/src/lib.rs:856`; frontend mirror `sanitizeProjectKey` — `src/lib/projectPaths.ts:14`). There is **no on-disk distinction** between a half-finished local draft and a project whose GitHub structure (repos, board, milestones, issues) has been published. That makes the Projects list a mix of throwaway drafts and "real" projects, and there's no clean place to manage/prune drafts.

## Desired behavior

**A project that has not been published to GitHub lives under a `draft/` directory; a published one lives under `projects/`.**

```
~/.base-studio-code/draft/<key>/        # unpublished — the default for every new project
~/.base-studio-code/projects/<key>/     # published — current location, unchanged
```

- A **new** planning session creates its hub under `draft/<key>/`.
- **Publishing** (when `handlePublish` succeeds and `setActiveProjectMeta` sets `activeProjectId`) **promotes** the hub: move `draft/<key>/` → `projects/<key>/`.
- The Projects list shows both, visually distinguishing **Draft** from **Published**.

## "Published" is encoded by location

Today "published" is signalled only by transient store state: `published: !!activeProjectId`, where `activeProjectId` is the GitHub Projects v2 node id set by `setActiveProjectMeta` in `handlePublish` (`src/screens/projects/Planning.tsx:1566`, `:1699`). Per-project published-state is **not** persisted on disk.

Proposal: **make the hub's location the source of truth.** A hub under `projects/` is published; under `draft/` it is not. No new flag to keep in sync — promotion is a directory move.

Add one resolver used by every path helper:

```rust
// resolve where a project's hub actually lives: published dir wins, else draft.
// New hubs default to draft/.
fn project_root(key: &str) -> PathBuf            // existing => that dir; new => draft/<key>
fn project_root_for_create(key: &str) -> PathBuf // projects/<key> if it already exists, else draft/<key>
```

Frontend equivalents in `src/lib/projectPaths.ts` (`projectHubCwd`, `projectRepoCwd`, `agentWorktreeCwd`) resolve the same way (the backend can expose the resolved root via the existing `project_dir_path` command so the frontend never guesses).

> Note: worktrees stay at `~/.base-studio-code/worktrees/<key>/…` — keyed by `<key>`, independent of draft/published, so promotion does not move them. See edge case below.

## Work

**Backend (`src-tauri/src/`)** — route every projects-path composition through the resolver:

- [ ] `setup_workspaces` (`planner.rs:101`) — create new hubs under `draft/<key>/` (or `projects/<key>/` if already promoted).
- [ ] New command `promote_project(key)` — move `draft/<key>/` → `projects/<key>/`; idempotent no-op if already published. Repairs nothing else (worktrees unaffected).
- [ ] `list_local_projects` (`lib.rs:313`) — scan **both** `draft/` and `projects/`, returning a `published: bool` (derived from location) on each `LocalProject`.
- [ ] Route through the resolver: `clone_repo` (`:895`), `delete_project_dir` (`:195`), `write_project_file`/`write_project_file_bytes` (`:412`), `read_plan_sections`/`ingest_section_files` (`:1874`/`:171`), `clear_project_plan_files` (`:357`), `read_ui_skeleton` (`:779`), `project_dir_path` (`:786`), `ensure_worktree` (`:1156`), `ensure_director_protocol` (`:1130`).

**Frontend** —

- [ ] `handlePublish` (`Planning.tsx:1566`): after `setActiveProjectMeta`, invoke `promote_project(effectiveProjectId)`.
- [ ] `src/lib/projectPaths.ts` helpers resolve via the backend's resolved root.
- [ ] ProjectsList: separate / badge **Draft** vs **Published** using the new `published` flag from `list_local_projects`.
- [ ] Anything composing a hub/repo cwd for fleet launch (`fleetStartProject`, `triageStartProject`), repo clone-on-plan-change effect (`Planning.tsx:333`), `addProjectRepo` — must use the resolved root.

**One-time migration** —

- [ ] On startup, move existing unpublished hubs from `projects/<key>/` into `draft/<key>/`. Published ones are identified by the persisted `projectKeyAlias` values (node-id → key, set at publish) plus the active project; every other existing `projects/<key>` is treated as a draft and relocated. Document that pre-existing drafts with no alias signal are moved to `draft/` (the intended end state).

## Edge cases / decisions

- **Fleet on a draft.** `git worktree` records an absolute path to the source repo (cloned inside the hub). If a fleet is launched on a draft and the hub is later moved on publish, worktree gitdir links break. Decide: (a) require publish before fleet launch, (b) repair worktree links during `promote_project`, or (c) keep cloned repos/worktrees outside the moved hub. **Recommend (b)** — `git worktree repair` after the move — so promotion is always safe.
- **Key collision across draft/published.** Two same-titled projects already collide on `<key>` today (known issue — title-derived keys aren't stable ids). This change doesn't worsen it, but promotion must refuse to overwrite an existing `projects/<key>`.
- Promotion is **one-way** for now (no "unpublish" demotion).

## Acceptance criteria

1. A new planning session creates its hub under `~/.base-studio-code/draft/<key>/`.
2. Publishing moves the hub to `~/.base-studio-code/projects/<key>/`; all subsequent reads/writes/fleet launches resolve to the new location with no broken paths or worktrees.
3. `list_local_projects` returns both draft and published projects, each correctly flagged; the Projects list distinguishes them.
4. Existing installs migrate: unpublished hubs relocate to `draft/`, published ones stay in `projects/`.
5. Rust + frontend tests cover: resolver (published-wins / new-defaults-to-draft), `promote_project` (move + idempotency + refuse-overwrite), and `list_local_projects` flagging.

### Comments

**kevinthelago** (2026-06-18T12:08:00Z):

Superseded by #922 — we replaced the draft/published *directory split* with an in-place `.published` marker (hubs never move), which is the opposite approach to this issue. No separate draft/published on-disk separation is needed. Closing as superseded.

---
