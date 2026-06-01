// Coordination inbox (#199): a live view of which fleet sessions are blocked, what each
// waits on, and which chains have stalled -- plus the sessions whose deps have now landed
// (ready), each with a "Wake" button that relaunches the parked pane as a fresh claude
// session seeded with the token-aware wake prompt. State is rebuilt from the app-wide
// $BSC_COORD_LOG via read_coord_log + ingestCoordLog, so it needs no store wiring beyond
// the wakePane action. A `woke` event (append_coord_woke) records the wake so it isn't
// offered again.
import { useEffect, useMemo, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { actuateWake } from "../../lib/coordinatorActuate";
import {
  ingestCoordLog, coordinationSummary, wakePromptFor, emptyCoordState,
  buildProducerOf, producesFromPaneStreams,
  type BlockedView, type Waiter, type CoordState,
} from "../../lib/coordination";

const POLL_MS = 3000;

function depColor(status: BlockedView["deps"][number]["status"]): string {
  return status === "satisfied" ? "var(--success)" : status === "failed" ? "var(--danger)" : "var(--fg-dim)";
}

export function CoordinatorInbox() {
  const wakePane = useAppStore((s) => s.wakePane);
  const coordAutoWake = useAppStore((s) => s.coordAutoWake);
  const setCoordAutoWake = useAppStore((s) => s.setCoordAutoWake);
  const fleetPaneStreams = useAppStore((s) => s.fleetPaneStreams);
  const [ready, setReady] = useState<Waiter[]>([]);
  const [state, setState] = useState<CoordState>(emptyCoordState());
  const [err, setErr] = useState<string | null>(null);
  const [waking, setWaking] = useState<Set<string>>(new Set());

  // Plan-derived producer resolver (#199 AC#7): map each blocked-on contract/issue/file
  // ref back to the PANE expected to satisfy it, so coordinationSummary lights up
  // file/issue wait-for cycles — not just `session:` ones. Falls back to the default
  // (session-only) resolver when no fleet has launched.
  const producerOf = useMemo(
    () => buildProducerOf(producesFromPaneStreams(fleetPaneStreams)),
    [fleetPaneStreams],
  );
  // Derived reactively so it recomputes when either the log state OR the fleet map
  // changes (a new launch can introduce/break a cycle without a fresh log line).
  const views = useMemo(() => coordinationSummary(state, producerOf), [state, producerOf]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      invoke<string[]>("read_coord_log", { limit: 1000 })
        .then((lines) => {
          if (cancelled) return;
          const r = ingestCoordLog(lines, emptyCoordState());
          setReady(r.ready);
          setState(r.state);
          setErr(null);
        })
        .catch((e) => { if (!cancelled) setErr(String(e)); });
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const handleWake = useCallback(async (w: Waiter) => {
    setWaking((cur) => new Set(cur).add(w.session));
    try {
      await actuateWake(w.session, wakePromptFor(w, state), wakePane);
    } finally {
      setWaking((cur) => { const n = new Set(cur); n.delete(w.session); return n; });
    }
  }, [wakePane, state]);

  const stalled = views.filter((v) => v.stalled).length;
  const deadlocked = views.filter((v) => v.deadlocked).length;
  const nothing = ready.length === 0 && views.length === 0;

  return (
    <section style={{ flex: 1, overflow: "auto", padding: "18px 22px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>Coordination</h2>
        <span className="hint">parked sessions · live from the coordination log (#199)</span>
        <div style={{ flex: 1 }} />
        {ready.length > 0 && <span className="tag green">{ready.length} ready</span>}
        {views.length > 0 && <span className="tag">{views.length} blocked</span>}
        {stalled > 0 && <span className="tag" style={{ color: "var(--danger)" }}>{stalled} stalled</span>}
        {deadlocked > 0 && <span className="tag" style={{ color: "var(--danger)" }}>{deadlocked} deadlocked</span>}
        <button
          className="btn ghost"
          style={{ height: 22, fontSize: 10.5, color: coordAutoWake ? "var(--accent)" : "var(--fg-muted)" }}
          onClick={() => setCoordAutoWake(!coordAutoWake)}
          title="When on, a parked pane is relaunched automatically as soon as its dependencies land (recently). When off, use the Wake button."
        >
          auto-wake {coordAutoWake ? "on" : "off"}
        </button>
      </div>

      {err && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)" }}>{err}</div>
      )}

      {nothing && !err && (
        <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "8px 0" }}>
          No sessions are blocked. When a fleet session runs <code>bsc-blocked --on &lt;ref&gt;</code> it appears
          here until the dependency lands (the director marks it with <code>bsc-merged</code> / <code>bsc-closed</code>),
          then you can wake it.
        </div>
      )}

      {ready.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
            Ready — dependencies landed
          </div>
          {ready.map((w) => (
            <div key={w.session} className="card" style={{ marginBottom: 12, borderColor: "var(--success)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{w.session}</h3>
                <span className="tag green" style={{ fontSize: 9.5 }}>● ready</span>
                <div style={{ flex: 1 }} />
                {w.checkpoint && <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>↺ {w.checkpoint}</span>}
                <button
                  className="btn primary"
                  style={{ height: 24, padding: "0 12px", fontSize: 11 }}
                  disabled={waking.has(w.session)}
                  onClick={() => handleWake(w)}
                >
                  {waking.has(w.session) ? "waking…" : "Wake"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {views.map((v) => (
        <div key={v.session} className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{v.session}</h3>
            {v.deadlocked
              ? <span className="tag" style={{ color: "var(--danger)", fontSize: 9.5 }} title="Part of a wait-for cycle — no producer can satisfy it; the chain will hang. Break the cycle (re-sequence the streams) to recover.">⊗ deadlock</span>
              : v.stalled
              ? <span className="tag" style={{ color: "var(--danger)", fontSize: 9.5 }}>● stalled</span>
              : <span className="tag" style={{ fontSize: 9.5 }}>waiting</span>}
            <div style={{ flex: 1 }} />
            {v.checkpoint && (
              <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>↺ {v.checkpoint}</span>
            )}
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
    </section>
  );
}
