// Skills screen (#400) — a library of reusable capability bundles (prompt +
// bundled tools + profile guardrails) the fleet can invoke. Ported from
// design/fleet-github-skills/js/skillsView.jsx. Presentational: it renders off
// data/skills.ts (sample data, shaped to mirror Extensions so live data is a
// drop-in later). The only interactive state is the kind filter. The app shell
// (Titlebar / Rail / StatusBar) is provided by App.tsx.
import { useState, type ReactNode } from "react";
import {
  KIND, PROFILE_COLOR, SOURCE_TAG, SKILLS, SKILL_CATALOG, SKILL_KPIS, fmtCount,
  type Skill, type SkillKind,
} from "../../data/skills";
import { Spark, HBars, type HBarRow } from "./SkillsCharts";
import "./skills.css";

type Mode = "library" | "runs" | "catalog";

/** Success-rate → semantic color (matches the design thresholds). */
function successColor(success: number): string {
  return success >= 95 ? "var(--success)" : success >= 85 ? "var(--accent)" : "var(--danger)";
}

// ── small shared pieces ──────────────────────────────────────────────────────
interface StatCardProps {
  k: string;
  v: string;
  sub: string;
  tone?: "fg" | "accent" | "info" | "success" | "danger";
  delta?: { dir: "up" | "down" | "flat"; text: string };
}

function StatCard({ k, v, sub, tone, delta }: StatCardProps) {
  const color =
    tone === "accent" ? "var(--accent)" :
    tone === "info" ? "var(--info)" :
    tone === "success" ? "var(--success)" :
    tone === "danger" ? "var(--danger)" : "var(--fg)";
  return (
    <div className="card statcard">
      <div className="k">{k}</div>
      <div className="v" style={{ color }}>{v}</div>
      <div className="sub">
        {delta && (
          <span className={`delta ${delta.dir}`}>
            {delta.dir === "up" ? "▲" : delta.dir === "down" ? "▼" : "■"} {delta.text}
          </span>
        )}
        {sub}
      </div>
    </div>
  );
}

function CardHead({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {hint && <span className="hint">{hint}</span>}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

function SkillIcon({ kind, size = 30 }: { kind: SkillKind; size?: number }) {
  const k = KIND[kind];
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

function ProfileDots({ profiles }: { profiles: Skill["profiles"] }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {profiles.map(p => (
        <span key={p} title={p} style={{ width: 7, height: 7, borderRadius: "50%", background: PROFILE_COLOR[p] }} />
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
            <b style={{ color: "var(--fg)" }}>{SKILL_KPIS.total} skills</b> available to the fleet — invoked
            <b style={{ color: "var(--fg)" }}> {SKILL_KPIS.invToday}×</b> today at <b style={{ color: "var(--success)" }}>{SKILL_KPIS.avgSuccess}% success</b>.
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
  const k = SKILL_KPIS;
  const cards: StatCardProps[] = [
    { k: "skills", v: String(k.total), sub: "in library", tone: "fg" },
    { k: "invocations · today", v: String(k.invToday), sub: "across all workers", tone: "accent", delta: { dir: "up", text: "+64" } },
    { k: "avg success", v: `${k.avgSuccess}%`, sub: "weighted by use", tone: "success", delta: { dir: "up", text: "+2%" } },
    { k: "invocations · 7d", v: fmtCount(k.invWeek), sub: "fleet-wide", tone: "info" },
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
function SkillCard({ s }: { s: Skill }) {
  const kind = KIND[s.kind];
  const src = SOURCE_TAG[s.source];
  const sc = successColor(s.success);
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
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>{fmtCount(s.invocations)}×</span>
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
  const rows: HBarRow[] = [...SKILLS]
    .sort((a, b) => b.invocations - a.invocations)
    .slice(0, 6)
    .map(s => ({
      label: s.name, value: s.invocations, color: KIND[s.kind].color, strong: true,
      icon: <span style={{ fontSize: 11, color: KIND[s.kind].color }}>{KIND[s.kind].glyph}</span>,
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
  const byKind: Partial<Record<SkillKind, { inv: number; ok: number }>> = {};
  SKILLS.forEach(s => {
    const acc = (byKind[s.kind] ??= { inv: 0, ok: 0 });
    acc.inv += s.invocations;
    acc.ok += s.invocations * s.success / 100;
  });
  const rows = (Object.entries(byKind) as Array<[SkillKind, { inv: number; ok: number }]>)
    .map(([k, v]) => ({ kind: k, rate: Math.round(v.ok / v.inv * 100), inv: v.inv }))
    .sort((a, b) => b.rate - a.rate);
  return (
    <div className="card">
      <CardHead title="Success by kind" hint="weighted by invocations" />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map(r => {
          const c = KIND[r.kind];
          const sc = successColor(r.rate);
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
        {SKILL_CATALOG.map((c, i) => (
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

// ── mode strip (Library / Runs / Catalog) ────────────────────────────────────
const MODES: Array<{ k: Mode; label: string; hint?: string }> = [
  { k: "library", label: "Library", hint: "reusable skills" },
  { k: "runs", label: "Runs" },
  { k: "catalog", label: "Catalog" },
];

// ── page ─────────────────────────────────────────────────────────────────────
export function SkillsScreen() {
  const [filter, setFilter] = useState<"all" | SkillKind>("all");
  // Runs / Catalog are not built yet — Library is the only live mode.
  const [mode, setMode] = useState<Mode>("library");
  const kinds: Array<"all" | SkillKind> = ["all", ...(Object.keys(KIND) as SkillKind[])];
  const list = filter === "all" ? SKILLS : SKILLS.filter(s => s.kind === filter);

  return (
    <div className="skills-screen">
      <div className="modestrip">
        {MODES.map(m => (
          <button
            key={m.k}
            className={"m" + (m.k === mode ? " on" : "")}
            onClick={() => setMode(m.k)}
          >
            {m.label}
            {m.k === mode && m.hint && <span className="mh">· {m.hint}</span>}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span className="sync">● github sync</span>
      </div>

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
                    {k === "all" ? "all" : KIND[k].label}
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
  );
}
