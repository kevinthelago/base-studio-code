import { useAppStore } from "@/store";
import {
  MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_SIZE,
  adjustFontSize,
} from "@/app/console/lib/terminal";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";

export function TerminalFontSizeCard() {
  const { terminalFontSize, setTerminalFontSize } = useAppStore();

  return (
    <Card title="Terminal font size" hint="also bound to Ctrl + / Ctrl - / Ctrl 0">
      <Row gap={14}>
        <Button
          aria-label="Decrease terminal font size"
          disabled={terminalFontSize <= MIN_TERMINAL_FONT_SIZE}
          onClick={() => setTerminalFontSize(adjustFontSize(terminalFontSize, -1))}
        >−</Button>
        <input
          type="range"
          aria-label="Terminal font size"
          min={MIN_TERMINAL_FONT_SIZE}
          max={MAX_TERMINAL_FONT_SIZE}
          value={terminalFontSize}
          onChange={(e) => setTerminalFontSize(Number(e.target.value))}
          style={{ flex: 1, accentColor: "var(--accent)" }}
        />
        <Button
          aria-label="Increase terminal font size"
          disabled={terminalFontSize >= MAX_TERMINAL_FONT_SIZE}
          onClick={() => setTerminalFontSize(adjustFontSize(terminalFontSize, +1))}
        >+</Button>
        <Text as="span" mono size="md" style={{
          color: "var(--fg)",
          minWidth: 48, textAlign: "right",
        }}>{terminalFontSize}px</Text>
        <Button
          variant="ghost"
          onClick={() => setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE)}
          disabled={terminalFontSize === DEFAULT_TERMINAL_FONT_SIZE}
        >reset</Button>
      </Row>
      <Box
        className="mono"
        style={{
          marginTop: 14, padding: "10px 12px", borderRadius: 6,
          background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
          fontSize: terminalFontSize, color: "var(--fg-muted)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >$ claude — the quick brown fox jumps over 1234567890</Box>
    </Card>
  );
}
