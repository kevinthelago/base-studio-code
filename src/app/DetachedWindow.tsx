import { useState, Suspense } from "react";
import { useAppStore } from "@/store";
import { Titlebar } from "@/app/chrome/Titlebar";
import { DetachedTabStrip } from "./DetachedTabStrip";
import { ConsoleGraphHost } from "@/app/console/ConsoleGraphHost";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { detachedTabId, detachedSection } from "@/app/console/lib/detachWindow";
import { StudioSessionHosts } from "@/features/studio-sessions";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import {
  GitHubWorkspace, AutomationsWorkspace, McpWorkspace, ProjectsWorkspace,
  SkillsWorkspace, SecurityWorkspace, WorkspaceFallback,
} from "./lazyWorkspaces";

// Render a detached page's section. A switch over literal cases (not a dynamic
// lookup keyed by the URL-supplied `page`) so there's no user-controlled dispatch.
function renderDetachedSection(page: string, section: string): React.ReactNode {
  switch (page) {
    case "automations": return <AutomationsWorkspace pageOverride={section} />;
    case "skills":      return <SkillsWorkspace pageOverride={section} />;
    case "mcp":         return <McpWorkspace pageOverride={section} />;
    case "security":      return <SecurityWorkspace pageOverride={section} />;
    case "github":      return <GitHubWorkspace pageOverride={section} />;
    case "projects":    return <ProjectsWorkspace pageOverride={section} />;
    default:
      return (
        <Text as="div" mono tone="dim" style={{ padding: 24 }}>
          Unknown detached page: {page}
        </Text>
      );
  }
}

/** True when this window was opened as a detached tab/section (a tear-off, #430/#463). */
export function isDetachedWindow(): boolean {
  return detachedTabId() !== null || detachedSection() !== null;
}

/**
 * The minimal-chrome window rendered for a tear-off (#430/#463): either a detached page-section
 * (?detach=<page>&section=<id>) or a single console tab (?detachTab=<id>) — no rail/tabstrip, just
 * a titlebar + the one surface. Only mounted when isDetachedWindow() (computed once per window load).
 */
export function DetachedWindow() {
  const [detachId] = useState(() => detachedTabId());
  const [detSection] = useState(() => detachedSection());
  const tabs = useAppStore((s) => s.tabs);
  const hasHydrated = useAppStore((s) => s.hasHydrated);

  // Detached page-section window: minimal chrome, just that page's section. Like the detached TAB window
  // below it needs its OWN <TerminalHost> (#2378) — a torn-off Design/Algorithms studio docks a
  // <TerminalSlot> (#3357), which is inert without a host ancestor — plus the studio session hosts, since
  // this window is the SOLE owner of that studio's terminal while it is torn off (the main window skips it,
  // see `studioDetached`).
  if (detSection) {
    return (
      <TerminalHost>
      <Box className="app">
        {/* #3919: the browser model — this window carries its tab, and dragging it off the strip
            docks the page back into the main window. */}
        <DetachedTabStrip page={detSection.page} section={detSection.section} label={detSection.section} />
        <Box className="shell">
          <Box className="main">
            <Box className="page">
              {hasHydrated && <Suspense fallback={<WorkspaceFallback />}>{renderDetachedSection(detSection.page, detSection.section)}</Suspense>}
            </Box>
          </Box>
        </Box>
      </Box>
      <StudioSessionHosts />
      </TerminalHost>
    );
  }

  // Detached tab window: minimal chrome (no rail/tabstrip), just this tab's console. This is a separate
  // window/React root reconnecting to the same backend PTYs, so it needs its OWN TerminalHost (#2378) —
  // its console cells drop TerminalSlots, and without a host ancestor they'd be inert (no terminal).
  const detachIdx = detachId !== null ? tabs.findIndex((t) => t.id === detachId) : -1;
  return (
    <TerminalHost>
    <Box className="app">
      <Titlebar workspace={detachIdx >= 0 ? (tabs[detachIdx]?.name ?? "Console") : "Console"} />
      <Box className="shell">
        <Box className="main">
          <Box className="page">
            {hasHydrated && detachIdx >= 0 && (
              <Stack style={{ flex: 1, minHeight: 0 }}>
                <ConsoleGraphHost tabIdxOverride={detachIdx} />
              </Stack>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
    </TerminalHost>
  );
}
