// The tool-permissions panel (right column) for the Claude Config editor (#2128), extracted verbatim
// from ClaudeConfigCard.tsx. Presets + allow/deny chip lists + the settings.json preview.

import { type Dispatch, type SetStateAction } from "react";
import { TOOL_PRESETS } from "../lib/toolPresets";
import { ToolChip, ChipInput } from "../ToolPermissionInputs";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Code } from "@/shared/ui/data/Code";

export function ToolPermissionsPanel({
  allow, setAllow, deny, setDeny,
  allowInput, setAllowInput, denyInput, setDenyInput,
  applyPreset, addToAllow, addToDeny,
}: {
  allow: string[];
  setAllow: Dispatch<SetStateAction<string[]>>;
  deny: string[];
  setDeny: Dispatch<SetStateAction<string[]>>;
  allowInput: string;
  setAllowInput: (v: string) => void;
  denyInput: string;
  setDenyInput: (v: string) => void;
  applyPreset: (preset: typeof TOOL_PRESETS[number]) => void;
  addToAllow: () => void;
  addToDeny: () => void;
}) {
  return (
    <Box bg="var(--bg-panel)" border="soft" radius={8} style={{
      overflow: "hidden",
    }}>
      <Box className="mono" pad={[8, 14]} bg="var(--bg-elev)" style={{ borderBottom: "1px solid var(--border-soft)",
        fontSize: 10,
        color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em",
      }}>
        Tool permissions
      </Box>
      <Stack gap={16} style={{ padding: "14px 14px" }}>
        {/* Presets */}
        <Box>
          <Text as="div" mono size={9.5} tone="dim" style={{ marginBottom: 7, textTransform: "uppercase", letterSpacing: ".06em" }}>quick presets</Text>
          <Row gap={5} align="stretch" wrap>
            {TOOL_PRESETS.map((p) => (
              <Box
                as="span"
                key={p.label}
                className="mono"
                onClick={() => applyPreset(p)}
                pad={[2, 8]} bg="var(--bg-elev)" border="soft" radius={4} style={{ cursor: "pointer",
                  fontSize: 10,
                  color: "var(--fg-muted)",
                }}
              >{p.label}</Box>
            ))}
          </Row>
        </Box>

        {/* Allow */}
        <Box>
          <Text as="div" mono size={9.5} tone="success" style={{ marginBottom: 7, textTransform: "uppercase", letterSpacing: ".06em" }}>allow</Text>
          <Row gap={5} align="stretch" wrap style={{ marginBottom: 8 }}>
            {allow.length === 0 && (
              <Text as="span" mono size={10.5} tone="dim" style={{ fontStyle: "italic" }}>all tools allowed</Text>
            )}
            {allow.map((t) => (
              <ToolChip key={t} label={t} onRemove={() => setAllow((a) => a.filter((x) => x !== t))} />
            ))}
          </Row>
          <ChipInput
            value={allowInput}
            onChange={setAllowInput}
            onAdd={addToAllow}
            placeholder="tool name…"
          />
        </Box>

        {/* Deny */}
        <Box>
          <Text as="div" mono size={9.5} tone="danger" style={{ marginBottom: 7, textTransform: "uppercase", letterSpacing: ".06em" }}>deny</Text>
          <Row gap={5} align="stretch" wrap style={{ marginBottom: 8 }}>
            {deny.length === 0 && (
              <Text as="span" mono size={10.5} tone="dim" style={{ fontStyle: "italic" }}>nothing denied</Text>
            )}
            {deny.map((t) => (
              <ToolChip key={t} label={t} onRemove={() => setDeny((d) => d.filter((x) => x !== t))} />
            ))}
          </Row>
          <ChipInput
            value={denyInput}
            onChange={setDenyInput}
            onAdd={addToDeny}
            placeholder="tool name…"
          />
        </Box>

        {/* Settings.json preview */}
        {(allow.length > 0 || deny.length > 0) && (
          <Code wrap={false} tone="dim" style={{ fontSize: 9.5, padding: "10px 12px", borderRadius: 6 }}>
            {JSON.stringify({ permissions: { allow, deny } }, null, 2)}
          </Code>
        )}
      </Stack>
    </Box>
  );
}
