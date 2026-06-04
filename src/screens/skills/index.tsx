// Skills screen (#400 presentational → #404 real) — a library of reusable
// capability bundles (prompt + bundled tools + profile guardrails) the fleet can
// invoke. Reads/mutates the store `skills` slice; every enabled+scoped skill is
// written into a launched session as `.claude/skills/<slug>/SKILL.md`. Edits are
// live (no separate save). Invocation telemetry (leaderboard/success/trend) is
// still sample data on the seeded skills — a real usage hook is a follow-up.
import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import {
  KIND, PROFILE_COLOR, SOURCE_TAG, SKILL_CATALOG, fmtCount,
  type SkillKind, type SkillSource, type SkillProfile,
} from "../../data/skills";
import {
  blankSkill, defFromCatalog, deriveSkillKpis, parseSkillsFile, skillSlug, type SkillDef,
} from "../../lib/skills";
import { parseSkillLog, aggregateSkillTelemetry, type SkillStats } from "../../lib/skillTelemetry";
import { Spark, HBars, type HBarRow } from "./SkillsCharts";
import { TabBar, type TabItem } from "../../components/chrome/TabBar";
import { usePageTabs } from "../../hooks/usePageTabs";
import "./skills.css";

type Mode = "library" | "runs" | "catalog";

/** A GitHub Project (subset of the GraphQL `projectsV2` node) — for scoping. */
interface GhProject { id: string; number: number; title: string }
const PROJECTS_QUERY = `{ viewer { projectsV2(first: 50) { nodes { id title number } } } }`;

const KIND_KEYS = Object.keys(KIND) as SkillKind[];
const PROFILE_KEYS = Object.keys(PROFILE_COLOR) as SkillProfile[];
const SOURCE_KEYS: SkillSource[] = ["first-party", "team", "imported", "community"];

/** Success-rate → semantic color (matches the design thresholds). */
function successColor(success: number): string {
  return success >= 95 ? "var(--success)" : success >= 85 ? "var(--accent)" : "var(--danger)";
}

// ── small shared pieces ──────────────────────────────────────────────────────
interface StatCardProps {
  k: string; v: string; sub: string;
  tone?: "fg" | "accent" | "info" | "success" | "danger";
  delta?: { dir: "up" | "down" | "flat"; text: string };
}
function StatCard({ k, v, sub, tone, delta }: StatCardProps) {
  const color =
    tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)" :
    tone === "success" ? "var(--success)" : tone === "danger" ? "var(--danger)" : "var(--fg)";
  return (
    <div className="card statcard">
      <div className="k">{k}</div>
      <div className="v" style={{ color }}>{v}</div>
      <div className="sub">
        {delta && <span className={`delta ${delta.dir}`}>{delta.dir === "up" ? "▲" : delta.dir === "down" ? "▼" : "■"} {delta.text}</span>}
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

function ProfileDots({ profiles }: { profiles: SkillProfile[] }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {profiles.map(p => (
        <span key={p} title={p} style={{ width: 7, height: 7, borderRadius: "50%", background: PROFILE_COLOR[p] }} />
      ))}
      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>{profiles.join(" · ")}</span>
    </span>
  );
}

const MODES: Array<{ k: Mode; label: string; hint?: string }> = [
  { k: "library", label: "Library", hint: "reusable skills" },
  { k: "runs", label: "Runs" },
  { k: "catalog", label: "Catalog" },
];
const SKILL_TABS: TabItem[] = MODES.map((m) => ({ id: m.k, label: m.label }));

