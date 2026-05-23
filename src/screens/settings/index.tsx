import { useAppStore } from "../../store";
import { GitHubSettings } from "./GitHub";
import { IntegrationsSettings } from "./Integrations";

const NAV_ITEMS = [
  { k: "general",      label: "General"      },
  { k: "github",       label: "GitHub"        },
  { k: "integrations", label: "Integrations"  },
  { k: "agents",       label: "Agents"        },
  { k: "appearance",   label: "Appearance"    },
  { k: "keyboard",     label: "Keyboard"      },
  { k: "advanced",     label: "Advanced"      },
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
          {settingsSection === "github"       && <GitHubSettings />}
          {settingsSection === "integrations" && <IntegrationsSettings />}
          {settingsSection !== "github" && settingsSection !== "integrations" && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              height: "100%", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)",
            }}>{settingsSection} · coming soon</div>
          )}
        </section>
    </div>
  );
}
