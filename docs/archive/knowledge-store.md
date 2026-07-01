# Archived: Knowledge Store / Knowledge Base page

The removed Knowledge Store page — embedded-console block generation, list/search/edit, and the document-assignment model. Superseded by the Skills library; torn out in #1460 (reference-context half removed in #1812).

Deleted from GitHub; full content below. Machine-readable mirror: `knowledge-store.jsonl`.

**Issues (12):** #7, #32, #51, #140, #212, #320, #321, #322, #323, #324, #325, #1016

---

## #7 — Knowledge Store screen

- **state:** CLOSED (COMPLETED) · **labels:** ui, feature
- **created:** 2026-05-22T21:34:47Z · **closed:** 2026-05-23T02:51:00Z

## Summary

Implement the Knowledge Store screen — a three-column layout for browsing, searching, and editing knowledge blocks.

## Tasks

- [ ] `src/screens/KnowledgeStore.tsx`
- [ ] Left column (200px): tag rail listing `KB_TAGS` with count badges and active highlight; `SOURCES` section below
- [ ] Center column (280px): search input + sort select + block list from `KB_BLOCKS` (id, title, tags, updated); "New block" primary button at bottom
- [ ] Right column (flex): editor/preview split
  - Header: block id chip, title `<input>`, tag chips + `+ tag` button, link/embed/save buttons
  - Left half: raw markdown `<pre>` editor with syntax-colored tokens (repo links in accent, agent names in success)
  - Right half: rendered preview panel with backlinks section

## Dependencies

Issues #4 (pane system) and #5 (store + router) must be merged first.

## Design reference

`design/screen-knowledge.jsx`

### Comments

**kevinthelago** (2026-05-23T02:50:59Z):

Implemented and shipped. All checklist items complete on main.

---

## #32 — Knowledge Store: T-layout with embedded Claude console for block generation

- **state:** CLOSED (COMPLETED) · **labels:** ui, feature, scope:core, P2
- **created:** 2026-05-23T02:55:20Z · **closed:** 2026-05-30T18:08:14Z

## Summary

Add a dedicated Claude session to the Knowledge Store screen that can be used to generate, refine, and populate knowledge blocks. The screen adopts a **T-layout**: the existing tag rail and block list stay as-is on the left; the right column becomes a vertical split with the editor/preview on top and a full-width Claude console below.

## Layout

```
┌──────────┬──────────┬───────────────────────────────┐
│          │          │ block header bar               │
│          │          ├───────────────┬───────────────┤
│ Tag Rail │  Block   │  Raw editor   │  Preview       │
│  200px   │  List    │               │                │
│          │  280px   ├───────────────┴───────────────┤
│          │          │  Claude console  (full width)  │
└──────────┴──────────┴───────────────────────────────┘
```

The stem of the T (console) spans the full width of the right column beneath the editor/preview row. A resize handle between the two rows lets the user control how much vertical space each gets.

## Behaviour

- The console runs an isolated Claude session scoped to the Knowledge Store (separate from any pane sessions on the Console screen)
- Agent can read the currently selected block and write back to it (e.g. "expand the Tone section", "add a Rust example")
- Suggested default prompt injected as system context: the content of the currently selected block so Claude has immediate context
- Console uses the same `PaneShell` + `ConsoleView` components already built, with `agent="@kb-assistant"` and `status="on"`
- Session is stateless between block selections for now (no persistence required in this issue)

## Tasks

- [ ] Add a vertical split to the right column of `KnowledgeStore.tsx` — top: existing editor/preview; bottom: `PaneShell` with `ConsoleView`
- [ ] Add a draggable resize handle between the two rows (or a fixed default split, e.g. 60/40)
- [ ] Wire the console's `agent` label and initial context to the selected block id/title
- [ ] Add a `kb-assistant` session entry to the store or keep it local to the screen (local `useState` is sufficient for now)
- [ ] Ensure the tag rail and block list columns are unaffected by the layout change

## Design notes

- The console panel should have a minimum height so it doesn't collapse fully
- The `PaneShell` hamburger and view tabs are not needed here — consider a simplified header showing only the agent name and a clear/reset button
- Do not add the new session to the Console screen's tab/pane grid; it is exclusive to the Knowledge Store

## Files

- `src/screens/KnowledgeStore.tsx` — primary change
- `src/styles/tokens.css` — resize handle styles if needed

### Comments

**kevinthelago** (2026-05-30T18:08:14Z):

Shipped: src/screens/KnowledgeStore.tsx implements the T-layout (useDragResize x + y) with an embedded xterm console spawning claude via pty_create/pty_write for block generation. Closing (board cleanup).

---

## #51 — Rethink UX for assigning knowledge documents to projects & Claude sessions

