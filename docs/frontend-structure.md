# Frontend structure & naming convention

The canonical vocabulary for the application's page structure. One word per level — no synonyms.
This is the source of truth; when a component, prop, or doc disagrees, fix it to match this.

> **The Rail switches Surfaces. A Surface is composed of a Screen that shows one Page at a time.**

## The hierarchy

```
Rail ──switches──▶ Surface ──is a──▶ Screen ──shows one──▶ Page
 (left nav)        (rail dest.)     (tabbed shell)        (tab body)
                                     └─ PageTabs (the tab strip)
```

| Level | Canonical word | What it is | Where it lives |
|---|---|---|---|
| L0 | **Rail** | The left-nav switcher. | `app/chrome/Rail.tsx` |
| L1 | **Surface** | A top-level rail destination (Console, Projects, Skills, GitHub, MCP, Automations, Permissions, Settings). The thing the Rail switches between. | `app/registry.ts` + each feature barrel |
| L2a | **Screen** | The shared **root tabbed shell** a Surface renders through: a `PageTabs` strip over one active `Page` body, in the `.screen / .screen-page / .screen-body` layout. Controlled — the Surface owns the page-tab state via `usePageTabs`. | `app/chrome/Screen.tsx` |
| L2b | **PageTabs** | The page-tab strip inside a Screen (select / reorder / tear-off). The model is `usePageTabs`; the rendering primitive is the generic `TabBar`. | `shared/hooks/usePageTabs.ts` + `app/chrome/TabBar.tsx` |
| L3 | **Page** | One tab's swappable body (e.g. Skills → Library / Lessons / Runs). A torn-off Page renders alone via the `pageOverride` prop (no `PageTabs` strip). | inside each Surface |

## Console's nested vocabulary (unchanged, now unambiguous)

The **Console** Surface does *not* render through the `Screen` shell — it has its own nested model.
These words are deliberately distinct from the L1–L3 set above:

| Console term | What it is |
|---|---|
| **Tab** | A named workspace = one CSS-grid layout of panes (the `Tabstrip`). |
| **Pane** | One grid cell — a single PTY/console session. |
| **View** | A pane's swappable body (chat / files / branches / changes / log) — `TerminalView`, `FilesView`, … |

Because L1 is **Surface** (not "Screen" or "Workspace"), Console's `Tab` / `View` no longer collide with
the page-structure words. Note the user-facing Console copy still calls a Tab a "workspace" — that is the
Console-local sense, not an L1 Surface.

## Which Surfaces use the Screen shell

| Renders through `Screen` (PageTabs + Pages) | Special-cased |
|---|---|
| Skills, MCP, GitHub, Automations, Permissions, Projects | **Console** (own Tab/Pane grid), **Settings** (own section nav) |

## Rollout status

This convention lands in two phases (the *codebase refactor & consolidation* sweep, v1.0.4 line):

- **Phase 1 — #1878 (done in this branch):** the spine. `TabbedScreen` → **`Screen`** shell; the
  `sectionOverride` prop → **`pageOverride`**; the **Page / PageTabs** vocabulary; this doc.
- **Phase 2 — #1879 (follow-up):** free the word at L1 — rename the rail destinations
  (`registry.ts` `Screen` type → **`Surface`**, `SCREENS` → `SURFACES`, store `activeScreen` →
  `activeSurface`, the `*Screen` components → `*Surface`, and the `.screen*` CSS classes →
  `.surface*`). Until Phase 2 lands, the L1 type is still literally named `Screen` in code even though
  this doc already calls the *concept* a Surface.

## Naming rules for new code

- A new top-level rail destination is a **Surface**; it renders a **`Screen`** and defines its **Pages**.
- Never reuse **Screen** for an L1 destination, **Page** for a Console View, or **Tab** for a Page.
- The page-tab state always comes from **`usePageTabs`**; don't hand-roll a tab strip.
