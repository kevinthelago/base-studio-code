/* global React, ReactDOM, SKILLDATA, Titlebar, Rail, ModeStrip, StatusBar, Avatar, CardHead, StatCard, useTip, HBars, Legend, fmt */
const { useState } = React;
const S = window.SKILLDATA;

// tiny inline sparkline
function Spark({ data, color, w = 70, h = 20 }) {
  const max = Math.max(1, ...data), min = Math.min(...data);
  const span = max - min || 1;
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => h - 2 - ((v - min) / span) * (h - 4);
  const line = data.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      <path d={`${line} L ${w} ${h} L 0 ${h} Z`} fill={color} opacity="0.13" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r="2" fill={color} />
    </svg>
  );
}

function SkillIcon({ kind, size = 30 }) {
  const k = S.KIND[kind];
  return (
    <span style={{
      width: size, height: size, borderRadius: 7, flexShrink: 0,
      background: `color-mix(in oklch, ${k.color} 22%, var(--bg-elev))`,
      border: `1px solid color-mix(in oklch, ${k.color}, transparent 55%)`,
      color: k.color, fontSize: size * 0.5,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
    }}>{k.glyph}</span>
  );
}

function ProfileDots({ profiles }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {profiles.map(p => (
        <span key={p} title={p} style={{
          width: 7, height: 7, borderRadius: "50%", background: S.PROFILE_COLOR[p],
        }} />
      ))}
      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
        {profiles.join(" · ")}
      </span>
    </span>
  );
}