// ── page ─────────────────────────────────────────────────────────────────────
export function SkillsScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
  const skills           = useAppStore(s => s.skills);
  const addSkill         = useAppStore(s => s.addSkill);
  const updateSkill      = useAppStore(s => s.updateSkill);
  const removeSkill      = useAppStore(s => s.removeSkill);
  const toggleSkillPin   = useAppStore(s => s.toggleSkillPin);
  const upsertSkills     = useAppStore(s => s.upsertSkills);
  const setSkillProjects = useAppStore(s => s.setSkillProjects);
  const githubToken      = useAppStore(s => s.githubToken);

  const [filter, setFilter] = useState<"all" | SkillKind>("all");
  const [catalogQuery, setCatalogQuery] = useState("");
  const { tabs: skillTabs, activeId, select, reorder, tearOff } = usePageTabs("skills", SKILL_TABS);
  // The active tab selects which view renders; a detached-section override (#463)
  // pins the view for a torn-off window.
  const mode: Mode = (sectionOverride ?? activeId) as Mode;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The user's GitHub Projects for per-skill scoping (mirrors Extensions). No
  // token / empty / failure all collapse to "global only" — never a crash.
  const [projects, setProjects] = useState<GhProject[]>([]);
  useEffect(() => {
    if (!githubToken) return;
    let cancelled = false;
    invoke<{ viewer: { projectsV2: { nodes: GhProject[] } } }>("github_graphql", {
      token: githubToken, query: PROJECTS_QUERY, variables: null,
    })
      .then(d => { if (!cancelled) setProjects(d?.viewer?.projectsV2?.nodes ?? []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [githubToken]);

  // Real invocation telemetry from the skill-usage log (#406), polled while the
  // screen is open. Keyed by skill-name slug; merged over the library below.
  const [stats, setStats] = useState<Record<string, SkillStats>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const lines = await invoke<string[]>("read_skill_log", { limit: 4000 }).catch(() => [] as string[]);
      if (cancelled) return;
      setStats(aggregateSkillTelemetry(parseSkillLog((lines ?? []).join("\n")), new Date()));
    };
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Merge telemetry over each skill: invocations + 7-day trend, and `success` as
  // the real success RATE (0–100), so the cards/leaderboard/KPIs render live data.
  const merged = useMemo<SkillDef[]>(() => skills.map(s => {
    const st = stats[skillSlug(s.name)];
    return st
      ? { ...s, invocations: st.invocations, success: st.successRate, trend: st.trend }
      : { ...s, invocations: 0, success: 0, trend: [] };
  }), [skills, stats]);

  const kinds: Array<"all" | SkillKind> = ["all", ...KIND_KEYS];
  const list = filter === "all" ? merged : merged.filter(s => s.kind === filter);
  const kpis = useMemo(() => deriveSkillKpis(merged), [merged]);
  const invToday = useMemo(() => Object.values(stats).reduce((a, s) => a + s.today, 0), [stats]);
  const activeCount = useMemo(() => merged.filter(s => s.invocations > 0).length, [merged]);
  const selected = selectedId ? skills.find(s => s.id === selectedId) ?? null : null;

  // Workhorse (most invoked) + least-reliable (lowest success among the used),
  // derived from the live, telemetry-merged list. Null until there's real usage.
  const workhorse = merged.filter(s => s.invocations > 0)
    .reduce<SkillDef | null>((a, s) => (!a || s.invocations > a.invocations ? s : a), null);
  const leastReliable = merged.filter(s => s.invocations > 0)
    .reduce<SkillDef | null>((a, s) => (!a || s.success < a.success ? s : a), null);

  function patch(id: string, p: Partial<SkillDef>) { updateSkill(id, p); }
  function newSkill() { setSelectedId(addSkill(blankSkill())); }
  function addFromCatalog(name: string) { setSelectedId(addSkill(defFromCatalog(name))); }

  function importSkills(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      // Accept either a single skill object or an array; parseSkillsFile wants an array.
      let normalized = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed && !Array.isArray(parsed)) normalized = JSON.stringify([parsed]);
      } catch { /* parseSkillsFile will return [] for malformed input */ }
      const defs = parseSkillsFile(normalized);
      if (defs.length) upsertSkills(defs);
    };
    reader.readAsText(file);
  }

  // ── drawer body ──────────────────────────────────────────────────────────────
  function toggleProfile(s: SkillDef, p: SkillProfile) {
    const next = s.profiles.includes(p) ? s.profiles.filter(x => x !== p) : [...s.profiles, p];
    patch(s.id, { profiles: next });
  }
  function toggleProject(s: SkillDef, pid: string) {
    const next = s.projects.includes(pid) ? s.projects.filter(x => x !== pid) : [...s.projects, pid];
    setSkillProjects(s.id, next);
  }

  function drawerBody(s: SkillDef) {
    const isGlobal = s.projects.length === 0;
    return (
      <>
        <div className="field">
          <label>name</label>
          <input className="input" value={s.name} placeholder="Skill name" onChange={e => patch(s.id, { name: e.target.value })} />
        </div>

        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className="hint">enabled</span>
            <div className={"toggle" + (s.enabled ? " on" : "")} title={s.enabled ? "enabled" : "disabled"} onClick={() => patch(s.id, { enabled: !s.enabled })} />
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className="hint">pinned</span>
            <div className={"toggle" + (s.pinned ? " on" : "")} title={s.pinned ? "pinned" : "not pinned"} onClick={() => patch(s.id, { pinned: !s.pinned })} />
          </span>
        </div>

        <div className="field">
          <label>kind</label>
          <div className="scope">
            {KIND_KEYS.map(k => (
              <button key={k} className={s.kind === k ? "on" : ""} onClick={() => patch(s.id, { kind: k })}>{KIND[k].label}</button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>source</label>
          <div className="scope">
            {SOURCE_KEYS.map(src => (
              <button key={src} className={s.source === src ? "on" : ""} onClick={() => patch(s.id, { source: src })}>{src}</button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>description</label>
          <input className="input" value={s.desc} placeholder="One line — shown on the card + SKILL.md frontmatter" onChange={e => patch(s.id, { desc: e.target.value })} />
        </div>

        <div className="field">
          <label>prompt — the reusable procedure</label>
          <textarea className="ta" value={s.prompt} placeholder="The steps the agent follows when it invokes this skill…" onChange={e => patch(s.id, { prompt: e.target.value })} />
        </div>

        <div className="field">
          <label>bundled tools (comma-separated)</label>
          <input className="input" value={s.tools.join(", ")} placeholder="create_pr, git_diff, run_tests"
            onChange={e => patch(s.id, { tools: e.target.value.split(",").map(t => t.trim()).filter(Boolean) })} />
        </div>

        <div className="field">
          <label>allowed profiles</label>
          <div className="scope">
            {PROFILE_KEYS.map(p => (
              <button key={p} className={s.profiles.includes(p) ? "on" : ""} onClick={() => toggleProfile(s, p)}>{p}</button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>project assignment</label>
          <div className="global-banner" style={isGlobal ? undefined : { opacity: 0.6 }}>
            <span className="gd" />
            <b style={{ color: isGlobal ? "var(--success)" : "var(--fg-muted)", fontWeight: 600 }}>Global (all projects)</b>
            <div style={{ flex: 1 }} />
            <div className={"toggle" + (isGlobal ? " on" : "")} title={isGlobal ? "global" : "scoped"}
              onClick={() => setSkillProjects(s.id, isGlobal ? (projects[0] ? [projects[0].id] : []) : [])} />
          </div>
          {!isGlobal && (
            projects.length === 0
              ? <div className="hint" style={{ marginTop: 6 }}>No projects — global only. Connect GitHub in Settings to scope per project.</div>
              : (
                <div className="proj-multi" style={{ marginTop: 6 }}>
                  {projects.map(p => {
                    const sel = s.projects.includes(p.id);
                    return (
                      <div key={p.id} className={"pm-row" + (sel ? " on" : "")} onClick={() => toggleProject(s, p.id)}>
                        <div className="check">{sel ? "✓" : ""}</div>
                        <div className="pname">{p.title} <span className="hint">#{p.number}</span></div>
                      </div>
                    );
                  })}
                </div>
              )
          )}
          <div className="hint" style={{ marginTop: 6 }}>Global applies to every project; otherwise only the projects you pick.</div>
        </div>
      </>
    );
  }

  // ── right rail ───────────────────────────────────────────────────────────────
  const leaderboardRows: HBarRow[] = [...merged]
    .filter(s => s.invocations > 0)
    .sort((a, b) => b.invocations - a.invocations).slice(0, 6)
    .map(s => ({
      label: s.name, value: s.invocations, color: KIND[s.kind].color, strong: true,
      icon: <span style={{ fontSize: 11, color: KIND[s.kind].color }}>{KIND[s.kind].glyph}</span>,
    }));

  const byKind = useMemo(() => {
    const acc: Partial<Record<SkillKind, { inv: number; ok: number }>> = {};
    merged.forEach(s => {
      const a = (acc[s.kind] ??= { inv: 0, ok: 0 });
      a.inv += s.invocations; a.ok += s.invocations * s.success / 100;
    });
    return (Object.entries(acc) as Array<[SkillKind, { inv: number; ok: number }]>)
      .filter(([, v]) => v.inv > 0)
      .map(([k, v]) => ({ kind: k, rate: Math.round(v.ok / v.inv * 100) }))
      .sort((a, b) => b.rate - a.rate);
  }, [merged]);

  // ── Runs view: skills that have actually been invoked, newest-first. ──────────
  const runRows = useMemo(
    () => [...merged].filter(s => s.invocations > 0).sort((a, b) => b.invocations - a.invocations),
    [merged],
  );

  // ── Catalog view: the browsable catalog, filtered + flagged when already added.
  const existingSkillNames = useMemo(() => new Set(skills.map(s => s.name)), [skills]);
  const catalogList = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    return q
      ? SKILL_CATALOG.filter(c =>
          c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q) || c.by.toLowerCase().includes(q))
      : SKILL_CATALOG;
  }, [catalogQuery]);

  // KPI row — shown on both the Library and Runs views.
  const kpiRow = (
    <div className="statgrid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
      <StatCard k="skills" v={String(kpis.total)} sub="in library" tone="fg" />
      <StatCard k="invocations · today" v={String(invToday)} sub="across all workers" tone="accent" />
      <StatCard k="avg success" v={kpis.invWeek ? `${kpis.avgSuccess}%` : "—"} sub="weighted by use" tone="success" />
      <StatCard k="invocations · 7d" v={fmtCount(kpis.invWeek)} sub="fleet-wide" tone="info" />
      <StatCard k="pinned" v={String(kpis.pinned)} sub="auto-available to fleet" tone="fg" />
      <StatCard k="active · 7d" v={String(activeCount)} sub="skills used at least once" tone="info" />
    </div>
  );

  return (
    <div className="skills-screen">
      {!sectionOverride && (
        <TabBar
          tabs={skillTabs}
          activeId={activeId}
          onSelect={select}
          onReorder={reorder}
          onTearOff={tearOff}
          right={<span className="sync">● github sync</span>}
        />
      )}

      <section className="an-page">
        <div className="an-wrap">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Skills</h2>
              <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
                Reusable capability bundles your fleet can invoke · prompt + bundled tools + profile guardrails
              </div>
            </div>
            <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) importSkills(f); e.target.value = ""; }} />
            <button className="btn" onClick={() => fileRef.current?.click()}>import skill</button>
            <button className="btn primary" onClick={newSkill}>+ new skill</button>
          </div>

          {mode === "library" && (<>
          {/* digest */}
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
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".06em" }}>skills · library</span>
                  <span className="hint">reusable capability bundles · invoked by the fleet</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn ghost" style={{ height: 22, fontSize: 10 }} onClick={() => select("runs")}>view runs</button>
                </div>
                <p style={{ margin: 0 }}>
                  <b style={{ color: "var(--fg)" }}>{kpis.total} skills</b> available to the fleet.
                  {kpis.invWeek === 0
                    ? <> No invocations recorded yet — run the fleet to populate these metrics.</>
                    : <> Invoked <b style={{ color: "var(--fg)" }}>{invToday}×</b> today at <b style={{ color: "var(--success)" }}>{kpis.avgSuccess}% success</b>.
                        {workhorse && <> <b style={{ color: "var(--accent)" }}>{workhorse.name}</b> is the workhorse;</>}
                        {leastReliable && leastReliable.id !== workhorse?.id && <> <b style={{ color: "var(--danger)" }}>{leastReliable.name}</b> is the least reliable at {leastReliable.success}% — worth tightening its guardrails.</>}
                      </>}
                </p>
              </div>
            </div>
          </div>

          {/* KPI row */}
          {kpiRow}

          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
            <div style={{ minWidth: 0 }}>
              <div className="seg" style={{ marginBottom: 12 }}>
                {kinds.map(k => (
                  <button key={k} className={k === filter ? "on" : ""} onClick={() => setFilter(k)}>
                    {k === "all" ? "all" : KIND[k].label}
                  </button>
                ))}
              </div>

              {list.length === 0 ? (
                <div className="empty">
                  <h3 style={{ margin: 0 }}>No skills yet</h3>
                  <p className="hint" style={{ maxWidth: 360, margin: 0 }}>
                    Create a skill, import one, or add from the catalog. Enabled skills are written into every agent session your fleet runs.
                  </p>
                  <button className="btn primary" onClick={newSkill}>+ new skill</button>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {list.map(s => {
                    const kind = KIND[s.kind];
                    const src = SOURCE_TAG[s.source];
                    const sc = successColor(s.success);
                    return (
                      <div key={s.id} className={"card hrow skill-card" + (s.enabled ? "" : " off")} style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}
                        onClick={() => setSelectedId(s.id)}>
                        <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
                          <SkillIcon kind={s.kind} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", fontWeight: 600 }}>{s.name || "Untitled skill"}</span>
                              <button className="pin-btn" title={s.pinned ? "pinned · click to unpin" : "click to pin"}
                                style={{ color: s.pinned ? "var(--accent)" : "var(--fg-dim)" }}
                                onClick={e => { e.stopPropagation(); toggleSkillPin(s.id); }}>★</button>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                              <span className="tag" style={{ fontSize: 8.5, color: kind.color, borderColor: `color-mix(in oklch, ${kind.color}, transparent 70%)` }}>{kind.label}</span>
                              <span className={"tag " + src.cls} style={{ fontSize: 8.5 }}>{src.label}</span>
                            </div>
                          </div>
                          {s.trend.length > 1 && <Spark data={s.trend} color={kind.color} />}
                        </div>

                        <p style={{ margin: 0, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, textWrap: "pretty" }}>{s.desc || <span className="hint">No description yet.</span>}</p>

                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                          {s.tools.map(t => <span key={t} className="kbd" style={{ fontSize: 9 }}>{t}</span>)}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 9, borderTop: "1px solid var(--border-soft)" }}>
                          <ProfileDots profiles={s.profiles} />
                          <div style={{ flex: 1 }} />
                          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>{fmtCount(s.invocations)}×</span>
                          {s.invocations > 0 ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                              <span style={{ width: 42 }} className="meter"><i style={{ width: `${s.success}%`, background: sc }} /></span>
                              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: sc, width: 26, textAlign: "right" }}>{s.success}%</span>
                            </span>
                          ) : (
                            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>not run yet</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
              <div className="card">
                <CardHead title="Most invoked" hint="last 7 days" />
                <HBars rows={leaderboardRows} fmtV={(v) => `${v}×`} />
              </div>

              <div className="card">
                <CardHead title="Success by kind" hint="weighted by invocations" />
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {byKind.map(r => {
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

              <div className="card">
                <CardHead title="Add a skill" hint="from the catalog" right={<button className="btn ghost" style={{ height: 22, fontSize: 10 }} onClick={() => select("catalog")}>browse all</button>} />
                <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                  {SKILL_CATALOG.map((c, i) => (
                    <div key={c.name} className="hrow" style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                      <span style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0, background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{c.glyph}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)" }}>{c.name}</div>
                        <div style={{ fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.desc}</div>
                      </div>
                      <button className="btn" style={{ height: 22, fontSize: 10, padding: "0 8px" }} onClick={() => addFromCatalog(c.name)}>add</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          </>)}

          {mode === "runs" && (<>
          {kpiRow}
          <div className="card" style={{ marginTop: 14 }}>
            <CardHead title="Invocations" hint="live from the skill-usage log · last 7 days"
              right={<button className="btn ghost" style={{ height: 22, fontSize: 10 }} onClick={() => select("library")}>back to library</button>} />
            {runRows.length === 0 ? (
              <div className="empty">
                <h3 style={{ margin: 0 }}>No runs yet</h3>
                <p className="hint" style={{ maxWidth: 420, margin: 0 }}>
                  No skill invocations have been recorded. Run the fleet — each time an agent invokes a
                  skill it's logged here with its success rate and 7-day trend.
                </p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.6fr 86px 60px 64px 90px", gap: 10, padding: "8px 12px", background: "var(--bg-panel)", fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em" }}>
                  <span>skill</span>
                  <span style={{ textAlign: "right" }}>invocations</span>
                  <span style={{ textAlign: "right" }}>today</span>
                  <span style={{ textAlign: "right" }}>success</span>
                  <span style={{ textAlign: "right" }}>7-day</span>
                </div>
                {runRows.map((s, i) => {
                  const kind = KIND[s.kind];
                  const sc = successColor(s.success);
                  const today = stats[skillSlug(s.name)]?.today ?? 0;
                  return (
                    <div key={s.id} className="hrow" style={{ display: "grid", gridTemplateColumns: "1.6fr 86px 60px 64px 90px", gap: 10, alignItems: "center", padding: "9px 12px", background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)", cursor: "pointer" }}
                      onClick={() => setSelectedId(s.id)}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ color: kind.color }}>{kind.glyph}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name || "Untitled skill"}</span>
                      </span>
                      <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>{fmtCount(s.invocations)}</span>
                      <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>{today}</span>
                      <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: sc }}>{s.success}%</span>
                      <span style={{ display: "flex", justifyContent: "flex-end" }}>
                        {s.trend.length > 1 ? <Spark data={s.trend} color={kind.color} /> : <span className="hint">—</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </>)}

          {mode === "catalog" && (
          <div style={{ marginTop: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <input className="input" placeholder="Search the catalog…" value={catalogQuery}
                onChange={e => setCatalogQuery(e.target.value)} style={{ maxWidth: 320 }} />
              <span className="hint">{catalogList.length} of {SKILL_CATALOG.length} skills</span>
            </div>
            {catalogList.length === 0 ? (
              <div className="empty">
                <h3 style={{ margin: 0 }}>No matches</h3>
                <p className="hint" style={{ margin: 0 }}>Nothing in the catalog matches your search.</p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                {catalogList.map(c => {
                  const added = existingSkillNames.has(c.name);
                  return (
                    <div key={c.name} className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
                        <span style={{ width: 30, height: 30, borderRadius: 7, flexShrink: 0, background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)", fontSize: 15, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{c.glyph}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", fontWeight: 600 }}>{c.name}</div>
                          <div className="hint" style={{ fontSize: 9.5 }}>by {c.by}</div>
                        </div>
                      </div>
                      <p style={{ margin: 0, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, flex: 1 }}>{c.desc}</p>
                      <button className="btn" disabled={added} onClick={() => addFromCatalog(c.name)}
                        style={added ? { opacity: 0.6, cursor: "default" } : undefined}>
                        {added ? "✓ added" : "add to library"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}
        </div>
      </section>

      {/* edit drawer */}
      <div className={"scrim" + (selected ? " on" : "")} onClick={() => setSelectedId(null)} />
      <div className={"drawer" + (selected ? " on" : "")}>
        {selected && (
          <>
            <div className="dr-head">
              <SkillIcon kind={selected.kind} size={20} />
              <div className="name">{selected.name || "Untitled skill"}</div>
              <button className="x" title="close" onClick={() => setSelectedId(null)}>×</button>
            </div>
            <div className="dr-body">{drawerBody(selected)}</div>
            <div className="dr-foot">
              <button className="btn ghost danger" onClick={() => { removeSkill(selected.id); setSelectedId(null); }}>remove</button>
              <div className="spacer" />
              <button className="btn primary" onClick={() => setSelectedId(null)}>done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
