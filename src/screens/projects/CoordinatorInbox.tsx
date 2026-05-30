// Coordination inbox (#199): a read-only view of which fleet sessions are blocked, what
// each is waiting on, and which chains have stalled (a failed dependency). State is
// rebuilt from the app-wide $BSC_COORD_LOG via read_coord_log + ingestCoordLog, so this
// needs no store wiring. The wake actuation (relaunching a ready pane) is a later slice.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ingestCoordLog, coordinationSummary, emptyCoordState, type BlockedView } from "../../lib/coordination";

const POLL_MS = 3000;

function depColor(status: BlockedView["deps"][number]["status"]): string {
  return status === "satisfied" ? "var(--success)" : status === "failed" ? "var(--danger)" : "var(--fg-dim)";
}

export function CoordinatorInbox() {
  const [views, setViews] = useState<BlockedView[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      invoke<string[]>("read_coord_log", { limit: 1000 })
        .then((lines) => {
          if (cancelled) return;
          const { state } = ingestCoordLog(lines, emptyCoordState());
          setViews(coordinationSummary(state));
          setErr(null);
        })
        .catch((e) => { if (!cancelled) setErr(String(e)); });
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const stalled = views.filter((v) => v.stalled).length;

  return (
    <section style={{ flex: 1, overflow: "auto", padding: "18px 22px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>Coordination</h2>
        <span className="hint">sessions blocked on a dependency · live from the coordination log (#199)</span>
        <div style={{ flex: 1 }} />
        {views.length > 0 && <span className={"tag " + (stalled ? "" : "green")}>{views.length} blocked</span>}
        {stalled > 0 && <span className="tag" style={{ color: "var(--danger)" }}>{stalled} stalled</span>}
      </div>

      {err && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)" }}>{err}</div>
      )}

      {views.length === 0 && !err && (
        <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "8px 0" }}>
          No sessions are blocked. When a fleet session runs <code>bsc-blocked --on &lt;ref&gt;</code> it appears
          here until the dependency lands (the director marks it with <code>bsc-merged</code> / <code>bsc-closed</code>).
        </div>
      )}

      {views.map((v) => (
        <div key={v.session} className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{v.session}</h3>
            {v.stalled
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
