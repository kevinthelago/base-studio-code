// Per-session log drill-down (#1607 slice 3) — the dedicated observability surface that, for one
// console session (pane id), surfaces its FULL story across every stream (tools/skills/mcp/hooks/
// perm/coord/activity/done) plus its token/cost rollup. Reads the unified log engine (`crates/logs`)
// the same way the rest of the app does: `bsc logs sessions` / `bsc logs session <id>` over the `bsc`
// bridge (#2144) — no per-verb Tauri command, no hand-parsing (WorkerDetail's tools-only audit parse
// is what this replaces). Lives in Settings, NOT the console pane grid.
import { useState } from "react";
import { bscJson } from "@/shared/lib/core/bsc";
import { usePoll } from "@/shared/hooks/usePoll";
import { Card } from "@/shared/ui/data/Card";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import {
  SESSION_STREAMS,
  eventTime,
  filterEvents,
  streamLabel,
  streamTone,
  summarizeStory,
  type LogSessionRow,
  type SessionStory,
} from "../lib/sessionLog";

/** A picker row: role + total activity + cost, click to drill in. */
function SessionPicker({
  sessions,
  selected,
  onSelect,
}: {
  sessions: LogSessionRow[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="No sessions logged yet"
        description="Launch a console session — its tool, skill, MCP, hook, permission, and coordination events appear here, joined by pane id."
      />
    );
  }
  return (
    <Stack gap={1} style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
      {sessions.map((s, i) => {
        const active = s.session === selected;
        const events = s.tools + s.skills + s.mcp + s.coord;
        return (
          // eslint-disable-next-line no-restricted-syntax -- bespoke selectable list row (custom inline layout + active border), not a .btn
          <button
            key={s.session}
            onClick={() => onSelect(s.session)}
            className="mono"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 8,
              alignItems: "center",
              textAlign: "left",
              cursor: "pointer",
              padding: "8px 11px",
              fontSize: 11,
              color: "var(--fg)",
              background: active ? "color-mix(in oklch, var(--accent), transparent 88%)" : i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              border: "none",
              borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
            }}
          >
            <Box style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <Text as="span" mono size={11} style={{ color: "var(--fg)" }}>{s.session}</Text>
              <Text as="span" mono size={10} tone="dim" style={{ marginLeft: 8 }}>{s.role}</Text>
            </Box>
            <Text as="span" mono size={10} tone="dim">
              {events} ev{s.cost_usd > 0 ? ` · $${s.cost_usd.toFixed(2)}` : ""}
            </Text>
          </button>
        );
      })}
    </Stack>
  );
}

