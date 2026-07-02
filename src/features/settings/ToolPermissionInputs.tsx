// Tool-permission inputs for the Claude Config editor (#1709), extracted from ClaudeConfig.tsx.
//
// ToolChip is intentionally NOT based on the shared `@/shared/ui/data/Chip` (#1713): that chip is a
// color-mix translucent pill (radius 99, no remove affordance), whereas this one is a solid
// `--bg-elev` fill at radius 4 with an inline × remove control. Folding it in would change its
// rendering (the #1635/#1713 lesson), so it stays local.
//
// ChipInput is the editor's own multi-value entry (datalist-backed tool-name suggestions + an
// "+ add" button); it is specific to this surface, so it lives here rather than in shared/ui.

import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { COMMON_TOOLS } from "./lib/toolPresets";

/** A removable tool badge in the allow/deny lists. */
export function ToolChip({
  label, onRemove,
}: { label: string; onRemove: () => void }) {
  return (
    <Box as="span" className="mono" pad={[2, 8]} bg="var(--bg-elev)" border="soft" radius={4} style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 10.5, color: "var(--fg-muted)",
    }}>
      {label}
      <Text
        as="span"
        tone="dim"
        onClick={onRemove}
        style={{ cursor: "pointer", lineHeight: 1 }}
      >×</Text>
    </Box>
  );
}

/** Text input + "+ add" button for appending a tool to an allow/deny list. */
export function ChipInput({
  value, onChange, onAdd, placeholder,
}: { value: string; onChange: (v: string) => void; onAdd: () => void; placeholder: string }) {
  return (
    <Row gap={5}>
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
      <Box
        as="span"
        className="mono"
        onClick={onAdd}
        pad={[2, 8]} bg="var(--bg-elev)" border="soft" radius={4} style={{ cursor: "pointer",
          fontSize: 10.5, color: "var(--fg-muted)",
        }}
      >+ add</Box>
    </Row>
  );
}
