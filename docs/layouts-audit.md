# Layouts audit — every page against the template set

Part of the Layouts tier (epic #2197, tracking issue #2213). The shared page-skeleton templates
built in slices 1–2 are:

| Template | File | Shape |
|---|---|---|
| **MasterDetail** (#2198/#2209) | `src/shared/ui/layouts/MasterDetail.tsx` | fixed/resizable **rail** (list/nav) + flex **detail**, optional toolbar |
| **SplitView** (#2197 s2) | `src/shared/ui/layouts/SplitView.tsx` | flex **primary** + fixed, resizable **secondary** (trailing), optional toolbar |
| **GraphCanvas** (#2208) | `src/shared/ui/layouts/GraphCanvas.tsx` | toolbar + optional rail + pan/zoom **canvas** + optional inspector |
| **PaneGrid** (#2197 s2) | `src/shared/ui/layouts/PaneGrid.tsx` | CSS-grid of N equal panes (the console); `hidden` keeps a grid mounted display:none |
| **Tree** (#2476) | `src/shared/ui/layouts/Tree.tsx` | tree-shaped data, one recursive `nodes` prop, two variants — **indented** (collapsible depth-indented rows in a MasterDetail rail + detail panel, for deep/navigational trees) and **layered** (top-down org-chart on the shared graph stack: `layoutTree` = layerDag + orderLayers, shared edge grammar, GraphCanvas pan/zoom) |

The initial sweep found the epic's page inventory was aspirational — most non-list pages are a
different shape. This doc is the page-by-page decision table: current shape → decision → one-line
justification. Every top-level workspace/page has a recorded decision; the natural template consumers
(Settings, Personas, GitHub repos, Org, Glance) are **already migrated**. The two hand-rolled
candidates the initial sweep deferred (Planner session → SplitView, Console → PaneGrid) are **now
both migrated** (this branch): the PaneGrid template was built and the Console grid moved onto it,
and the Planner session's terminal/inspector split moved onto SplitView.

## Decision table

Rail workspaces come from `src/app/registry.ts`; nested pages/tabs are indented.

| Page / surface | Entry | Current shape | Template | Decision | Justification |
|---|---|---|---|---|---|
| **Settings** | `features/settings/index.tsx` | rail (section nav) + detail Page | **MasterDetail** | on-template ✓ | Already migrated (#2197). Rail = section nav, detail = the section Page. |
| ↳ Settings leaf pages (General/Planner/Skills/Automations/MCP/GitHub/Security) | `features/settings/pages/*Page.tsx` | card-stacks | — | keep bespoke | These **are** the *detail* of Settings' MasterDetail — leaf content, not pages. Nothing to wrap. |
| **Personas** (Planner → Personas / Org inspector) | `features/personas/PersonasPanel.tsx` | rail (persona list) + detail editor | **MasterDetail** | on-template ✓ | Already migrated (#2094/#2199). |
| **Org designer** (Planner → Org) | `features/org/OrgPanel.tsx` | toolbar + rail + pan/zoom canvas + inspector | **GraphCanvas** | on-template ✓ | Already migrated (#2193/#2208). |
| **Glance → Network** | `features/glance/GlanceWorkspace.tsx` | toolbar + sidebar + pan/zoom canvas + inspector | **GraphCanvas** | on-template ✓ | Already migrated (#2206/#2223). *Scope guard: parallel work — not edited.* |
| ↳ **Glance → Fleet** | `features/glance` + `planner/fleet/Fleet` | fleet analytics dashboard | — | keep bespoke | A live-orchestration **dashboard** (StatTiles/charts), not list+detail or a graph. *Scope guard: not edited.* |
| **GitHub → Repositories** | `features/github/index.tsx` | resizable repo rail + per-repo Pulse detail | **MasterDetail** (resizable) | on-template ✓ | Already migrated (#2209, `resizable`). |
| ↳ **GitHub → Summary** | `features/github/GitHubSummary.tsx` | StatTile + Grid dashboard | — | keep bespoke | Cross-repo **analytics dashboard**; no list+detail axis. |
| ↳ **GitHub → Projects** | `planner/list/ProjectsSummary.tsx` | portfolio analytics dashboard | — | keep bespoke | Portfolio **dashboard**; drills into a board (below), not a detail column. |
| ↳ GitHub board drill-in (Board/Roadmap/Issues/Insights) | `planner/github/*` | full-page board views | — | keep bespoke | Full-bleed board takeovers with their own header + sub-tabs; not a template shape. |
| **Planner session** | `features/planner/session/Planning.tsx` | terminal (primary) + resizable sections aside | **SplitView** | on-template ✓ | Migrated (#2197 s2, this branch): terminal = `primary`, plan-sections/publish panel = the resizable-invert `secondary` (secondarySize 430 / min 300 / max 760), the local `sectionsPanel` `useDragResize` retired into the template; the top divider seam kept via SplitView's `style` escape hatch. A pure structural wrapper swap — no plan/gate logic touched, full planner hook suite green. |
| **Planner → Projects list** | `planner/list/ProjectsList.tsx` | projects grid + blueprint-library rail + published section | — | keep bespoke | A list/library **hybrid** (multiple sections + a blueprint rail), not a single list+detail axis. |
| **Console** | `app/console/index.tsx` (`ConsoleWorkspace`) | CSS-grid of N PTY panes | **PaneGrid** | on-template ✓ | Migrated (#2197 s2, this branch): the PaneGrid template was built and the per-tab grid moved onto it (`className="console-grid"` kept, `cols`/`rows` from `tab.layout`, `hidden={!active}` for the cross-tab display:none mount, fullscreen → 1×1). The cross-tab mount test suite stays green (stable grid nodes across switch). |
| **Skills** | `features/skills/index.tsx` | digest + command bar + facet rail + main list + overlay drawer | — | keep bespoke | **Faceted browser**: rail = filters (not a list), detail = slide-over `Pane` drawer (not a detail column), multi-row toolbar (digest + command bar). Doesn't fit MasterDetail. Candidate `FacetedList` if the pattern recurs (currently 1×). |
| **Design Studio** | `features/components/DesignStudio.tsx` | toolbar + resizable rail + flip (Library/Graph) center + resizable inspector | — | keep bespoke | 3-pane IDE workbench with **two** resizable edges; the center **flips** between a non-canvas Library view and a graph, so GraphCanvas (always-a-canvas) doesn't fit and two resizable edges exceed MasterDetail/SplitView. Reuses `useGraphViewport`/`useDragResize`/`layerDag` directly. |
| **Automations** | `features/automations/index.tsx` | tabbed Screen (Schedules/History/Hooks/Analytics) + slide-over `Pane` | — | keep bespoke | Tabbed page + slide-over drawer; already sits on the shared `Screen` + `Pane` + `useDraft` primitives. |
| ↳ **Hooks** (embedded in Automations) | `features/mcp` `HooksView` | list + catalog + slide-over `Pane` | — | keep bespoke | Same tab-body + drawer pattern; shares `Pane`/`useDraft`. |
| **MCP** | `features/mcp/index.tsx` | tabbed Screen (Installed/Catalog/Analytics) + slide-over `Pane` | — | keep bespoke | Tabbed + install/version machinery + drawer; on the shared `Screen`/`Pane`/`useDraft` primitives. |
| **Security (Agents)** | `features/agents/index.tsx` | tabbed Screen (Profiles/Assignments/Activity/Flow) | — | keep bespoke | A multi-tab page, not one list+detail axis. |
| ↳ Security → Profiles tab | `features/agents/ProfilesTab.tsx` | `.prof-list` + `.prof-detail` (CSS list+detail) | (MasterDetail-shaped) | keep bespoke | The tab body *is* list+detail, but it's a nested sub-tab with its own CSS grid; low-value to wrap and Security is tabbed. Noted as a nested candidate. |
| **Tunnel** | `features/tunnel/Tunnel.tsx` | card-stack | — | keep bespoke | Not a top-level page — a leaf card-stack rendered inside Settings → Planner. Leaf, not a page. |

## Summary

- **On an existing template (migrated): 7** — Settings, Personas, GitHub Repositories, Org, Glance Network (earlier passes) + Planner session (→ SplitView) and Console (→ the new PaneGrid), both migrated on this branch.
- **Migrated on this branch: 2** — the `PaneGrid` template was built (`shared/ui/layouts/PaneGrid.tsx` + tests) and the Console grid moved onto it; the Planner session's terminal/inspector split moved onto `SplitView` (with a `style` root escape hatch added for the divider seam). Both preserve behaviour — the full console + planner + `shared/ui/layouts` suites stay green.
- **Migrate-candidates (deferred): 0** — the two the sweep flagged are now done.
- **Kept bespoke (justified): the remainder** — Skills (faceted), Design Studio (3-pane IDE), MCP / Automations / Hooks (tabbed + drawer), Security tabs, GitHub Summary/Projects/board (dashboards + full-page boards), Projects list (list/library hybrid), Glance Fleet (dashboard), Settings leaf pages + Tunnel (detail leaves, not pages).

## Recurring shapes → candidate templates (recurs 3+ → worth a template)

- **Tabbed page + slide-over `Pane` drawer** — MCP, Automations, Hooks (3×). Already unified on `Screen` + `Pane` + `useDraft`; a heavier "TabbedDrawer" template would add little over those primitives. **Watch, don't build yet.**
- **Faceted browser** (facet rail + list + overlay detail) — Skills only (1×). Revisit as `FacetedList` if a second faceted page appears.
- **3-pane workbench** (resizable rail + center + resizable inspector) — Design Studio (1×); GraphCanvas already covers the rail+canvas+inspector variant. Not yet a template.
- **Analytics dashboard** (StatTile/Grid/charts) — GitHub Summary/Projects, Glance Fleet (3×). These are composed from the shared `StatTile`/`Grid`/`charts` primitives already; the *layout* varies per dashboard, so a single skeleton wouldn't fit. **Keep composing primitives, no layout template.**

## Follow-ups (out of scope here)

1. **Planning render test** — the Planner session still has no full render smoke test (usePlannerTerminal mounts a real xterm, which jsdom can't `open`; a render test would need xterm/terminal mocked, like the console's `consoleCrossTabMount` stubs TerminalView). The SplitView migration is a pure structural wrapper swap guarded by typecheck + the planner hook suite; a mocked Planning render test remains worthwhile but is its own task.
2. **Register the templates in the introspection manifest (#2060) + the in-app gallery** — slice 3 of the epic; PaneGrid/SplitView/MasterDetail/GraphCanvas are all built now.
</content>
</invoke>
