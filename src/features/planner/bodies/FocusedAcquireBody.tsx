// FocusedAcquireBody — right-pane body for the "dataAcquire" stage.
//
// Reads the planner's `dataAcquire.json` and shows, per cleared source, the scrape
// or fetch configuration (crawl bounds + rate/politeness guardrails, or endpoint +
// paging), the capture state (staged / estimate), and a live-run progress bar when
// a crawl is running. Transcribed from collection/panes.jsx · AcquirePane.

import { useStageJson } from "./useStageJson";
import { type AcquirePlan, type AcquireSource } from "./dataCollection";
import { Card, ModeChip, Readiness, Kv } from "./DataCollectionPrimitives";

const mono = "var(--mono)";

/** A guardrail pill (rate / concurrency / robots / …). `ok` tints it green. */
function Guard({ k, v, ok }: { k: string; v: string; ok?: boolean }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 6,
      fontFamily: mono, fontSize: 10, color: ok ? "var(--success)" : "var(--fg-muted)",
      background: ok ? "color-mix(in oklch, var(--success), transparent 90%)" : "var(--bg-elev)",
      border: "1px solid " + (ok ? "color-mix(in oklch, var(--success), transparent 72%)" : "var(--border-soft)"),
    }}>
      <span style={{ color: "var(--fg-dim)", textTransform: "uppercase", fontSize: 8.5, letterSpacing: ".05em" }}>{k}</span>{v}
    </span>
  );
}

function SourceCard({ s }: { s: AcquireSource }) {
  const isScrape = s.mode === "scrape";
  const running = s.status === "running" && !!s.run;
  const notRun = s.status === "not run";
  return (
    <Card
      label={`${isScrape ? "scrape" : "fetch"} · ${s.label}`}
      badge={<ModeChip mode={s.mode} />}
      hint={running ? "running" : notRun ? "not captured" : "ready"}
    >
      {isScrape ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 9 }}>
            <Kv k="start urls" v={s.crawl?.start?.join(", ")} />
            <Kv k="depth" v={s.crawl?.depth != null ? String(s.crawl.depth) : undefined} />
            <Kv k="include" v={s.crawl?.include} />
            <Kv k="exclude" v={s.crawl?.exclude} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {s.rate?.rps && <Guard k="rate" v={s.rate.rps} />}
            {s.rate?.concurrency != null && <Guard k="concurrency" v={String(s.rate.concurrency)} />}
            {s.rate?.delay && <Guard k="politeness" v={s.rate.delay} />}
            <Guard k="robots" v="✓ respected" ok />
            <Guard k="js render" v={s.options?.jsRender ? "on" : "off"} />
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 9 }}>
            <Kv k="endpoint" v={s.endpoint} />
            <Kv k="auth" v={s.auth} />
            <Kv k="paging" v={s.paging ? `${s.paging.kind ?? "—"} · ${s.paging.pageSize ?? "?"}/page` : undefined} />
            <Kv k="format" v={s.format} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {s.schedule && <Guard k="schedule" v={s.schedule} />}
            <Guard k="auth" v="name only" ok />
          </div>
        </>
      )}

      {/* live run OR capture summary */}
      {running && s.run ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--accent)", animation: "pulse 1.4s ease-in-out infinite" }} />
            <span style={{ fontFamily: mono, fontSize: 10, color: "var(--accent)" }}>{s.run.note}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: mono, fontSize: 10, color: "var(--fg-dim)" }}>{s.run.done} / ~{s.run.total} pages</span>
          </div>
          <div style={{ height: 5, borderRadius: 99, background: "var(--bg-elev2)", overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: `${Math.min(100, ((s.run.done ?? 0) / (s.run.total || 1)) * 100)}%`, background: "var(--accent)" }} />
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 7, fontFamily: mono, fontSize: 10, color: "var(--fg-dim)" }}>
            <span>rate <b style={{ color: "var(--fg)" }}>{s.run.rate}</b></span>
            <span>errors <b style={{ color: s.run.errors ? "var(--accent)" : "var(--fg)" }}>{s.run.errors ?? 0}</b></span>
            <span>robots <b style={{ color: "var(--success)" }}>✓</b></span>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <span style={{ fontSize: 12 }}>{isScrape ? "📄" : "{ }"}</span>
          <span style={{ fontFamily: mono, fontSize: 10, color: "var(--fg-dim)" }}>
            {notRun ? `estimate ${s.estimate ?? "—"}` : `captured ${s.captured ?? "—"}`}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{
            fontFamily: mono, fontSize: 8.5, padding: "1px 6px", borderRadius: 4,
            color: notRun ? "var(--accent)" : "var(--success)",
            border: "1px solid " + (notRun ? "var(--accent-dim)" : "color-mix(in oklch, var(--success), transparent 65%)"),
          }}>{notRun ? "not run" : "staged ✓"}</span>
        </div>
      )}
    </Card>
  );
}

export function FocusedAcquireBody({ projectId }: { projectId?: string }) {
  const { data, loading } = useStageJson<AcquirePlan>(projectId, "dataAcquire");

  if (loading) {
    return <div className="empty-state" data-testid="acquire-loading"><span className="empty-icon">⤓</span>
      <span style={{ fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>Loading acquisition…</span></div>;
  }

  const sources = data?.sources ?? [];

  if (sources.length === 0) {
    return (
      <div data-testid="focused-acquire-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
        <Card label="per-source acquisition">
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <span className="empty-icon">⤓</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>Nothing to acquire yet</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)", maxWidth: 380, textAlign: "center", lineHeight: 1.5 }}>
              Cleared sources appear here once the planner writes <code>dataAcquire.json</code> — each with its scrape or fetch config.
            </span>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div data-testid="focused-acquire-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
      {sources.map((s) => <SourceCard key={s.id} s={s} />)}
      <Readiness
        checks={sources.map((s) => {
          const ok = s.status !== "not run" && s.status !== "running";
          return { id: s.id, label: `Raw artifacts captured · ${s.label}`, ok, detail: s.status === "running" ? "running…" : ok ? "staged" : "not run" };
        })}
        tail={<>Raw artifacts stage to a working area, then <b>Extract</b> parses them into rows.</>}
      />
    </div>
  );
}
