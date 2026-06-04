import { useAppStore } from "../../store";
import { GeneralSettings } from "./General";
import { AppearanceSettings } from "./Appearance";
import { GitHubSettings } from "./GitHub";
import { IntegrationsSettings } from "./Integrations";
import { AgentsSettings } from "./Agents";
import { ClaudeConfigSettings } from "./ClaudeConfig";
import { TunnelSettings } from "./Tunnel";
import { DeveloperSettings } from "./Developer";
import { AchievementsSettings } from "./Achievements";
import { DiagnosticsSettings } from "./Diagnostics";

const NAV_ITEMS = [
  { k: "general",       label: "General"        },
  { k: "github",        label: "GitHub"          },
  { k: "integrations",  label: "Integrations"    },
  { k: "agents",        label: "Agents"          },
  { k: "claude-config", label: "Claude Config"   },
  { k: "tunnel",        label: "Mobile Tunnel"   },
  { k: "diagnostics",   label: "Diagnostics"     },
  { k: "appearance",    label: "Appearance"      },
  { k: "keyboard",      label: "Keyboard"        },
  { k: "advanced",      label: "Advanced"        },
  { k: "developer",     label: "Developer"       },
  { k: "achievements",  label: "Achievements"    },
];

export function SettingsScreen() {
  const { settingsSection, setSettingsSection } = useAppStore();

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
          {NAV_ITEMS.map(it => {
            const on = it.k === settingsSection;
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
          {settingsSection === "general"       && <GeneralSettings />}
          {settingsSection === "appearance"    && <AppearanceSettings />}
          {settingsSection === "github"        && <GitHubSettings />}
          {settingsSection === "integrations"  && <IntegrationsSettings />}
          {settingsSection === "agents"        && <AgentsSettings />}
          {settingsSection === "claude-config" && <ClaudeConfigSettings />}
          {settingsSection === "tunnel"        && <TunnelSettings />}
          {settingsSection === "diagnostics"  && <DiagnosticsSettings />}
          {settingsSection === "developer"    && <DeveloperSettings />}
          {settingsSection === "achievements" && <AchievementsSettings />}
          {settingsSection !== "general" && settingsSection !== "appearance" && settingsSection !== "github" && settingsSection !== "integrations" && settingsSection !== "agents" && settingsSection !== "claude-config" && settingsSection !== "tunnel" && settingsSection !== "diagnostics" && settingsSection !== "developer" && settingsSection !== "achievements" && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              height: "100%", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)",
            }}>{settingsSection} · coming soon</div>
          )}
        </section>
    </div>
  );
}
