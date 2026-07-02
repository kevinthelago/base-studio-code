import { useEffect, useState } from "react";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";

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

export function ThemeCard() {
  const { theme, setTheme } = useTheme();

  return (
    <Card title="Theme">
      <Row gap={8} align="stretch">
        {(["dark", "light"] as const).map((t) => (
          <button
            key={t}
            className="mono"
            aria-pressed={theme === t}
            onClick={() => setTheme(t)}
            style={{
              padding: "6px 18px", borderRadius: 6, cursor: "pointer",
              fontSize: 11.5,
              background: theme === t ? "var(--accent)" : "var(--bg-elev)",
              color: theme === t ? "#fff" : "var(--fg-muted)",
              border: "1px solid " + (theme === t ? "transparent" : "var(--border-soft)"),
            }}
          >{t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
      </Row>
      <div className="hint" style={{ marginTop: 10 }}>
        Persisted across restarts. Light mode moves all surfaces to the token layer —
        a few hardcoded terminal palette values may still appear dark.
      </div>
    </Card>
  );
}
