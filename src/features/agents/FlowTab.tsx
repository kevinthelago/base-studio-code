// Agents — Flow tab (#1643 split from AgentsWorkspace).
//
// The fleet's live work-flow: which sessions are parked on a dependency (#199) and
// which work items are flowing through their workflow stages (#220) — each cross-
// referenced with the permission profile the session runs under. Coord state is
// rebuilt from the app-wide $BSC_COORD_LOG via read_coord_log + ingestCoordLog, so it
// needs no store wiring. Summary + status colors are pure (./lib/flowModel).

import { useCallback, useState } from "react";
import { StatusDot } from "@/shared/ui/StatusDot";
import { Chip } from "@/shared/ui/Chip";
import { StatTile } from "@/shared/ui/StatTile";
import { SectionHeader } from "@/shared/ui/SectionHeader";
import { usePoll } from "@/shared/hooks/usePoll";
import { invoke } from "@tauri-apps/api/core";
import {
  ingestCoordLog, coordinationSummary, wakePromptFor, emptyCoordState,
  type BlockedView, type Waiter, type CoordState,
} from "@/shared/lib/fleet/coordination";
import { actuateWake } from "@/shared/lib/fleet/coordinatorActuate";
import type { WorkflowRun } from "@/shared/lib/fleet/conductor";
import type { AgentProfile } from "./lib/agentProfiles";
import { flowSummary, depColor, stageColor } from "./lib/flowModel";

const COORD_POLL_MS = 3000;

export interface FlowTabProps {
  runs: Record<string, WorkflowRun>;
  wakePane: (paneId: string, prompt: string) => boolean;
  profileFor: (session: string) => AgentProfile | undefined;
}

/** A compact "session @ profile" chip — the Agents-screen cross-reference. */
function SessionTag({ session, profile }: { session: string; profile?: AgentProfile }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{session}</h3>
      {profile && (
        <span className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 10 }}>
          <span className="sw" style={{ background: profile.color, width: 8, height: 8, borderRadius: 2, display: "inline-block" }} />
          {profile.name}
        </span>
      )}
    </span>
  );
}

