// Projects → Fleet (#401; live data #412). A live orchestration dashboard for a
// project's agent fleet, driven by the running app state: the launched fleet
// roster (store `fleetPaneStreams`) with real run/idle (`paneStatus`) overlaid
// with blocked/asking/waiting from the coordination log. No fabrication.
//
// Deferred to follow-ups (rendered as explicit "not wired" notes, never sample
// data): GitHub-derived analytics (throughput, merge queue, time-to-land) and
// token/cost accounting (#412 token-usage follow-up).
import { Donut, StatCard, CardHead, Avatar } from "../../components/charts";
import { useAppStore } from "../../store";
import { STATUS } from "../../data/fleet";
import { useFleetLive } from "../../hooks/useFleetLive";
import type { LiveWorker } from "../../lib/fleetLive";

const GRID = "150px 96px 1fr 70px";

function WorkerBoard({ workers }: { workers: LiveWorker[] }) {
  return (
    <div className="card">
      <CardHead title="Worker board" hint="one agent per stream · live run/idle + coordination"
        right={<span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>{workers.length} live</span>} />
      <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        <div style={{
          display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "7px 12px",
          background: "var(--bg-elev2)", borderBottom: "1px solid var(--border-soft)",
          fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em",
        }}>
          <span>worker</span><span>status</span><span>current</span><span style={{ textAlign: "right" }}>issues</span>
        </div>
        {workers.map((w, i) => {
          const st = STATUS[w.status];
          return (
            <div key={w.id} className="hrow" style={{
              display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "9px 12px", alignItems: "center", fontSize: 11,
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              borderLeft: `2px solid ${w.profileColor}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <Avatar login={w.name} bot size={18} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--mono)", color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: w.profileColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.profileLabel}</div>
                </div>
              </div>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 10, color: st.color }}>
                <span className={`wd ${w.status}`} />{st.label}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.issue}</div>
                {w.note && <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.note}</div>}
              </div>
              <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>{w.ownedTotal}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
        {Object.values(STATUS).map(s => (
          <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />{s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function FleetStatus({ counts, total }: { counts: Partial<Record<LiveWorker["status"], number>>; total: number }) {
  const slices = (Object.entries(counts) as Array<[LiveWorker["status"], number]>)
    .map(([k, v]) => ({ name: STATUS[k].label, value: v, color: STATUS[k].color }));
  return (
    <div className="card">
      <CardHead title="Fleet status" hint="right now" />
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Donut slices={slices} center={{ value: total, label: "workers" }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          {slices.map(s => (
            <div key={s.name} style={{ display: "grid", gridTemplateColumns: "12px 1fr 24px", gap: 8, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />
              <span>{s.name}</span>
              <span style={{ textAlign: "right", color: "var(--fg)" }}>{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Honest placeholder for the analytics that still need GitHub history / token
 *  accounting — explicitly NOT sample data. */
function DeferredPanel() {
  return (
    <div className="card">
      <CardHead title="Throughput · merge queue · spend" hint="live-data follow-ups" />
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", lineHeight: 1.7 }}>
        <div>· <b style={{ color: "var(--fg-muted)" }}>Throughput, merge queue, time-to-land</b> — derive from GitHub PR/issue history across the project's repos (#415).</div>
        <div>· <b style={{ color: "var(--fg-muted)" }}>Tokens &amp; spend</b> — need per-session token accounting, which doesn't exist yet (#416).</div>
      </div>
    </div>
  );
}

export function Fleet() {
  const activeProjectName = useAppStore(s => s.activeProjectName);
  const { workers, kpis, counts, hasFleet } = useFleetLive();

  if (!hasFleet) {
    return (
      <section className="an-page">
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 48, textAlign: "center" }}>
          <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 18 }}>No fleet running</h2>
          <p className="hint" style={{ maxWidth: 380, margin: 0 }}>
            Launch a fleet from a project's plan to orchestrate parallel agents — workers, status, and coordination appear here live.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="an-page">
      <div className="an-wrap">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Fleet</h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
              {activeProjectName ? `${activeProjectName} · ` : ""}{kpis.total} worker{kpis.total === 1 ? "" : "s"} · {kpis.active} running · {kpis.needAttention} need attention
            </div>
          </div>
        </div>

        <div className="statgrid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <StatCard k="active workers" v={`${kpis.active}/${kpis.total}`} sub="running now" tone="accent" />
          <StatCard k="need attention" v={String(kpis.needAttention)} sub="blocked · asking · waiting" tone={kpis.needAttention > 0 ? "danger" : "fg"} />
          <StatCard k="idle" v={String(kpis.idle)} sub="at rest" tone="fg" />
          <StatCard k="streams" v={String(kpis.total)} sub="launched in this fleet" tone="info" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <WorkerBoard workers={workers} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <FleetStatus counts={counts} total={kpis.total} />
            <DeferredPanel />
          </div>
        </div>
      </div>
    </section>
  );
}
