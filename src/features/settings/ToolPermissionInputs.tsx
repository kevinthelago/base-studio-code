// Tool-permission inputs for the Claude Config editor (#1709), extracted from ClaudeConfig.tsx.
//
// ToolChip is intentionally NOT based on the shared `@/shared/ui/data/Chip` (#1713): that chip is a
// color-mix translucent pill (radius 99, no remove affordance), whereas this one is a solid
// `--bg-elev` fill at radius 4 with an inline × remove control. Folding it in would change its
// rendering (the #1635/#1713 lesson), so it stays local.
//
// ChipInput is the editor's own multi-value entry (datalist-backed tool-name suggestions + an
// "+ add" button); it is specific to this surface, so it lives here rather than in shared/ui.

import { COMMON_TOOLS } from "./lib/toolPresets";

/** A removable tool badge in the allow/deny lists. */
export function ToolChip({
  label, onRemove,
}: { label: string; onRemove: () => void }) {
  return (
    <span className="mono" style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 4,
      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
      fontSize: 10.5, color: "var(--fg-muted)",
    }}>
      {label}
      <span
        onClick={onRemove}
        style={{ color: "var(--fg-dim)", cursor: "pointer", lineHeight: 1 }}
      >×</span>
    </span>
  );
}

/** Text input + "+ add" button for appending a tool to an allow/deny list. */
export function ChipInput({
  value, onChange, onAdd, placeholder,
}: { value: string; onChange: (v: string) => void; onAdd: () => void; placeholder: string }) {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
      <input
        className="input mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAdd(); } }}
        placeholder={placeholder}
        list="tool-suggestions"
        style={{ width: 130, height: 24, padding: "0 8px", fontSize: 10.5 }}
      />
      <datalist id="tool-suggestions">
        {COMMON_TOOLS.map((t) => <option key={t} value={t} />)}
      </datalist>
      <span
        className="mono"
        onClick={onAdd}
        style={{
          padding: "2px 8px", borderRadius: 4, cursor: "pointer",
          background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          fontSize: 10.5, color: "var(--fg-muted)",
        }}
      >+ add</span>
    </div>
  );
}
