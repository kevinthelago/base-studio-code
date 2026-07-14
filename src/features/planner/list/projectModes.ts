// The Projects screen's page modes (#1876) — a pure, React-free data module so both the screen
// (`features/planner/index.tsx`) and its tests share one source of truth. Drives the shared
// <Screen> tab bar: each mode can be torn off into its own window (#430/#463).

import type { TabItem } from "@/app/chrome/TabBar";

export const PROJECT_MODES: TabItem[] = [
  { id: "projects",   label: "Projects",    hint: "plan a project" },
  // Fleet analytics was folded into Glance (#2223/#2228) — the workspace mission-control home for the
  // live orchestration dashboard — so a separate Projects tab was redundant.
  // The standalone Personas tab was folded into Org (#2199): a persona is edited in the Org inspector
  // (PersonaEditor) as the identity behind a position, so a separate library tab was redundant.
  // The persona-relationship graph — your AI agent TEAM: personas as positions, wired by relationship
  // archetypes, grouped by department. The tab id is "teams" to match the label (#2700; a persist
  // migration maps the former "org" id forward).
  { id: "teams",      label: "Teams",       hint: "your agent teams — personas as positions, wired into a relationship graph" },
  // The Design Studio was a standalone rail Workspace; it's a single page, so it folded in here as a
  // Planner tab (its own rail destination was removed). Labelled "Components" (#2818) — it owns the
  // kit/component (STRUCTURE) axis AND, since #2834, the THEME (STYLE) axis via its in-place theme
  // try-on preview (right-pane themes menu + palette + big preview), so the standalone "Themes" tab was
  // retired (#2850). The tab id STAYS "designs" (the internal feature name), so tear-off + persistence are unaffected.
  { id: "designs",    label: "Components",  hint: "the kit & component workbench — structure + the theme try-on" },
  // The Algorithms knowledge graph (#2760/#2761) — a single read-only page, so it folded in here as a
  // Planner tab (its own rail destination was removed, #2785), like Designs/Themes.
  { id: "algorithms", label: "Algorithms",  hint: "the algorithms knowledge graph — concepts, structures, and how they relate" },
  // The Sounds library (#3072, epic #3071) — the synthesis-first audio pillar, structured like
  // Components/Algorithms: a kit of live-synthesized cues. A no-PTY page (like Teams), folded in here.
  { id: "sounds",     label: "Sounds",      hint: "the sound library — synthesized UI cues, organized into kits" },
];