/** The merged timeline + per-stream filter chips + cost header for one drilled-in session. */
function SessionStoryView({ story }: { story: SessionStory | null }) {
  const [filter, setFilter] = useState<string | null>(null);
  const sum = summarizeStory(story);
  const events = filterEvents(story?.events ?? [], filter);

  return (
    <Stack gap={10}>
      {/* header: role + cost */}
      <Row gap={10} wrap>
        <Box as="span" className="mono-label">role</Box>
        <Box as="span" className="mono-value">{sum.role}</Box>
        <Box as="span" style={{ flex: 1 }} />
        <Text as="span" mono size={10.5} tone="dim">{sum.total} events</Text>
        {sum.tokens > 0 && (
          <Text as="span" mono size={10.5} tone="dim">· {sum.tokens.toLocaleString()} tok · ${sum.costUsd.toFixed(4)}</Text>
        )}
      </Row>

      {/* filter chips — one per stream that has events (+ an "all" reset) */}
      <Row gap={6} wrap>
        <StreamChip label="all" tone="var(--fg)" count={sum.total} active={filter === null} onClick={() => setFilter(null)} />
        {SESSION_STREAMS.filter((k) => sum.byStream[k] > 0).map((k) => (
          <StreamChip
            key={k}
            label={streamLabel(k)}
            tone={streamTone(k)}
            count={sum.byStream[k]}
            active={filter === k}
            onClick={() => setFilter(filter === k ? null : k)}
          />
        ))}
      </Row>

      {/* the time-merged timeline (newest first) */}
      {events.length === 0 ? (
        <EmptyState size="sm" title={filter ? `No ${streamLabel(filter)} events` : "No events yet"} />
      ) : (
        <Stack gap={1} style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden", maxHeight: 340, overflowY: "auto" }}>
          {events.map((e, i) => (
            <Row key={i} gap={8} align="center" style={{ padding: "6px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
              <Text as="span" mono size={9.5} tone="dim" style={{ width: 58, flexShrink: 0 }}>{eventTime(e.ts_ms)}</Text>
              <Text as="span" mono size={9.5} style={{ width: 58, flexShrink: 0, color: streamTone(e.stream) }}>{streamLabel(e.stream)}</Text>
              <Text as="span" mono size={10.5} tone="muted" style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.summary}</Text>
            </Row>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function StreamChip({
  label,
  tone,
  count,
  active,
  onClick,
}: {
  label: string;
  tone: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    // eslint-disable-next-line no-restricted-syntax -- bespoke filter chip (per-stream color dot + active fill), not a .btn
    <button
      onClick={onClick}
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        padding: "3px 9px",
        borderRadius: 99,
        fontSize: 10.5,
        color: active ? "var(--fg)" : "var(--fg-muted)",
        background: active ? `color-mix(in oklch, ${tone}, transparent 84%)` : "var(--bg-panel)",
        border: `1px solid ${active ? tone : "var(--border-soft)"}`,
      }}
    >
      <Box as="span" bg={tone} radius={99} style={{ width: 7, height: 7 }} />
      {label}
      <Text as="span" mono size={9.5} tone="dim">{count}</Text>
    </button>
  );
}

/**
 * The per-session log drill-down card. Polls the session list; drilling into one polls that session's
 * full merged story. `initialSession` pre-selects a pane id (e.g. opened from a worker page).
 */
export function SessionLogCard({ initialSession }: { initialSession?: string } = {}) {
  const [sessions, setSessions] = useState<LogSessionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(initialSession ?? null);
  const [story, setStory] = useState<SessionStory | null>(null);

  // Session list (every console session, one row) — polled while the card is open.
  usePoll((isCancelled) =>
    bscJson<LogSessionRow[]>(null, ["logs", "sessions", "--json"], []).then((rows) => {
      if (!isCancelled()) setSessions(rows ?? []);
    }), 5000, []);

  // The drilled-in session's full story — only polls once a session is selected.
  usePoll((isCancelled) => {
    if (!selected) { setStory(null); return; }
    return bscJson<SessionStory | null>(null, ["logs", "session", selected, "--limit", "500", "--json"], null).then((s) => {
      if (!isCancelled()) setStory(s);
    });
  }, 4000, [selected]);

  return (
    <Card title="Session drill-down">
      <Text as="div" size={11} tone="dim" style={{ marginBottom: 10 }}>
        One console session&apos;s full story — tools, skills, MCP, hooks, permission denials, coordination, and activity, time-merged with its token cost. Joined by pane id from the unified log engine.
      </Text>
      {selected ? (
        <Stack gap={12}>
          <Row gap={8}>
            {/* eslint-disable-next-line no-restricted-syntax -- inline back affordance in the card header */}
            <button onClick={() => setSelected(null)} className="mono" style={{ cursor: "pointer", background: "none", border: "none", color: "var(--accent)", fontSize: 11, padding: 0 }}>← all sessions</button>
            <Text as="span" mono size={11} style={{ color: "var(--fg)" }}>{selected}</Text>
          </Row>
          <SessionStoryView story={story} />
        </Stack>
      ) : (
        <SessionPicker sessions={sessions} selected={selected} onSelect={setSelected} />
      )}
    </Card>
  );
}