- **state:** CLOSED (NOT_PLANNED) · **labels:** enhancement, P2, stream:kb-ux
- **created:** 2026-05-25T19:25:11Z · **closed:** 2026-06-01T06:16:46Z

## Context
On branch `unified-document-store` we added an interim way to assign a knowledge-base document as a session's **startup prompt** at three levels (global default -> project -> per-repo) via a `gear prompts` panel in the Projects header, on top of the new unified document store (`documents/`) surfaced in the KB page with source filters.

The per-repo dropdown approach doesn't feel like the right UX. Tabling it.

## Problem
There is no cohesive, intuitive way to decide which knowledge documents apply where, across:
- a project and its repos
- individual Claude / terminal sessions
- as **reference context** (read by Claude) vs. as the **startup prompt** (sent as the first message)

The current `StartupPromptPanel` (per-repo dropdowns in the project header) is clunky, doesn't scale to many-repo projects, mixes concerns, and isn't discoverable.

## Goals / ideas to explore
- Keep the KB as a plain document store; make assignment a separate, clear layer.
- Allow assigning documents to projects, repos, and standalone terminal sessions.
- Clearly distinguish reference context from startup prompt.
- Decide where assignment lives (KB page vs Projects vs per-session) and whether "global default + overrides" is the right mental model.
- Minimal UI, but discoverable.

## Acceptance criteria
- An agreed, documented UX for assigning documents -> projects / repos / sessions.
- Replaces the interim `StartupPromptPanel` approach.
- Tests for the resolution logic.

## References (interim implementation to revisit/replace)
- `src/screens/projects/StartupPromptPanel.tsx`
- `src/lib/startupPrompt.ts`, `src/lib/documents.ts`
- startup-prompt fields + `triageStartProject` in `src/store/index.ts`
- delivery in `src/components/pane/views/TerminalView.tsx`

### Comments

**kevinthelago** (2026-06-01T06:16:45Z):

Superseded by #324 (document-assignment model / CONTRACT) + #325 (assignment UI in the KB page). Closing in favor of those.

---

## #140 — Rework the Knowledge Base UX

- **state:** CLOSED (NOT_PLANNED) · **labels:** enhancement, ui, scope:core, P3, stream:kb-ux
- **created:** 2026-05-27T05:05:44Z · **closed:** 2026-06-01T06:16:40Z

## Goal
Improve the Knowledge Base / Knowledge Store user experience. The exact direction is **open** — this issue is to explore and land concrete UX improvements; there's clear room.

## Current state
`src/screens/KnowledgeStore.tsx` is wired to the real unified document store (`list_documents` / `read_document` / `write_document` / `setup_kb_workspace`) and includes an embedded Claude pane (`KB_PANE_ID`) for block generation. So the plumbing works — the gap is UX.

## Areas to explore
- Discoverability + organization of blocks (search, tags/stack filters, grouping by reusable / project / repo).
- The edit/preview flow and the embedded-console generation flow.
- How blocks get **assigned** to projects/sessions (overlaps with the items below).
- Empty/first-run states and guidance.

## Related
- #51 — Rethink UX for assigning knowledge documents to projects & Claude sessions.
- #32 — Knowledge Store: T-layout with embedded Claude console for block generation.

Acceptance: a concrete, agreed set of UX changes (likely a short design pass first), implemented with tests where logic changes.

### Comments

**kevinthelago** (2026-06-01T06:16:39Z):