export function FlowTab({ runs, wakePane, profileFor }: FlowTabProps) {
  const [views, setViews] = useState<BlockedView[]>([]);
  const [ready, setReady] = useState<Waiter[]>([]);
  const [state, setState] = useState<CoordState>(emptyCoordState());
  const [err, setErr] = useState<string | null>(null);
  const [waking, setWaking] = useState<Set<string>>(new Set());

  // Polls only while this tab is mounted (the tab is conditionally rendered).
  usePoll((isCancelled) => {
    invoke<string[]>("read_coord_log", { limit: 1000 })
      .then((lines) => {
        if (isCancelled()) return;
        const r = ingestCoordLog(lines, emptyCoordState());
        setViews(coordinationSummary(r.state));
        setReady(r.ready);
        setState(r.state);
        setErr(null);
      })
      .catch((e) => { if (!isCancelled()) setErr(String(e)); });
  }, COORD_POLL_MS);

  const handleWake = useCallback(async (wtr: Waiter) => {
    setWaking((cur) => new Set(cur).add(wtr.session));
    try {
      await actuateWake(wtr.session, wakePromptFor(wtr, state), wakePane);
    } finally {
      setWaking((cur) => { const n = new Set(cur); n.delete(wtr.session); return n; });
    }
  }, [wakePane, state]);

  const { stalled, deadlocked, runEntries, idle } = flowSummary(views, ready, runs);

  return (
    <div style={{ overflow: "auto", flex: 1, minWidth: 0 }}>
      <div className="summary">
        <StatTile k="ready" v={ready.length} tone="success" sub="deps landed — wake" />
        <StatTile k="blocked" v={views.length} tone="accent" sub="parked on a dep" />
        <StatTile k="stalled / deadlocked" v={stalled + deadlocked} tone="danger" sub={<>{deadlocked} cyclic · escalate</>} />
        <StatTile k="workflows" v={runEntries.length} sub="work items flowing" />
      </div>

      {deadlocked > 0 && (
        <div className="card" style={{ margin: "0 0 14px", borderColor: "var(--danger)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 12 }}>
            <span>⚠ deadlock</span>
            <span className="hint" style={{ color: "var(--fg-muted)" }}>
              {deadlocked} session{deadlocked === 1 ? "" : "s"} sit in a wait-for cycle — no producer can move. Escalate to the director / break the cycle (#199).
            </span>
          </div>
        </div>
      )}

      {err && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)", marginBottom: 10 }}>{err}</div>}

      {idle && !err && (
        <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11.5, padding: "8px 2px" }}>
          The fleet is flowing. Parked sessions appear here when a worker runs <code>bsc-blocked --on &lt;ref&gt;</code>;
          workflow runs appear once a work item is started (Projects → Workflows).
        </div>
      )}

      {ready.length > 0 && (
        <>
          <SectionHeader title="Ready" hint="dependencies landed — wake the parked pane" />
          <div style={{ marginBottom: 14 }}>
            {ready.map((wtr) => (
              <div key={wtr.session} className="card" style={{ marginBottom: 10, borderColor: "var(--success)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <SessionTag session={wtr.session} profile={profileFor(wtr.session)} />
                  <Chip tone="success" style={{ fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />ready</Chip>
                  <div style={{ flex: 1 }} />
                  {wtr.checkpoint && <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>↺ {wtr.checkpoint}</span>}
                  <button
                    className="btn primary"
                    style={{ height: 24, padding: "0 12px", fontSize: 11 }}
                    disabled={waking.has(wtr.session)}
                    onClick={() => handleWake(wtr)}
                  >
                    {waking.has(wtr.session) ? "waking…" : "Wake"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {views.length > 0 && (
        <>
          <SectionHeader title="Blocked" hint="parked on a dependency · live from the coordination log" />
          {views.map((v) => (
            <div key={v.session} className="card" style={{ marginBottom: 10, borderColor: v.deadlocked || v.stalled ? "var(--danger)" : undefined }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <SessionTag session={v.session} profile={profileFor(v.session)} />
                {v.deadlocked
                  ? <Chip style={{ color: "var(--danger)", fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />deadlocked</Chip>
                  : v.stalled
                    ? <Chip style={{ color: "var(--danger)", fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />stalled</Chip>
                    : <Chip style={{ fontSize: 9.5 }}>waiting</Chip>}
                <div style={{ flex: 1 }} />
                {v.checkpoint && <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>↺ {v.checkpoint}</span>}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {v.deps.map((d) => (
                  <span key={d.ref} style={{
                    fontFamily: "var(--mono)", fontSize: 11, padding: "3px 8px", borderRadius: 5,
                    border: "1px solid var(--border-soft)", color: depColor(d.status),
                  }}>
                    {d.ref} · {d.status}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {runEntries.length > 0 && (
        <>
          <SectionHeader title="Workflows" hint="role-staged work items (#220) · the role each stage runs as" />
          {runEntries.map(([id, run]) => {
            const stages = Object.values(run.workflow.stages);
            return (
              <div key={id} className="card" style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{id}</h3>
                  <span className="hint" style={{ fontSize: 10.5 }}>{run.workflow.name}</span>
                  <Chip style={{ color: stageColor(run.state.status), fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />{run.state.status}</Chip>
                  <div style={{ flex: 1 }} />
                  {run.state.escalation && (
                    <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)" }}>{run.state.escalation}</span>
                  )}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  {stages.map((st, i) => {
                    const current = run.state.stage === st.name;
                    const attempts = run.state.attempts[st.name] ?? 0;
                    return (
                      <span key={st.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {i > 0 && <span style={{ color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10 }}>→</span>}
                        <span style={{
                          fontFamily: "var(--mono)", fontSize: 11, padding: "3px 8px", borderRadius: 5,
                          border: "1px solid " + (current ? "var(--accent)" : "var(--border-soft)"),
                          color: current ? "var(--accent)" : "var(--fg-muted)",
                          background: current ? "var(--bg-elev)" : "transparent",
                        }}>
                          {st.name} <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>{st.role}</span>{attempts > 1 ? ` ×${attempts}` : ""}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
