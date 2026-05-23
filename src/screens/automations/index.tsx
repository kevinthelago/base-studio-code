import { StatusBar } from "../../components/chrome/StatusBar";
import { useAppStore } from "../../store";
import { SchedulesTab } from "./Schedules";
import { CommandsTab } from "./Commands";

const TABS = [
  { k: "schedules", label: "Schedules",       hint: "cron-triggered jobs"                    },
  { k: "commands",  label: "Commands library", hint: "reusable snippets"                      },
  { k: "history",   label: "History",          hint: "recent runs across all schedules"        },
] as const;

type TabKey = typeof TABS[number]["k"];

export function AutomationsScreen() {
  const { automationsTab, setAutomationsTab } = useAppStore();

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "18px 24px 0", display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600 }}>
              Automations
            </h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
              Schedule the app to run a premade command or load a knowledge article into a specified console.
            </div>
          </div>
          <button className="btn">import</button>
          <button className="btn primary">+ New schedule</button>
        </div>

        <div style={{
          height: 36, marginTop: 12,
          borderBottom: "1px solid var(--border-soft)",
          padding: "0 24px",
          display: "flex", alignItems: "end", gap: 2,
        }}>
          {TABS.map(t => {
            const on = t.k === automationsTab;
            return (
              <div key={t.k} onClick={() => setAutomationsTab(t.k as TabKey)} style={{
                padding: "0 14px", height: 30,
                display: "flex", alignItems: "center", gap: 8,
                borderTopLeftRadius: 6, borderTopRightRadius: 6,
                background: on ? "var(--bg-canvas)" : "transparent",
                border: "1px solid " + (on ? "var(--border-soft)" : "transparent"),
                borderBottom: "0",
                color: on ? "var(--fg)" : "var(--fg-muted)",
                fontFamily: "var(--mono)", fontSize: 11.5,
                cursor: "pointer",
              }}>
                {t.label}
                {on && <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>· {t.hint}</span>}
              </div>
            );
          })}
        </div>

        <section style={{ flex: 1, overflow: "auto", padding: "18px 24px", minWidth: 0 }}>
          {automationsTab === "schedules" && <SchedulesTab />}
          {automationsTab === "commands"  && <CommandsTab />}
          {automationsTab === "history"   && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              height: "100%", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)",
            }}>history · coming soon</div>
          )}
        </section>
      </div>
      <StatusBar extra={
        <span className="s">
          <i className="warn" /> 4 schedules armed · next at 02:00
        </span>
      } />
    </div>
  );
}
