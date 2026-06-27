import { useAppStore } from "@/store";
import { GeneralScreen } from "./screens/GeneralScreen";
import { GithubScreen } from "./screens/GithubScreen";
import { SecurityScreen } from "./screens/SecurityScreen";
import { PlannerScreen } from "./screens/PlannerScreen";
import { SkillsScreen as SkillsSettingsScreen } from "./screens/SkillsScreen";
import { AutomationsScreen } from "./screens/AutomationsScreen";
import { McpScreen } from "./screens/McpScreen";

// The settings sections — the SINGLE source for the nav, the known-section guard, and the rendered
// screen, so the three can't drift. Grouped by app area (mirrors the rail).
const SECTIONS = [
  { k: "general",     label: "General",     Screen: GeneralScreen },
  { k: "planner",     label: "Planner",     Screen: PlannerScreen },
  { k: "skills",      label: "Skills",      Screen: SkillsSettingsScreen },
  { k: "automations", label: "Automations", Screen: AutomationsScreen },
  { k: "mcp",         label: "MCP",         Screen: McpScreen },
  { k: "github",      label: "GitHub",      Screen: GithubScreen },
  { k: "security",    label: "Security",    Screen: SecurityScreen },
] as const;

export function SettingsScreen() {
  const { settingsSection, setSettingsSection } = useAppStore();
  const active = SECTIONS.find((s) => s.k === settingsSection) ?? SECTIONS[0];

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <aside style={{
        width: 200, flex: "0 0 200px", background: "var(--bg-panel)",
        borderRight: "1px solid var(--border-soft)", padding: "16px 8px",
        display: "flex", flexDirection: "column", gap: 2,
      }}>
        <div style={{
          fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em",
          color: "var(--fg-dim)", padding: "4px 12px 10px",
        }}>SETTINGS</div>
        {SECTIONS.map(it => {
          const on = it.k === active.k;
          return (
            <div key={it.k} onClick={() => setSettingsSection(it.k)} style={{
              padding: "7px 12px", borderRadius: 6,
              fontFamily: "var(--mono)", fontSize: 11.5,
              background: on ? "var(--bg-elev)" : "transparent",
              color: on ? "var(--fg)" : "var(--fg-muted)",
              cursor: "pointer",
              borderLeft: on ? "2px solid var(--accent)" : "2px solid transparent",
              paddingLeft: on ? 10 : 12,
            }}>{it.label}</div>
          );
        })}
      </aside>
      <section style={{ flex: 1, padding: 24, overflow: "auto", minWidth: 0 }}>
        <active.Screen />
      </section>
    </div>
  );
}