Superseded by the concrete kb-ux stream (#320-#326), which decomposes the Knowledge Base UX rework into agent-ready issues under v0.6.0. Closing in favor of those.

---

## #212 — Epic: Knowledge Store

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, scope:core, P2, stream:kb-ux
- **created:** 2026-05-29T23:49:55Z · **closed:** 2026-06-03T20:55:16Z

Tracking epic — Knowledge Store UX and authoring. See sub-issues.

### Sub-issues
- [ ] #320 -- KB list: tag/stack filters + grouping by kind
- [ ] #321 -- KB list: full-text search across block title + body
- [ ] #322 -- KB edit/preview + embedded-generation flow polish
- [ ] #323 -- KB empty / first-run states + setup guidance
- [ ] #324 -- Document-assignment model: reference-context vs startup-prompt cascade (CONTRACT)
- [ ] #325 -- Assignment UI in the KB page (replace StartupPromptPanel mental model)
- [ ] #326 -- Wire resolved assignments into session launch + retire StartupPromptPanel

### Comments

**kevinthelago** (2026-06-03T20:55:16Z):

Epic complete: all sub-issues #320–#326 delivered via PR #455 (KB UX rework + document-assignment model).

---

## #320 — KB list: tag/stack filters + grouping by kind

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, ui, scope:core, P3, stream:kb-ux
- **created:** 2026-05-31T17:44:17Z · **closed:** 2026-06-03T20:55:05Z

## Acceptance criteria
- [ ] KB list can filter blocks by tag and by stack, in addition to the existing source filter (all/reusable/project/repo)
- [ ] blocks are visually grouped under reusable / project / repo headers
- [ ] filter + group logic lives in pure functions in documents.ts with unit tests
- [ ] no regression to list_documents/read_document rendering

## Owns
- `src/lib/documents.ts`
- `src/screens/KnowledgeStore.tsx`

---
_Auto-generated by the base-studio-code planner._

### Comments

**kevinthelago** (2026-06-03T20:55:04Z):

Delivered by PR #455 (squash 4d26a9e on develop). develop-merges don't auto-close, closing manually.

---

## #321 — KB list: full-text search across block title + body

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, ui, scope:core, P3, stream:kb-ux
- **created:** 2026-05-31T17:44:17Z · **closed:** 2026-06-03T20:55:06Z

## Acceptance criteria
- [ ] search box filters blocks by case-insensitive substring over title and body
- [ ] search composes with the active tag/stack/source filters
- [ ] input is debounced; search predicate unit-tested in documents.ts

## Owns
- `src/lib/documents.ts`
- `src/screens/KnowledgeStore.tsx`

## Depends on
- KB1

---
_Auto-generated by the base-studio-code planner._

### Comments

**kevinthelago** (2026-06-03T20:55:06Z):

Delivered by PR #455 (squash 4d26a9e on develop). develop-merges don't auto-close, closing manually.

---

## #322 — KB edit/preview + embedded-generation flow polish

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, ui, scope:core, P3, stream:kb-ux
- **created:** 2026-05-31T17:44:18Z · **closed:** 2026-06-03T20:55:08Z

## Acceptance criteria
- [ ] clear edit <-> preview toggle with an unsaved-changes guard before navigating away
- [ ] KbConsole generation output lands into the editor/preview for the active block
- [ ] markdown preview continues to render via ReactMarkdown; write_document path unchanged

## Owns
- `src/screens/KnowledgeStore.tsx`
- `src/components/kb/KbConsole.tsx`

---
_Auto-generated by the base-studio-code planner._

### Comments

**kevinthelago** (2026-06-03T20:55:07Z):

Delivered by PR #455 (squash 4d26a9e on develop). develop-merges don't auto-close, closing manually.

---

## #323 — KB empty / first-run states + setup guidance

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, ui, scope:core, P3, stream:kb-ux
- **created:** 2026-05-31T17:44:19Z · **closed:** 2026-06-03T20:55:09Z

## Acceptance criteria
- [ ] empty state when no documents exist, with a CTA to create or generate a block
- [ ] first-run guidance invokes setup_kb_workspace when the workspace is absent
- [ ] per-filter empty states (e.g. no repo docs) render distinct copy

## Owns
- `src/screens/KnowledgeStore.tsx`
- `src/components/kb/**`

## Depends on
- KB3

---
_Auto-generated by the base-studio-code planner._

### Comments

**kevinthelago** (2026-06-03T20:55:09Z):

Delivered by PR #455 (squash 4d26a9e on develop). develop-merges don't auto-close, closing manually.

---

## #324 — Document-assignment model: reference-context vs startup-prompt cascade (CONTRACT)

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, scope:core, P2, stream:kb-ux
- **created:** 2026-05-31T17:44:20Z · **closed:** 2026-06-03T20:55:11Z

## Acceptance criteria
- [ ] new src/lib/assignments.ts resolves which documents apply for a scope as (a) reference context and (b) startup prompt, as distinct fields
- [ ] resolution cascades global default -> project -> repo -> session with explicit override semantics
- [ ] pure resolution functions with unit tests; supersedes resolveStartupPromptDoc in startupPrompt.ts
- [ ] documented mental model (global default + overrides) in the module header

## Owns
- `src/lib/assignments.ts`

---
_Auto-generated by the base-studio-code planner._

### Comments

**kevinthelago** (2026-06-03T20:55:10Z):

Delivered by PR #455 (squash 4d26a9e on develop). develop-merges don't auto-close, closing manually.

---

## #325 — Assignment UI in the KB page (replace StartupPromptPanel mental model)

- **state:** CLOSED (COMPLETED) · **labels:** enhancement, ui, scope:core, P2, stream:kb-ux
- **created:** 2026-05-31T17:44:21Z · **closed:** 2026-06-03T20:55:12Z

## Acceptance criteria
- [ ] per-document affordance in the KB page to assign a block to project / repo / session
- [ ] assignment distinguishes reference context from startup prompt
- [ ] reads/writes via the KB5 assignments module; discoverable, minimal UI
- [ ] scales to many-repo projects (no per-repo dropdown stack)

## Owns
- `src/screens/KnowledgeStore.tsx`
- `src/components/kb/**`

## Depends on
- KB5

---
_Auto-generated by the base-studio-code planner._

### Comments

**kevinthelago** (2026-06-03T20:55:12Z):

Delivered by PR #455 (squash 4d26a9e on develop). develop-merges don't auto-close, closing manually.

---


## #1016 — Context screen — a transparency inspector for Claude's context hierarchy (revive Knowledge Store)

- **state:** CLOSED (COMPLETED) · **labels:** ui, feature
- **created:** 2026-06-21T08:34:57Z · **closed:** 2026-06-26T00:11:00Z

## Summary
Bring back a top-level **Context** screen (the old Knowledge Store, reframed). Instead of just KB blocks, make it a **transparency inspector**: surface, top-down, the full hierarchy of everything the assistant reads — from global rules to the live session — so the user can see *what the assistant knows and where each fact comes from*. Today this is scattered across files the user never sees (the "where are you getting the workflow rules?" problem). The **memory layer is the centerpiece** — it's the dynamic, learned layer the assistant writes to as it works, and it should be visible + curatable rather than a hidden side effect.

## The hierarchy (layer → source)
| Layer | Source | Editable? |
|---|---|---|
| **Global instructions** | `~/.claude/CLAUDE.md` | phase 2 |
| **Project instructions** | repo `CLAUDE.md` | phase 2 |
| **Memory** ⭐ | `~/.claude/projects/<proj>/memory/` — `MEMORY.md` index + one-fact `*.md` files (frontmatter: `name`, `description`, `metadata.type` = user·feedback·project·reference; body w/ `[[links]]`) | phase 2 |
| **Knowledge / Skills** | the existing KB blocks (`kbBlocks`) + Skills library (the old Knowledge Store content) | phase 2 |
| **Plan context** | the active project's plan.db (features/issues/phases/repos) + plan section files + planner spec | read-only |
| **Session** | live conversation + what's been auto-summarized into context | read-only |

## Scope
**MVP — read-only inspector:**
- New Rail entry + screen (revive the removed `knowledge` route — see `onRehydrateStorage`'s `activeScreen === "knowledge"` redirect; remove that redirect).
- A layer rail (global → session, ordered = precedence) + a main pane with per-layer renderers; a top "context map" overview (counts + precedence at a glance); global search across layers.
- Per-layer reads via Tauri commands: global/project `CLAUDE.md`, list+read the **memory** dir (parse frontmatter), KB blocks/Skills (store), plan.db (`plan_list_features`/`plan_list_issues`/`plan_list_repos` + `read_plan_sections`), session summary.
- The **Memory** view is the hero: cards grouped by type (user/feedback/project/reference), each showing name · type chip · description · expandable body · `[[linked]]` chips · source filename.

**Phase 2 — editing (clearly distinct mode):**
- Add/edit/delete a **memory** file; edit **CLAUDE.md** (global/project); edit **KB blocks/Skills** from the UI. "You're editing the assistant's instructions" should feel deliberate (mode toggle / distinct accent). Session + plan layers stay read-only.

## Acceptance criteria
- [ ] A `Context` screen exists in the Rail; the old `knowledge` redirect is removed.
- [ ] Each layer renders its real source (CLAUDE.md files, memory dir, KB/Skills, plan.db + sections, session), each item showing its source path.
- [ ] The Memory layer lists every memory grouped by type, with body + `[[links]]`, sourced from disk.
- [ ] Search resolves "where does X come from" across layers.
- [ ] Read-only MVP ships first; editing is a separate, clearly-gated phase.
- [ ] Tests: the per-layer readers + the memory frontmatter parser + the screen render/interaction.

## Design
Kickoff prompt authored for Claude Design (transparency inspector, layer rail + per-layer renderers, memory hero view, read-only vs edit states, app design tokens). Implement against the resulting `.dc.html`.

## Notes
- The old Knowledge Store screen was removed; KB blocks (`kbBlocks`) + the Skills library still live in the store — they become the "Knowledge / Skills" layer here.
- Pairs with the active memory system (the assistant already writes memories like "skip CI waits, merge fast"): this screen is how the user sees + curates what it has learned.

### Comments

**kevinthelago** (2026-06-26T00:11:00Z):

Closing — this was an attempt to revive the old Knowledge Store screen (reframed as a context-transparency inspector), which is legacy direction we're not pursuing. The 'knowledge' route stays removed (the redirect at src/store/index.ts stays). Memory/KB/Skills curation, if revisited, will come through current surfaces rather than a revived top-level screen.

---
