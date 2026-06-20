import { useEffect, useState } from "react";
import { useAppStore } from "../../store";
import {
  MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_SIZE,
  adjustFontSize,
} from "../../lib/console/terminal";
import { ACCENT_PRESETS, accentVars } from "../../lib/settings/appearance";

const THEME_KEY = "bsc-theme";
type Theme = "dark" | "light";

function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return { theme, setTheme: setThemeState };
}

export function AppearanceSettings() {
  const { terminalFontSize, setTerminalFontSize, accent, setAccent } = useAppStore();
  const { theme, setTheme } = useTheme();

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Appearance</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        Theme and typography. Changes apply live across the app.
      </p>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Terminal font size</h3>
          <span className="hint">also bound to Ctrl + / Ctrl - / Ctrl 0</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button
            className="btn"
            aria-label="Decrease terminal font size"
            disabled={terminalFontSize <= MIN_TERMINAL_FONT_SIZE}
            onClick={() => setTerminalFontSize(adjustFontSize(terminalFontSize, -1))}
          >−</button>
          <input
            type="range"
            aria-label="Terminal font size"
            min={MIN_TERMINAL_FONT_SIZE}
            max={MAX_TERMINAL_FONT_SIZE}
            value={terminalFontSize}
            onChange={(e) => setTerminalFontSize(Number(e.target.value))}
            style={{ flex: 1, accentColor: "var(--accent)" }}
          />
          <button
            className="btn"
            aria-label="Increase terminal font size"
            disabled={terminalFontSize >= MAX_TERMINAL_FONT_SIZE}
            onClick={() => setTerminalFontSize(adjustFontSize(terminalFontSize, +1))}
          >+</button>
          <span style={{
            fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)",
            minWidth: 48, textAlign: "right",
          }}>{terminalFontSize}px</span>
          <button
            className="btn ghost"
            onClick={() => setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE)}
            disabled={terminalFontSize === DEFAULT_TERMINAL_FONT_SIZE}
          >reset</button>
        </div>
        <div
          style={{
            marginTop: 14, padding: "10px 12px", borderRadius: 6,
            background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
            fontFamily: "var(--mono)", fontSize: terminalFontSize, color: "var(--fg-muted)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >$ claude — the quick brown fox jumps over 1234567890</div>
      </div>

      <div style={{ height: 18 }} />

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Accent color</h3>
          <span className="hint">the highlight color used across the app</span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {ACCENT_PRESETS.map((p) => {
            const on = p.id === accent;
            const { accent: color } = accentVars(p.id);
            return (
              <button
                key={p.id}
                aria-label={p.label}
                aria-pressed={on}
                title={p.label}
                onClick={() => setAccent(p.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 12px 6px 8px", borderRadius: 99, cursor: "pointer",
                  background: on ? "var(--bg-elev2)" : "var(--bg-elev)",
                  border: "1px solid " + (on ? "var(--accent-dim)" : "var(--border-soft)"),
                  fontFamily: "var(--mono)", fontSize: 11,
                  color: on ? "var(--fg)" : "var(--fg-muted)",
                }}
              >
                <span style={{
                  width: 16, height: 16, borderRadius: "50%", background: color,
                  boxShadow: on ? "0 0 0 2px var(--bg-elev2), 0 0 0 3px " + color : "none",
                }} />
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ height: 18 }} />

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
          <h3 style={{ margin: 0 }}>Theme</h3>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {(["dark", "light"] as const).map((t) => (
            <button
              key={t}
              aria-pressed={theme === t}
              onClick={() => setTheme(t)}
              style={{
                padding: "6px 18px", borderRadius: 6, cursor: "pointer",
                fontFamily: "var(--mono)", fontSize: 11.5,
                background: theme === t ? "var(--accent)" : "var(--bg-elev)",
                color: theme === t ? "#fff" : "var(--fg-muted)",
                border: "1px solid " + (theme === t ? "transparent" : "var(--border-soft)"),
              }}
            >{t.charAt(0).toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          Persisted across restarts. Light mode moves all surfaces to the token layer —
          a few hardcoded terminal palette values may still appear dark.
        </div>
      </div>
    </div>
  );
}
