// Glance session log (#2369) — the "Logs" tab of the agent stream dock. A compact, live timeline of a
// session's tools/skills/mcp/hooks/denials/coord/activity, read the SAME way every log surface reads it:
// `bsc logs session <paneId> --json` over the bsc bridge (#2144), shaped by the shared `sessionLog` lib
// (no new parsing). Polled while open; newest first.
import { useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { bscJson } from "@/shared/lib/core/bsc";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import {
  type SessionStory, filterEvents, eventTime, streamLabel, streamTone,
} from "@/shared/lib/logs/sessionLog";

export function GlanceSessionLog({ paneId }: { paneId: string }) {
  const [story, setStory] = useState<SessionStory | null>(null);
  usePoll((isCancelled) =>
    bscJson<SessionStory | null>(null, ["logs", "session", paneId, "--json"], null).then((s) => {
      if (!isCancelled()) setStory(s);
    }), 3000, [paneId]);

  const events = filterEvents(story?.events ?? [], null); // newest first
  const cost = story?.cost;

  return (
    <Box style={{ height: "100%", overflowY: "auto", padding: "10px 14px" }}>
      {cost && (
        <Row gap="md" align="baseline" style={{ marginBottom: 10 }}>
          <Text mono size="xs" tone="dim">{cost.model}</Text>
          <Text mono size="xs" tone="dim">{(cost.input + cost.output + cost.cache_creation + cost.cache_read).toLocaleString()} tok</Text>
          <Text mono size="xs" tone="dim">${cost.cost_usd.toFixed(4)}</Text>
        </Row>
      )}
      {events.length === 0 ? (
        <Text tone="dim" size="sm">No log events yet — the agent hasn't emitted tool/skill/coord activity.</Text>
      ) : (
        <Stack gap="xs">
          {events.map((e, i) => (
            <Row key={`${e.ts_ms}-${i}`} gap="sm" align="baseline">
              <Text mono size="xs" tone="dim" style={{ flex: "none" }}>{eventTime(e.ts_ms)}</Text>
              <Text mono size="xs" weight={600} style={{ flex: "none", width: 58, color: streamTone(e.stream) }}>{streamLabel(e.stream)}</Text>
              <Text size="sm" style={{ flex: 1, minWidth: 0 }}>{e.summary}</Text>
            </Row>
          ))}
        </Stack>
      )}
    </Box>
  );
}
