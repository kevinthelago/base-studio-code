// The CLAUDE.md instruction editor (left column) for the Claude Config editor (#2128), extracted
// verbatim from ClaudeConfigCard.tsx.

import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

export function ClaudeMdEditor({
  instructions, setInstructions, setActiveProfileId, reading, targetLabel,
}: {
  instructions: string;
  setInstructions: (v: string) => void;
  setActiveProfileId: (id: string | null) => void;
  reading: boolean;
  targetLabel: string;
}) {
  return (
    <Stack gap={10}>
      <Box bg="var(--bg-panel)" border="soft" radius={8} style={{
        overflow: "hidden",
      }}>
        <Row className="mono" gap={8} style={{
          padding: "8px 14px", borderBottom: "1px solid var(--border-soft)",
          background: "var(--bg-elev)",
          fontSize: 10,
        }}>
          <Text as="span" tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>CLAUDE.md</Text>
          {reading && <Text as="span" tone="dim">loading…</Text>}
          <Spacer />
          <Text as="span" tone="dim">{targetLabel}</Text>
        </Row>
        {/* eslint-disable-next-line no-restricted-syntax -- no shared <textarea> primitive */}
        <textarea
          className="mono"
          value={instructions}
          onChange={(e) => { setInstructions(e.target.value); setActiveProfileId(null); }}
          placeholder="# Instructions&#10;&#10;Write system-level instructions for Claude in this scope…"
          style={{
            width: "100%", minHeight: 260,
            background: "var(--bg-canvas)", border: "none", outline: "none",
            padding: "14px 16px",
            fontSize: 11.5, color: "var(--fg)",
            resize: "vertical", lineHeight: 1.65,
            boxSizing: "border-box",
          }}
        />
      </Box>
    </Stack>
  );
}
