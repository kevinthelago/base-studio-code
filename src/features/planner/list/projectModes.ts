// The Projects screen's page modes (#1876) — a pure, React-free data module so both the screen
// (`features/planner/index.tsx`) and its tests share one source of truth. Drives the shared
// <Screen> tab bar: each mode can be torn off into its own window (#430/#463).

import type { TabItem } from "@/app/chrome/TabBar";

export const PROJECT_MODES: TabItem[] = [
  { id: "projects",   label: "Projects",    hint: "plan a project" },
  { id: "fleet",      label: "Fleet",       hint: "live orchestration" },
  // The standalone Personas tab was folded into Org (#2199): a persona is edited in the Org inspector
  // (PersonaEditor) as the identity behind a position, so a separate library tab was redundant.
  { id: "org",        label: "Org",         hint: "personas as positions, wired into a relationship graph" },
];
