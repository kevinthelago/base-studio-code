// The Projects screen's page modes (#1876) — a pure, React-free data module so both the screen
// (`features/planner/index.tsx`) and its tests share one source of truth. Drives the shared
// <Screen> tab bar: each mode can be torn off into its own window (#430/#463).

import type { TabItem } from "@/app/chrome/TabBar";

export const PROJECT_MODES: TabItem[] = [
  { id: "projects",   label: "Planner",     hint: "plan a project" },
  { id: "fleet",      label: "Fleet",       hint: "live orchestration" },
  { id: "dataModels", label: "Data Models", hint: "canonical schemas" },
];
