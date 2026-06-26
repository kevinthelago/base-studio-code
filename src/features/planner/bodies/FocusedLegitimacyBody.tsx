// FocusedLegitimacyBody — right-pane body for the "sourceLicensing" stage.
//
// Reads the planner's declared `sourceLicensing.json` and shows the per-source
// clearance verdict (cleared / needs review / blocked), the robots.txt rules, the
// terms & license per source, the intended-use statement, and a readiness gate. A
// blocked source raises a hard-stop banner — acquisition can't proceed until it's
// cleared or dropped. Transcribed from collection/panes.jsx · LegitimacyPane.

import { useStageJson } from "./useStageJson";
import { type Licensing, type ClearStatus } from "./dataCollection";
import { Card, ModeChip, SourceHead, Readiness } from "./bodyPrimitives";

const mono = "var(--mono)";

const CLR: Record<ClearStatus, { color: string; label: string }> = {
  cleared:        { color: "var(--success)", label: "cleared" },
  "needs review": { color: "var(--accent)",  label: "needs review" },
  blocked:        { color: "var(--danger)",  label: "blocked" },
};

function ClearChip({ status }: { status: ClearStatus }) {
  const m = CLR[status];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 7px", borderRadius: 99,
      fontFamily: mono, fontSize: 9.5, color: m.color,
      background: `color-mix(in oklch, ${m.color}, transparent 88%)`,
      border: `1px solid color-mix(in oklch, ${m.color}, transparent 70%)`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: m.color }} />{m.label}
    </span>
  );
}

export function FocusedLegitimacyBody({ projectId }: { projectId?: string }) {
  const { data, loading } = useStageJson<Licensing>(projectId, "sourceLicensing");

  if (loading) {
    return <div className="empty-state" data-testid="legitimacy-loading"><span className="empty-icon">⚖</span>
      <span style={{ fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>Loading clearances…</span></div>;
  }

  const sources = data?.sources ?? [];
  const clearance = data?.clearance ?? {};
  const statusOf = (id: string): ClearStatus => clearance[id]?.status ?? "needs review";

  if (sources.length === 0) {
    return (
      <div data-testid="focused-legitimacy-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
        <Card label="per-source clearance">
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <span className="empty-icon">⚖</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No sources to clear yet</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)", maxWidth: 380, textAlign: "center", lineHeight: 1.5 }}>
              Declare sources in <b>Targets</b> first — every source must be cleared for the intended use (ToS · robots.txt · license) before any data is acquired.
            </span>
          </div>
        </Card>
      </div>
    );
  }

  const blocked = sources.some((s) => statusOf(s.id) === "blocked");
  const review = sources.some((s) => statusOf(s.id) === "needs review");
  // The first source carrying robots rules drives the robots.txt card.
  const robotsSrc = sources.find((s) => (clearance[s.id]?.robots?.rules?.length ?? 0) > 0);
  const robots = robotsSrc ? clearance[robotsSrc.id].robots : null;

  return (
    <div data-testid="focused-legitimacy-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
      {/* hard-stop banner */}
      {blocked && (
        <div data-testid="legitimacy-hard-block" style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8,
          background: "color-mix(in oklch, var(--danger), transparent 88%)",
          border: "1px solid color-mix(in oklch, var(--danger), transparent 65%)",
        }}>
          <span style={{ fontSize: 16 }}>⛔</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
            <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: "var(--danger)" }}>Acquisition blocked</span>
            <span style={{ fontFamily: mono, fontSize: 10, color: "var(--fg-muted)", lineHeight: 1.5 }}>
              A blocked source must be cleared or dropped before Acquire. Narrow scope or remove it.
            </span>
          </div>
        </div>
      )}

      {/* per-source clearance */}
      <Card label="per-source clearance" hint="cleared before acquire">
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {sources.map((s) => {
            const st = statusOf(s.id);
            const reason = clearance[s.id]?.reason;
            return (
              <div key={s.id}>
                <SourceHead s={s} right={<ClearChip status={st} />} />
                {reason && st !== "cleared" && (
                  <div style={{ marginTop: 4, fontFamily: mono, fontSize: 10, color: st === "blocked" ? "var(--danger)" : "var(--accent)" }}>{reason}</div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* robots.txt */}
      {robots && robots.rules.length > 0 && (
        <Card label="robots.txt" hint={robots.delay ? `crawl-delay ${robots.delay}` : undefined}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {robots.rules.map((r) => (
              <div key={r.path} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: mono, fontSize: 10.5, color: "var(--fg-muted)" }}>{r.path}</span>
                <span style={{ flex: 1 }} />
                <span style={{
                  fontFamily: mono, fontSize: 9, padding: "1px 6px", borderRadius: 4,
                  color: r.allow ? "var(--success)" : "var(--danger)",
                  background: `color-mix(in oklch, ${r.allow ? "var(--success)" : "var(--danger)"}, transparent 88%)`,
                  border: `1px solid color-mix(in oklch, ${r.allow ? "var(--success)" : "var(--danger)"}, transparent 72%)`,
                }}>{r.allow ? "allowed" : "disallowed"}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* terms & license (non-blocked sources) */}
      <Card label="terms & license">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sources.filter((s) => statusOf(s.id) !== "blocked").map((s) => {
            const terms = clearance[s.id]?.terms;
            if (!terms) return null;
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ModeChip mode={s.mode} />
                <span style={{ fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>{s.label}</span>
                <span style={{ flex: 1 }} />
                {terms.license && <span style={{ fontFamily: mono, fontSize: 9, padding: "1px 6px", borderRadius: 4, color: "var(--info)", background: "color-mix(in oklch, var(--info), transparent 88%)", border: "1px solid color-mix(in oklch, var(--info), transparent 72%)" }}>{terms.license}</span>}
                {terms.text && <span style={{ fontFamily: mono, fontSize: 10, color: "var(--fg-dim)" }}>{terms.text}</span>}
                {terms.attribution && <span title={terms.attribution} style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-muted)" }}>⚐ attribution</span>}
              </div>
            );
          })}
        </div>
      </Card>

      {/* intended use */}
      {data?.intendedUse && (
        <Card label="intended use" badge={<span style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-dim)" }}>ToS hinges on this</span>}>
          <div style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.6 }}>{data.intendedUse}</div>
        </Card>
      )}

      <Readiness
        checks={sources.map((s) => {
          const st = statusOf(s.id);
          return { id: s.id, label: `${s.label} cleared for intended use`, ok: st === "cleared", block: st === "blocked", detail: CLR[st].label };
        })}
        tail={blocked
          ? <span style={{ color: "var(--danger)" }}><b>Hard stop</b> — a blocked source must be cleared or dropped before Acquire.</span>
          : review
            ? <span style={{ color: "var(--accent)" }}>Resolve "needs review" sources to unblock Acquire.</span>
            : <>All sources cleared — Acquire is unblocked.</>}
      />
    </div>
  );
}
