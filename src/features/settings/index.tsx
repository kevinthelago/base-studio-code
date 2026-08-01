import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { MasterDetail } from "@/shared/ui/layouts/MasterDetail";
import { GeneralPage } from "./pages/GeneralPage";
import { AccessibilityPage } from "./pages/AccessibilityPage";
import { GithubPage } from "./pages/GithubPage";
import { SecurityPage } from "./pages/SecurityPage";
import { PlannerPage } from "./pages/PlannerPage";
import { SkillsPage as SkillsSettingsPage } from "./pages/SkillsPage";
import { AutomationsPage } from "./pages/AutomationsPage";
import { McpPage } from "./pages/McpPage";

// #1545: public API for the app shell — appearance tokens + the keybinding/hotkey model the shell's
// boot + hotkey hooks consume (through this barrel, not settings internals).
export { accentVars } from "./lib/appearance";
export { SCREEN_HOTKEYS } from "./lib/shortcuts";
export {
  matchesBinding, matchesChord, matchesLeader, eventToLeader, effectiveLeader,
  type RebindableId,
} from "./lib/keybindings";

// The settings sections — the SINGLE source for the nav, the known-section guard, and the rendered
// Page, so the three can't drift. Grouped by app area (mirrors the rail). Each section's body is a
// Page (the L3 content the Settings Workspace shows one at a time; see docs/frontend-structure.md).
const SECTIONS = [
  { k: "general",     label: "General",     Page: GeneralPage },
  { k: "accessibility", label: "Accessibility", Page: AccessibilityPage },
  { k: "planner",     label: "Planner",     Page: PlannerPage },
  { k: "skills",      label: "Skills",      Page: SkillsSettingsPage },
  { k: "automations", label: "Automations", Page: AutomationsPage },
  { k: "mcp",         label: "MCP",         Page: McpPage },
  { k: "github",      label: "GitHub",      Page: GithubPage },
  { k: "security",    label: "Security",    Page: SecurityPage },
] as const;

export function SettingsWorkspace() {
  const { settingsSection, setSettingsSection } = useAppStore();
  const active = SECTIONS.find((s) => s.k === settingsSection) ?? SECTIONS[0];

  return (
    // The standardized list+detail Layout (#2197). The settings nav is the rail (panel-bg escape
    // hatch); each section Page is the detail.
    <MasterDetail
      railWidth={200}
      railPad={[16, 8]}
      railStyle={{ background: "var(--bg-panel)" }}
      detailPad={24}
      rail={
        <Stack gap={2}>
          <Text as="div" mono size={10} tone="dim" style={{
            letterSpacing: ".08em", padding: "4px 12px 10px 14px",
          }}>SETTINGS</Text>
          {SECTIONS.map(it => {
            const on = it.k === active.k;
            return (
              <Box key={it.k} className="mono" onClick={() => setSettingsSection(it.k)} bg={on ? "var(--bg-elev)" : "transparent"} radius={6} style={{
                padding: "7px 12px 7px 14px",
                fontSize: 11.5,
                color: on ? "var(--fg)" : "var(--fg-muted)",
                cursor: "pointer",
              }}>{it.label}</Box>
            );
          })}
        </Stack>
      }
      detail={<active.Page />}
    />
  );
}
