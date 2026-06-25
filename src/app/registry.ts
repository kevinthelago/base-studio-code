// Canonical screen registry — the SINGLE source of truth for each top-level screen's key,
// display name, and rail icon. The left-nav rail AND the titlebar position crumb both read
// from here, so a page is named in exactly ONE place and the two can never drift: add a screen
// here and it's labeled everywhere (rail tooltip + the "you are here" titlebar). Previously the
// rail's NAV array and App's titlebar switch each hardcoded the names independently. (#nav-pass)

import { TerminalSquare, Zap, Server, GitFork, FolderKanban, ShieldCheck, Sparkles, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Every top-level screen key. The store's `activeScreen` is one of these. */
export type Screen = "console" | "automation" | "mcp" | "github" | "projects" | "skills" | "agents" | "settings";

export interface ScreenMeta {
  key: Screen;
  /** The page's display name — the rail tooltip AND the titlebar position crumb. */
  label: string;
  Icon: LucideIcon;
}

/** Rail order is product-defined (#872) and locked by rail.test.tsx; the titlebar reads the
 *  same labels. Adding a screen is one entry here. */
export const SCREENS: ScreenMeta[] = [
  { key: "console",    label: "Console",     Icon: TerminalSquare },
  { key: "projects",   label: "Projects",    Icon: FolderKanban },
  { key: "skills",     label: "Skills",      Icon: Sparkles },
  { key: "github",     label: "GitHub",      Icon: GitFork },
  { key: "agents",     label: "Permissions", Icon: ShieldCheck },
  { key: "mcp",        label: "MCP",         Icon: Server },
  { key: "automation", label: "Automations", Icon: Zap },
  { key: "settings",   label: "Settings",    Icon: Settings },
];

const BY_KEY = Object.fromEntries(SCREENS.map((s) => [s.key, s])) as Record<Screen, ScreenMeta>;

/** The canonical display name for a screen — the rail tooltip and the titlebar position crumb.
 *  Falls back to the raw key for an unknown screen so an unmapped page is still visibly labeled
 *  (never blank). */
export function screenLabel(key: Screen): string {
  return BY_KEY[key]?.label ?? key;
}
