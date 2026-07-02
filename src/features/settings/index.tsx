import { useAppStore } from "@/store";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { GeneralPage } from "./pages/GeneralPage";
import { GithubPage } from "./pages/GithubPage";
import { SecurityPage } from "./pages/SecurityPage";
import { PlannerPage } from "./pages/PlannerPage";
import { SkillsPage as SkillsSettingsPage } from "./pages/SkillsPage";
import { AutomationsPage } from "./pages/AutomationsPage";
import { McpPage } from "./pages/McpPage";

// The settings sections — the SINGLE source for the nav, the known-section guard, and the rendered
// Page, so the three can't drift. Grouped by app area (mirrors the rail). Each section's body is a
// Page (the L3 content the Settings Workspace shows one at a time; see docs/frontend-structure.md).
const SECTIONS = [
  { k: "general",     label: "General",     Page: GeneralPage },
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
    <Row align="stretch" style={{ flex: 1, minHeight: 0 }}>
      <Box as="aside" style={{
        width: 200, flex: "0 0 200px", background: "var(--bg-panel)",
        borderRight: "1px solid var(--border-soft)", padding: "16px 8px",
        display: "flex", flexDirection: "column", gap: 2,
      }}>
        <Text as="div" mono size={10} tone="dim" style={{
          letterSpacing: ".08em", padding: "4px 12px 10px",
        }}>SETTINGS</Text>
        {SECTIONS.map(it => {
          const on = it.k === active.k;
          return (
            <Box key={it.k} className="mono" onClick={() => setSettingsSection(it.k)} style={{
              padding: "7px 12px", borderRadius: 6,
              fontSize: 11.5,
              background: on ? "var(--bg-elev)" : "transparent",
              color: on ? "var(--fg)" : "var(--fg-muted)",
              cursor: "pointer",
              borderLeft: on ? "2px solid var(--accent)" : "2px solid transparent",
              paddingLeft: on ? 10 : 12,
            }}>{it.label}</Box>
          );
        })}
      </Box>
      <Box as="section" style={{ flex: 1, padding: 24, overflow: "auto", minWidth: 0 }}>
        <active.Page />
      </Box>
    </Row>
  );
}
