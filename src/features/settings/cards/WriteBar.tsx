// The read/write status bar for the Claude Config editor (#2128), extracted verbatim from
// ClaudeConfigCard.tsx.

import { type Dispatch, type SetStateAction } from "react";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Button } from "@/shared/ui/controls/Button";
import { Text } from "@/shared/ui/typography/Text";

export function WriteBar({
  writeStatus, writeMsg, reading, writing, setReadTick, handleWrite,
}: {
  writeStatus: "idle" | "ok" | "error";
  writeMsg: string;
  reading: boolean;
  writing: boolean;
  setReadTick: Dispatch<SetStateAction<number>>;
  handleWrite: () => void;
}) {
  return (
    <Row gap={10} style={{
      padding: "10px 14px",
      background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
    }}>
      {writeStatus === "ok" && (
        <Text as="span" mono size={11} tone="success">✓ {writeMsg}</Text>
      )}
      {writeStatus === "error" && (
        <Text as="span" mono size={11} tone="danger">{writeMsg}</Text>
      )}
      {writeStatus === "idle" && (
        <Text as="span" mono size={11} tone="dim">
          CLAUDE.md and .claude/settings.json
        </Text>
      )}
      <Spacer />
      <Button
        variant="ghost"
        style={{ height: 28, fontSize: 11 }}
        disabled={reading}
        onClick={() => setReadTick((n) => n + 1)}
      >
        {reading ? "reading…" : "↺ read from disk"}
      </Button>
      <Button
        variant="primary"
        style={{ height: 28, fontSize: 11 }}
        disabled={writing || reading}
        onClick={handleWrite}
      >
        {writing ? "writing…" : "↓ write to disk"}
      </Button>
    </Row>
  );
}