// ── digest ───────────────────────────────────────────────────────────────────
function SkillsDigest() {
  return (
    <div className="card" style={{
      padding: "13px 18px", marginBottom: 14,
      background: "linear-gradient(135deg, color-mix(in oklch, var(--accent), transparent 88%), var(--bg-panel) 60%)",
      border: "1px solid var(--accent-dim)",
    }}>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{
          flexShrink: 0, width: 28, height: 28, borderRadius: 7,
          background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
          color: "#1a120a", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 13,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>C</div>
        <div style={{ flex: 1, fontSize: 12, lineHeight: 1.6, color: "var(--fg-muted)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".06em" }}>
              skills · library
            </span>
            <span className="hint">reusable capability bundles · invoked by the fleet</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" style={{ height: 22, fontSize: 10 }}>view runs</button>
          </div>
          <p style={{ margin: 0 }}>
            <b style={{ color: "var(--fg)" }}>{S.SKILL_KPIS.total} skills</b> available to the fleet — invoked
            <b style={{ color: "var(--fg)" }}> {S.SKILL_KPIS.invToday}×</b> today at <b style={{ color: "var(--success)" }}>{S.SKILL_KPIS.avgSuccess}% success</b>.
            <b style={{ color: "var(--accent)" }}> Open a clean PR</b> is the workhorse; <b style={{ color: "var(--danger)" }}>Bump dependency safely</b> is
            the least reliable at 78% — worth tightening its guardrails.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── KPI row ──────────────────────────────────────────────────────────────────
function KpiRow() {
  const k = S.SKILL_KPIS;
  const cards = [
    { k: "skills", v: String(k.total), sub: "in library", tone: "fg" },
    { k: "invocations · today", v: String(k.invToday), sub: "across all workers", tone: "accent", delta: { dir: "up", text: "+64" } },
    { k: "avg success", v: `${k.avgSuccess}%`, sub: "weighted by use", tone: "success", delta: { dir: "up", text: "+2%" } },
    { k: "invocations · 7d", v: fmt(k.invWeek), sub: "fleet-wide", tone: "info" },
    { k: "pinned", v: String(k.enabled), sub: "auto-available to fleet", tone: "fg" },
    { k: "tokens saved · 7d", v: `${k.tokensSavedM}M`, sub: "vs ad-hoc prompting", tone: "success" },
  ];
  return (
    <div className="statgrid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
      {cards.map(c => <StatCard key={c.k} {...c} />)}
    </div>
  );
}

// ── skill card ───────────────────────────────────────────────────────────────
function SkillCard({ s }) {
  const kind = S.KIND[s.kind];
  const src = S.SOURCE_TAG[s.source];
  const sc = s.success >= 95 ? "var(--success)" : s.success >= 85 ? "var(--accent)" : "var(--danger)";
  return (
    <div className="card hrow" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
        <SkillIcon kind={s.kind} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", fontWeight: 600 }}>{s.name}</span>
            {s.pinned && <span title="pinned · auto-available" style={{ color: "var(--accent)", fontSize: 11 }}>★</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
            <span className="tag" style={{ fontSize: 8.5, color: kind.color, borderColor: `color-mix(in oklch, ${kind.color}, transparent 70%)` }}>{kind.label}</span>
            <span className={"tag " + src.cls} style={{ fontSize: 8.5 }}>{src.label}</span>
          </div>
        </div>
        <Spark data={s.trend} color={kind.color} />
      </div>

      <p style={{ margin: 0, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, textWrap: "pretty" }}>{s.desc}</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {s.tools.map(t => (
          <span key={t} className="kbd" style={{ fontSize: 9 }}>{t}</span>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 9, borderTop: "1px solid var(--border-soft)" }}>
        <ProfileDots profiles={s.profiles} />
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{s.avgTokensK}k avg</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>{fmt(s.invocations)}×</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 42 }} className="meter"><i style={{ width: `${s.success}%`, background: sc }} /></span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: sc, width: 26, textAlign: "right" }}>{s.success}%</span>
        </span>
      </div>
    </div>
  );
}

// ── right rail: leaderboard ──────────────────────────────────────────────────
function Leaderboard() {
  const rows = [...S.SKILLS].sort((a, b) => b.invocations - a.invocations).slice(0, 6).map(s => ({
    label: s.name, value: s.invocations, color: S.KIND[s.kind].color, strong: true,
    icon: <span style={{ fontSize: 11, color: S.KIND[s.kind].color }}>{S.KIND[s.kind].glyph}</span>,
  }));
  return (
    <div className="card">
      <CardHead title="Most invoked" hint="last 7 days" />
      <HBars rows={rows} fmtV={(v) => `${v}×`} />
    </div>
  );
}

// ── right rail: success by kind ──────────────────────────────────────────────
function SuccessByKind() {
  const byKind = {};
  S.SKILLS.forEach(s => {
    (byKind[s.kind] ??= { inv: 0, ok: 0 });
    byKind[s.kind].inv += s.invocations;
    byKind[s.kind].ok += s.invocations * s.success / 100;
  });
  const rows = Object.entries(byKind).map(([k, v]) => ({
    kind: k, rate: Math.round(v.ok / v.inv * 100), inv: v.inv,
  })).sort((a, b) => b.rate - a.rate);
  return (
    <div className="card">
      <CardHead title="Success by kind" hint="weighted by invocations" />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map(r => {
          const c = S.KIND[r.kind];
          const sc = r.rate >= 95 ? "var(--success)" : r.rate >= 85 ? "var(--accent)" : "var(--danger)";
          return (
            <div key={r.kind} style={{ display: "grid", gridTemplateColumns: "82px 1fr 34px", gap: 8, alignItems: "center" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
                <span style={{ color: c.color }}>{c.glyph}</span>{c.label}
              </span>
              <div className="meter" style={{ height: 6 }}><i style={{ width: `${r.rate}%`, background: sc }} /></div>
              <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 10, color: sc }}>{r.rate}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── right rail: catalog (add more) ───────────────────────────────────────────
function Catalog() {
  return (
    <div className="card">
      <CardHead title="Add a skill" hint="from the catalog" right={<button className="btn ghost" style={{ height: 22, fontSize: 10 }}>browse all</button>} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        {S.CATALOG.map((c, i) => (
          <div key={c.name} className="hrow" style={{
            display: "flex", alignItems: "center", gap: 10, padding: "9px 11px",
            background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
          }}>
            <span style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0, background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{c.glyph}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)" }}>{c.name}</div>
              <div style={{ fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.desc}</div>
            </div>
            <button className="btn" style={{ height: 22, fontSize: 10, padding: "0 8px" }}>add</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
function SkillsView() {
  const [filter, setFilter] = useState("all");
  const kinds = ["all", ...Object.keys(S.KIND)];
  const list = filter === "all" ? S.SKILLS : S.SKILLS.filter(s => s.kind === filter);
  return (
    <div className="app">
      <Titlebar workspace="Skills — library"
        meta={[{ label: "skills", value: S.SKILL_KPIS.total }, { label: "success", value: `${S.SKILL_KPIS.avgSuccess}%` }]} />
      <div className="shell">
        <Rail active="skills" />
        <div className="main">
          <ModeStrip active="library" sync="github sync"
            modes={[
              { k: "library", label: "Library", hint: "reusable skills", href: "Skills.html" },
              { k: "runs", label: "Runs", href: "#" },
              { k: "catalog", label: "Catalog", href: "#" },
            ]} />
          <div className="page">
            <section className="an-page">
              <div className="an-wrap">
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
                  <div style={{ flex: 1 }}>
                    <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Skills</h2>
                    <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
                      Reusable capability bundles your fleet can invoke · prompt + bundled tools + profile guardrails
                    </div>
                  </div>
                  <button className="btn">import skill</button>
                  <button className="btn primary">+ new skill</button>
                </div>

                <SkillsDigest />
                <KpiRow />

                <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="seg" style={{ marginBottom: 12 }}>
                      {kinds.map(k => (
                        <button key={k} className={k === filter ? "on" : ""} onClick={() => setFilter(k)}>
                          {k === "all" ? "all" : S.KIND[k].label}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      {list.map(s => <SkillCard key={s.id} s={s} />)}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                    <Leaderboard />
                    <SuccessByKind />
                    <Catalog />
                  </div>
                </div>
              </div>
            </section>
          </div>
          <StatusBar items={[
            { tone: "", text: `${S.SKILL_KPIS.total} skills loaded` },
            { tone: "", text: `${S.SKILL_KPIS.invToday} invocations today` },
            { tone: "warn", text: "bump-dep-safely 78%" },
          ]} />
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<SkillsView />);
