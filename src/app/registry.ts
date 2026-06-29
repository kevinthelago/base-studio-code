// Canonical Workspace registry — the SINGLE source of truth for each top-level Workspace's key,
// display name, and rail icon (a Workspace = a rail destination; see docs/frontend-structure.md).
// The left-nav rail AND the titlebar position crumb both read from here, so a Workspace is named in
// exactly ONE place and the two can never drift: add a Workspace here and it's labeled everywhere
// (rail tooltip + the "you are here" titlebar). Previously the rail's NAV array and App's titlebar
// switch each hardcoded the names independently. (#nav-pass; Screen → Workspace rename #1879)

import { TerminalSquare, Zap, Server, GitFork, FolderKanban, ShieldCheck, Sparkles, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Every top-level Workspace key (a rail destination). The store's `activeWorkspace` is one of these. */
export type Workspace = "console" | "automation" | "mcp" | "github" | "projects" | "skills" | "agents" | "settings";

export interface WorkspaceMeta {
  key: Workspace;
  /** The page's display name — the rail tooltip AND the titlebar position crumb. */
  label: string;
  Icon: LucideIcon;
}

/** Rail order is product-defined (#872) and locked by rail.test.tsx; the titlebar reads the
 *  same labels. Adding a screen is one entry here. */
export const WORKSPACES: WorkspaceMeta[] = [
  { key: "console",    label: "Console",     Icon: TerminalSquare },
  { key: "projects",   label: "Projects",    Icon: FolderKanban },
  { key: "skills",     label: "Skills",      Icon: Sparkles },
  { key: "automation", label: "Automations", Icon: Zap },
  { key: "mcp",        label: "MCP",         Icon: Server },
  { key: "github",     label: "GitHub",      Icon: GitFork },
  { key: "agents",     label: "Security",    Icon: ShieldCheck },
  { key: "settings",   label: "Settings",    Icon: Settings },
];

const BY_KEY = Object.fromEntries(WORKSPACES.map((s) => [s.key, s])) as Record<Workspace, WorkspaceMeta>;

/** The canonical display name for a Workspace — the rail tooltip and the titlebar position crumb.
 *  Falls back to the raw key for an unknown Workspace so an unmapped page is still visibly labeled
 *  (never blank). */
export function workspaceLabel(key: Workspace): string {
  return BY_KEY[key]?.label ?? key;
}
