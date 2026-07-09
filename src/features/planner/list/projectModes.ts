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
  // archetypes, grouped by department. Labelled "Teams" (human-readable) over the opaque "Org"; the tab
  // id stays "org" so the store key / persist migration / graph state are untouched.
  { id: "org",        label: "Teams",       hint: "your agent teams — personas as positions, wired into a relationship graph" },
  // The Design Studio was a standalone rail Workspace; it's a single page, so it folded in here as a
  // Planner tab (its own rail destination was removed). Labelled "Designs" — it owns the kit/component
  // (STRUCTURE) axis; the THEME (STYLE) axis lives in its own "Themes" tab below (epic #2606).
  { id: "design",     label: "Designs",     hint: "the kit & component workbench (the structure axis)" },
  { id: "themes",     label: "Themes",      hint: "the theme collection — palettes of token overrides (the style axis)" },
];
