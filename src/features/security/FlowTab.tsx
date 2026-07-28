// Security — Flow tab (#1643 split from SecurityWorkspace).
//
// The fleet's live work-flow: which sessions are parked on a dependency (#199) — each
// cross-referenced with the permission profile the session runs under. Coord state is
// rebuilt from the app-wide $BSC_COORD_LOG via read_coord_log + ingestCoordLog, so it
// needs no store wiring. Summary + status colors are pure (./lib/flowModel).

import { useCallback, useState } from "react";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Chip } from "@/shared/ui/data/Chip";
import { StatTile } from "@/shared/ui/data/StatTile";
import { SectionHeader } from "@/shared/ui/layout/SectionHeader";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { usePoll } from "@/shared/hooks/usePoll";
import {
  coordinationSummary, wakePromptFor, emptyCoordState,
  type BlockedView, type Waiter, type CoordState,
} from "@/shared/lib/fleet/coordination";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import { actuateWake } from "@/shared/lib/fleet/coordinatorActuate";
import type { AgentProfile } from "./lib/agentProfiles";
import { flowSummary, depColor } from "./lib/flowModel";

const COORD_POLL_MS = 3000;

export interface FlowTabProps {
  wakePane: (paneId: string, prompt: string) => boolean;
  profileFor: (session: string) => AgentProfile | undefined;
}

/** A compact "session @ profile" chip — the Agents-screen cross-reference. */
function SessionTag({ session, profile }: { session: string; profile?: AgentProfile }) {
  return (
    <Box as="span" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <h3 className="mono" style={{ margin: 0, fontSize: 13 }}>{session}</h3>
      {profile && (
        <Box as="span" className="hint mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10 }}>
          <Box as="span" className="sw" bg={profile.color} radius={2} style={{ width: 8, height: 8, display: "inline-block" }} />
          {profile.name}
        </Box>
      )}
    </Box>
  );
}

export function FlowTab({ wakePane, profileFor }: FlowTabProps) {
  const [views, setViews] = useState<BlockedView[]>([]);
  const [ready, setReady] = useState<Waiter[]>([]);
  const [state, setState] = useState<CoordState>(emptyCoordState());
  const [err, setErr] = useState<string | null>(null);
  const [waking, setWaking] = useState<Set<string>>(new Set());

  // Polls only while this tab is mounted (the tab is conditionally rendered).
  // Reads via the shared readCoordState (#1495) — `null` on a read failure, which we
  // map to the existing `err` banner (last-good views/ready/state are kept).
  usePoll(async (isCancelled) => {
    const r = await readCoordState(1000);
    if (isCancelled()) return;
    if (!r) { setErr("Failed to read the coordination log"); return; }
    setViews(coordinationSummary(r.state));
    setReady(r.ready);
    setState(r.state);
    setErr(null);
  }, COORD_POLL_MS);

  const handleWake = useCallback(async (wtr: Waiter) => {
    setWaking((cur) => new Set(cur).add(wtr.session));
    try {
      await actuateWake(wtr.session, wakePromptFor(wtr, state), wakePane);
    } finally {
      setWaking((cur) => { const n = new Set(cur); n.delete(wtr.session); return n; });
    }
  }, [wakePane, state]);

  const { stalled, deadlocked, idle } = flowSummary(views, ready);

  return (
    <Box style={{ overflow: "auto", flex: 1, minWidth: 0 }}>
      <Box className="summary">
        <StatTile k="ready" v={ready.length} tone="success" sub="deps landed — wake" />
        <StatTile k="blocked" v={views.length} tone="accent" sub="parked on a dep" />
        <StatTile k="stalled / deadlocked" v={stalled + deadlocked} tone="danger" sub={<>{deadlocked} cyclic · escalate</>} />
      </Box>

      {deadlocked > 0 && (
        <Card style={{ margin: "0 0 14px", borderColor: "var(--danger)" }}>
          <Row gap={8} className="mono" style={{ color: "var(--danger)", fontSize: 12 }}>
            <Box as="span">⚠ deadlock</Box>
            <Text as="span" className="hint" tone="muted">
              {deadlocked} session{deadlocked === 1 ? "" : "s"} sit in a wait-for cycle — no producer can move. Escalate to the director / break the cycle (#199).
            </Text>
          </Row>
        </Card>
      )}

      {err && <Text as="div" mono size={11} tone="danger" style={{ marginBottom: 10 }}>{err}</Text>}

      {idle && !err && (
        <Text as="div" className="hint" mono size={11.5} style={{ padding: "8px 2px" }}>
          The fleet is flowing. Sessions appear here when a worker pauses for you (<code>bsc-wait</code>)
          or asks the director a question (<code>bsc-ask</code>).
        </Text>
      )}

      {ready.length > 0 && (
        <>
          <SectionHeader title="Ready" hint="dependencies landed — wake the parked pane" />
          <Box style={{ marginBottom: 14 }}>
            {ready.map((wtr) => (
              <Card key={wtr.session} style={{ marginBottom: 10, borderColor: "var(--success)" }}>
                <Row gap={10}>
                  <SessionTag session={wtr.session} profile={profileFor(wtr.session)} />
                  <Chip tone="success" style={{ fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />ready</Chip>
                  <Spacer />
                  {wtr.checkpoint && <Text as="span" className="hint" mono size={10}>↺ {wtr.checkpoint}</Text>}
                  <Button
                    variant="primary"
                    style={{ height: 24, padding: "0 12px", fontSize: 11 }}
                    disabled={waking.has(wtr.session)}
                    onClick={() => handleWake(wtr)}
                  >
                    {waking.has(wtr.session) ? "waking…" : "Wake"}
                  </Button>
                </Row>
              </Card>
            ))}
          </Box>
        </>
      )}

      {views.length > 0 && (
        <>
          <SectionHeader title="Blocked" hint="parked on a dependency · live from the coordination log" />
          {views.map((v) => (
            <Card key={v.session} style={{ marginBottom: 10, borderColor: v.deadlocked || v.stalled ? "var(--danger)" : undefined }}>
              <Row gap={10} style={{ marginBottom: 8 }}>
                <SessionTag session={v.session} profile={profileFor(v.session)} />
                {v.deadlocked
                  ? <Chip style={{ color: "var(--danger)", fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />deadlocked</Chip>
                  : v.stalled
                    ? <Chip style={{ color: "var(--danger)", fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />stalled</Chip>
                    : <Chip style={{ fontSize: 9.5 }}>waiting</Chip>}
                <Spacer />
                {v.checkpoint && <Text as="span" className="hint" mono size={10}>↺ {v.checkpoint}</Text>}
              </Row>
              <Row gap={6} wrap align="stretch">
                {v.deps.map((d) => (
                  <Box as="span" key={d.ref} className="mono" pad={[3, 8]} border="soft" radius={5} style={{
                    fontSize: 11, color: depColor(d.status),
                  }}>
                    {d.ref} · {d.status}
                  </Box>
                ))}
              </Row>
            </Card>
          ))}
        </>
      )}
    </Box>
  );
}
