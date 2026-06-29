import { useAppStore } from "@/store";
import {
  MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_SIZE,
  adjustFontSize,
} from "@/app/console/lib/terminal";
import { SettingsCardHead } from "../pages/SettingsControls";

export function TerminalFontSizeCard() {
  const { terminalFontSize, setTerminalFontSize } = useAppStore();

  return (
    <div className="card">
      <SettingsCardHead title="Terminal font size" hint="also bound to Ctrl + / Ctrl - / Ctrl 0" />
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
  );
}
