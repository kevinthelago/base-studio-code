import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { KIND_META, PROFILE_META, SKILL_CATALOG, type CatalogItem } from "../../data/skills";
import {
  defFromCatalog, blankSkill, skillSlug,
  SKILL_KINDS, SKILL_PROFILES,
  type SkillDef, type SkillKind, type SkillProfile,
} from "../../lib/skills";
import {
  parseSkillLog, aggregateSkillLog, successRate, emptyStats,
  type SkillStats, type SkillLogLine,
} from "../../lib/skillTelemetry";
import "./skills.css";

type Mode = "library" | "runs" | "catalog";
type KindFilter = "all" | SkillKind;

/** A GitHub Project (subset of the GraphQL `projectsV2` node). */
interface GhProject { id: string; number: number; title: string; }

const PROJECTS_QUERY = `{
  viewer {
    projectsV2(first: 50) {
      nodes { id title number }
    }
  }
}`;

/** Color for a success rate: green ≥ 0.85, amber ≥ 0.6, danger below. */
function successColor(rate: number): string {
  if (rate >= 0.85) return "var(--success)";
  if (rate >= 0.6) return "var(--accent)";
  return "var(--danger)";
}

/** A tiny inline sparkline (no chart dep — #399 not yet landed). */
function Spark({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="sk-spark" title={`7-day trend · ${data.join(", ")}`}>
      {data.map((v, i) => (
        <span key={i} style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />
      ))}
    </div>
  );
}

/** A horizontal-bar leaderboard row. */
function HBar({ label, value, max, tone }: { label: string; value: number; max: number; tone?: string }) {
  return (
    <div className="sk-hbar">
      <span className="sk-hbar-label" title={label}>{label}</span>
      <span className="sk-hbar-track"><span className="sk-hbar-fill" style={{ width: `${(value / Math.max(1, max)) * 100}%`, background: tone ?? "var(--accent)" }} /></span>
      <span className="sk-hbar-val">{value}</span>
    </div>
  );
}

/** A small KPI tile. */
function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="sk-stat">
      <div className="sk-stat-v">{value}</div>
      <div className="sk-stat-k">{label}</div>
      {sub != null && <div className="sk-stat-sub">{sub}</div>}
    </div>
  );
}

/**
 * The Skills screen — a library of reusable capability bundles (prompt + bundled
 * tools + profile guardrails) the fleet can invoke. Reads + mutates the store
 * `skills`; every drawer edit is live. All metrics derive from the real usage log
 * (`read_skill_log`, #406) — the dashboard starts quiet and real usage fills it in.
 */
export function SkillsScreen() {
  const skills          = useAppStore(s => s.skills);
  const addSkill        = useAppStore(s => s.addSkill);
  const updateSkill     = useAppStore(s => s.updateSkill);
  const removeSkill     = useAppStore(s => s.removeSkill);
  const toggleSkill     = useAppStore(s => s.toggleSkill);
  const toggleSkillPin  = useAppStore(s => s.toggleSkillPin);
  const setSkillProjects = useAppStore(s => s.setSkillProjects);
  const githubToken     = useAppStore(s => s.githubToken);

  const [mode, setMode] = useState<Mode>(() => (skills.length === 0 ? "catalog" : "library"));
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Real usage telemetry (#406): read the app-wide skills.log once on mount and
  // aggregate per skill. A missing `read_skill_log` (backend not yet wired) or an
  // empty log collapses to zeros — never a crash, never fabricated numbers.
  const [logLines, setLogLines] = useState<SkillLogLine[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<string>("read_skill_log")
      .then(raw => { if (!cancelled) setLogLines(parseSkillLog(raw ?? "")); })
      .catch(() => { if (!cancelled) setLogLines([]); });
    return () => { cancelled = true; };
  }, []);

  // Stats keyed by skill slug (the log records the SKILL.md slug Claude invokes).
  const statsBySlug = useMemo<Record<string, SkillStats>>(
    () => aggregateSkillLog(logLines, Date.now()),
    [logLines],
  );
  const statsFor = (s: SkillDef): SkillStats => statsBySlug[skillSlug(s.name)] ?? emptyStats();

  // The user's GitHub Projects (for per-project scoping in the drawer).
  const [projects, setProjects] = useState<GhProject[]>([]);
  useEffect(() => {
    if (!githubToken) return;
    let cancelled = false;
    invoke<{ viewer: { projectsV2: { nodes: GhProject[] } } }>("github_graphql", {
      token: githubToken, query: PROJECTS_QUERY, variables: null,
    })
      .then(data => { if (!cancelled) setProjects(data?.viewer?.projectsV2?.nodes ?? []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [githubToken]);

  const selected = selectedId ? skills.find(s => s.id === selectedId) ?? null : null;

  // ── derived dashboard metrics (all from the live list + real log) ────────────
  const enabled = skills.filter(s => s.enabled);
  const pinnedCount = skills.filter(s => s.pinned).length;
  const invocationsTotal = skills.reduce((n, s) => n + statsFor(s).invocations, 0);
  const invocationsToday = skills.reduce((n, s) => n + statsFor(s).today, 0);
  const invocations7d = skills.reduce((n, s) => n + statsFor(s).trend.reduce((a, b) => a + b, 0), 0);
  // Weighted average success across all invoked skills.
  const totalSucc = skills.reduce((n, s) => n + statsFor(s).success, 0);
  const avgSuccess = invocationsTotal > 0 ? totalSucc / invocationsTotal : 0;

  // Workhorse + least-reliable callouts for the digest (only when there's usage).
  const invoked = skills.filter(s => statsFor(s).invocations > 0);
  const workhorse = invoked.slice().sort((a, b) => statsFor(b).invocations - statsFor(a).invocations)[0];
  const leastReliable = invoked.slice().sort((a, b) => successRate(statsFor(a)) - successRate(statsFor(b)))[0];

  // Leaderboard (most invoked) + success-by-kind, derived live.
  const leaderboard = invoked.slice().sort((a, b) => statsFor(b).invocations - statsFor(a).invocations).slice(0, 6);
  const byKind = SKILL_KINDS.map(k => {
    const ks = skills.filter(s => s.kind === k);
    const inv = ks.reduce((n, s) => n + statsFor(s).invocations, 0);
    const suc = ks.reduce((n, s) => n + statsFor(s).success, 0);
    return { kind: k, rate: inv > 0 ? suc / inv : 0, inv };
  }).filter(x => x.inv > 0);

  // ── helpers ──────────────────────────────────────────────────────────────────
  function patch(id: string, p: Partial<SkillDef>) { updateSkill(id, p); }

  function addAndSelect(seed: ReturnType<typeof blankSkill>) {
    addSkill(seed);
    const created = useAppStore.getState().skills;
    const last = created[created.length - 1];
    if (last) { setSelectedId(last.id); setMode("library"); }
  }

  function importSkill() {
    // Lightweight import: a blank skill the user fills in (a file picker is a
    // follow-up; the planner's skills.json is the bulk channel).
    addAndSelect({ ...blankSkill(), name: "Imported skill" });
  }

  function toggleProject(s: SkillDef, pid: string) {
    const next = s.projects.includes(pid) ? s.projects.filter(x => x !== pid) : [...s.projects, pid];
    setSkillProjects(s.id, next);
  }

  function toggleProfile(s: SkillDef, p: SkillProfile) {
    const next = s.profiles.includes(p) ? s.profiles.filter(x => x !== p) : [...s.profiles, p];
    patch(s.id, { profiles: next });
  }

  // ── card ──────────────────────────────────────────────────────────────────────
  function skillCard(s: SkillDef) {
    const meta = KIND_META[s.kind];
    const st = statsFor(s);
    const rate = successRate(st);
    return (
      <div
        key={s.id}
        className={"sk-card" + (!s.enabled ? " off" : "") + (selectedId === s.id ? " selected" : "")}
        onClick={() => setSelectedId(s.id)}
      >
        <div className="sk-card-head">
          <div className={"sk-kind-icon " + meta.tone}>{meta.icon}</div>
          <div className="sk-card-title">
            <span className="sk-name">{s.name || "Untitled skill"}</span>
            {s.pinned && <span className="sk-pin" title="pinned — auto-available to the fleet">★</span>}
          </div>
          <Spark data={st.trend} />
        </div>
        <div className="sk-card-tags">
          <span className={"sk-tag " + meta.tone}>{meta.label}</span>
          <span className="sk-tag muted">{s.source}</span>
        </div>
        <div className="sk-card-desc">{s.description || "No description yet."}</div>
        {s.tools.length > 0 && (
          <div className="sk-tools">
            {s.tools.slice(0, 5).map(t => <kbd key={t} className="sk-kbd">{t}</kbd>)}
            {s.tools.length > 5 && <span className="sk-tag muted">+{s.tools.length - 5}</span>}
          </div>
        )}
        <div className="sk-card-foot">
          <div className="sk-profiles" title={s.profiles.join(", ")}>
            {s.profiles.map(p => (
              <span key={p} className="sk-pdot" style={{ background: PROFILE_META[p].color }} title={PROFILE_META[p].label} />
            ))}
          </div>
          <div className="sk-spacer" />
          <span className="sk-inv">{st.invocations}×</span>
          <span className="sk-meter" title={`${Math.round(rate * 100)}% success`}>
            <span className="sk-meter-fill" style={{ width: `${rate * 100}%`, background: successColor(rate) }} />
          </span>
        </div>
      </div>
    );
  }

  // ── library view ──────────────────────────────────────────────────────────────
  function libraryView() {
    if (skills.length === 0) {
      return (
        <div className="sk-empty">
          <h3>No skills yet</h3>
          <p className="sk-hint">Add reusable capability bundles from the catalog, or create a custom one.</p>
          <button className="btn primary" onClick={() => setMode("catalog")}>Browse the catalog →</button>
        </div>
      );
    }
    const q = search.trim().toLowerCase();
    const shown = skills.filter(s =>
      (kindFilter === "all" || s.kind === kindFilter) &&
      (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
    );
    return (
      <>
        <div className="sk-filter">
          {(["all", ...SKILL_KINDS] as KindFilter[]).map(k => (
            <button key={k} className={kindFilter === k ? "on" : ""} onClick={() => setKindFilter(k)}>
              {k === "all" ? "all" : KIND_META[k].label}
            </button>
          ))}
          <div className="sk-spacer" />
          <input className="input" placeholder="search skills…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 180, height: 24, fontSize: 10.5 }} />
        </div>
        <div className="sk-grid">
          {shown.map(skillCard)}
          {shown.length === 0 && <div className="sk-hint" style={{ padding: "8px 2px" }}>No skills match this filter.</div>}
        </div>
      </>
    );
  }

  // ── runs view (the real invocation log) ───────────────────────────────────────
  function runsView() {
    if (logLines.length === 0) {
      return (
        <div className="sk-empty">
          <h3>No runs recorded yet</h3>
          <p className="sk-hint">Skill invocations show up here once agents start using them. Metrics derive from the live usage log.</p>
        </div>
      );
    }
    return (
      <div className="sk-runs">
        {logLines.map((l, i) => (
          <div className={"sk-run " + (l.event === "PostToolUse" ? "ok" : "")} key={i}>
            <span className="sk-run-ev">{l.event === "PostToolUse" ? "✓ done" : "▶ run"}</span>
            <span className="sk-run-skill">{l.skill}</span>
            <span className="sk-run-pane">{l.pane}</span>
            <span className="sk-spacer" />
            <span className="sk-run-ts">{new Date(l.ts).toLocaleString()}</span>
          </div>
        ))}
      </div>
    );
  }

  // ── catalog view ──────────────────────────────────────────────────────────────
  function catalogView() {
    const q = search.trim().toLowerCase();
    const items = q ? SKILL_CATALOG.filter(c => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)) : SKILL_CATALOG;
    return (
      <>
        <div className="sk-filter">
          <span className="sk-hint">First-party skills you can add with one click.</span>
          <div className="sk-spacer" />
          <input className="input" placeholder="search catalog…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 180, height: 24, fontSize: 10.5 }} />
        </div>
        <div className="sk-catalog">
          {items.map(c => (
            <div className="sk-cat-card" key={c.name}>
              <div className="sk-cat-head">
                <div className="sk-cat-icon">{c.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="sk-cat-name">{c.name}</div>
                  <div className="sk-cat-by">{c.by}</div>
                </div>
              </div>
              <div className="sk-cat-desc">{c.desc}</div>
              <div className="sk-cat-foot">
                <span className="sk-hint">{c.by === "first-party" ? "first-party" : "community"}</span>
                <div className="sk-spacer" />
                <button className="btn" style={{ height: 22, fontSize: 10, padding: "0 10px" }} onClick={() => addFromCatalog(c)}>add</button>
              </div>
            </div>
          ))}
          {items.length === 0 && <div className="sk-hint" style={{ padding: "8px 2px" }}>No catalog entries match “{search}”.</div>}
        </div>
      </>
    );
  }

  function addFromCatalog(item: CatalogItem) {
    addSkill(defFromCatalog(item.name));
    const created = useAppStore.getState().skills;
    const last = created[created.length - 1];
    if (last) { setSelectedId(last.id); setMode("library"); }
  }

  // ── drawer (CRUD) ─────────────────────────────────────────────────────────────
  function drawerBody(s: SkillDef) {
    const isGlobal = s.projects.length === 0;
    return (
      <>
        <div className="sk-field"><label>name</label>
          <input className="input" value={s.name} onChange={e => patch(s.id, { name: e.target.value })} />
        </div>

        <div className="sk-field"><label>kind</label>
          <div className="sk-seg">
            {SKILL_KINDS.map(k => (
              <button key={k} className={s.kind === k ? "on" : ""} onClick={() => patch(s.id, { kind: k })}>{KIND_META[k].label}</button>
            ))}
          </div>
        </div>

        <div className="sk-field"><label>description</label>
          <input className="input" value={s.description} placeholder="one line" onChange={e => patch(s.id, { description: e.target.value })} />
        </div>

        <div className="sk-field"><label>procedure (the prompt the agent follows)</label>
          <textarea className="input sk-textarea" value={s.prompt} placeholder="step-by-step procedure…" onChange={e => patch(s.id, { prompt: e.target.value })} />
        </div>

        <div className="sk-field"><label>tools (comma-separated)</label>
          <input className="input" value={s.tools.join(", ")} placeholder="create_pr, git_diff"
            onChange={e => patch(s.id, { tools: e.target.value.split(",").map(t => t.trim()).filter(Boolean) })} />
        </div>

        <div className="sk-field"><label>profiles allowed to invoke</label>
          <div className="sk-chips">
            {SKILL_PROFILES.map(p => (
              <button key={p} className={"sk-chip" + (s.profiles.includes(p) ? " on" : "")} onClick={() => toggleProfile(s, p)}>
                <span className="sk-pdot" style={{ background: PROFILE_META[p].color }} />{p}
              </button>
            ))}
          </div>
        </div>

        <div className="sk-field"><label>availability</label>
          <div className="sk-toggle-row">
            <span className={"sk-toggle" + (s.enabled ? " on" : "")} title={s.enabled ? "enabled" : "disabled"} onClick={() => toggleSkill(s.id)} />
            <span>{s.enabled ? "enabled" : "disabled"}</span>
            <div className="sk-spacer" />
            <span className={"sk-toggle" + (s.pinned ? " on" : "")} title={s.pinned ? "pinned" : "not pinned"} onClick={() => toggleSkillPin(s.id)} />
            <span>{s.pinned ? "pinned" : "pin"}</span>
          </div>
        </div>

        <div className="sk-field"><label>project assignment</label>
          <div className="sk-toggle-row">
            <span className={"sk-toggle" + (isGlobal ? " on" : "")} onClick={() => setSkillProjects(s.id, isGlobal ? (projects[0] ? [projects[0].id] : []) : [])} />
            <b style={{ color: isGlobal ? "var(--success)" : "var(--fg-muted)" }}>Global (all projects)</b>
          </div>
          {!isGlobal && (
            projects.length === 0
              ? <div className="sk-hint" style={{ marginTop: 6 }}>No projects — global only. Connect GitHub in Settings to scope per project.</div>
              : (
                <div className="sk-proj" style={{ marginTop: 6 }}>
                  {projects.map(p => {
                    const sel = s.projects.includes(p.id);
                    return (
                      <div key={p.id} className={"sk-proj-row" + (sel ? " on" : "")} onClick={() => toggleProject(s, p.id)}>
                        <span className="sk-check">{sel ? "✓" : ""}</span>
                        <span className="sk-pname">{p.title}</span>
                        <span className="sk-hint">#{p.number}</span>
                      </div>
                    );
                  })}
                </div>
              )
          )}
        </div>
      </>
    );
  }

  // ── body dispatch ──────────────────────────────────────────────────────────────
  const body = mode === "catalog" ? catalogView() : mode === "runs" ? runsView() : libraryView();
  const leastReliableRate = leastReliable ? successRate(statsFor(leastReliable)) : 1;

  return (
    <div className="sk-screen">
      <div className="sk-page">
        {/* mode strip + header actions */}
        <div className="sk-modestrip">
          <div className={"sk-m" + (mode === "library" ? " on" : "")} onClick={() => setMode("library")}>
            Library <span className="sk-count">{skills.length}</span>
          </div>
          <div className={"sk-m" + (mode === "runs" ? " on" : "")} onClick={() => setMode("runs")}>
            Runs <span className="sk-count">{logLines.length}</span>
          </div>
          <div className={"sk-m" + (mode === "catalog" ? " on" : "")} onClick={() => setMode("catalog")}>
            Catalog <span className="sk-count">{SKILL_CATALOG.length}</span>
          </div>
          <div className="sk-spacer" />
          <button className="btn" onClick={importSkill}>import skill</button>
          <button className="btn primary" onClick={() => addAndSelect(blankSkill())}>+ new skill</button>
        </div>

        {/* digest banner */}
        <div className="sk-digest">
          <div className="sk-digest-main">
            <b>{enabled.length}</b> of {skills.length} skills enabled · <b>{pinnedCount}</b> pinned
            {workhorse
              ? <> · workhorse <b>{workhorse.name}</b> ({statsFor(workhorse).invocations}×)</>
              : <> · no runs recorded yet</>}
            {leastReliable && leastReliableRate < 0.85 && (
              <> · least-reliable <b>{leastReliable.name}</b> ({Math.round(leastReliableRate * 100)}%)</>
            )}
          </div>
          <button className="btn ghost" style={{ height: 22, fontSize: 10 }} onClick={() => setMode("runs")}>view runs</button>
        </div>

        {/* KPI row (token-saved KPI dropped per #406 — not derivable) */}
        <div className="sk-kpis">
          <StatCard label="skills" value={skills.length} />
          <StatCard label="invocations · today" value={invocationsToday} sub={`${invocationsTotal} all-time`} />
          <StatCard label="avg success" value={`${Math.round(avgSuccess * 100)}%`} sub="weighted" />
          <StatCard label="invocations · 7d" value={invocations7d} />
          <StatCard label="pinned" value={pinnedCount} sub="auto-available" />
        </div>

        <div className="sk-cols">
          <div className="sk-body">{body}</div>

          {/* right rail */}
          <div className="sk-rail">
            <div className="sk-rail-sec">
              <h4>Most invoked</h4>
              {leaderboard.length === 0
                ? <div className="sk-hint">No usage yet.</div>
                : leaderboard.map(s => (
                    <HBar key={s.id} label={s.name} value={statsFor(s).invocations}
                      max={statsFor(leaderboard[0]).invocations} tone="var(--accent)" />
                  ))}
            </div>
            <div className="sk-rail-sec">
              <h4>Success by kind</h4>
              {byKind.length === 0
                ? <div className="sk-hint">No usage yet.</div>
                : byKind.map(b => (
                    <div className="sk-bykind" key={b.kind}>
                      <span className="sk-bykind-label">{KIND_META[b.kind].label}</span>
                      <span className="sk-meter"><span className="sk-meter-fill" style={{ width: `${b.rate * 100}%`, background: successColor(b.rate) }} /></span>
                      <span className="sk-bykind-val">{Math.round(b.rate * 100)}%</span>
                    </div>
                  ))}
            </div>
            <div className="sk-rail-sec">
              <h4>Add a skill</h4>
              {SKILL_CATALOG.slice(0, 5).map(c => (
                <div className="sk-add-row" key={c.name}>
                  <span className="sk-add-name" title={c.desc}>{c.name}</span>
                  <button className="btn ghost" style={{ height: 20, fontSize: 9.5, padding: "0 8px" }} onClick={() => addFromCatalog(c)}>add</button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* status line */}
        <div className="sk-statusline">
          <span>{skills.length} skills loaded</span>
          <span>· {invocationsToday} invocations today</span>
          {leastReliable && leastReliableRate < 0.6 && (
            <span className="warn">· ⚠ {leastReliable.name} at {Math.round(leastReliableRate * 100)}% success</span>
          )}
        </div>
      </div>

      {/* drawer */}
      <div className={"sk-scrim" + (selected ? " on" : "")} onClick={() => setSelectedId(null)} />
      <div className={"sk-drawer" + (selected ? " on" : "")}>
        {selected && (
          <>
            <div className="sk-dr-head">
              <div className={"sk-kind-icon " + KIND_META[selected.kind].tone}>{KIND_META[selected.kind].icon}</div>
              <div className="sk-dr-name">{selected.name || "Untitled skill"}</div>
              <button className="sk-x" title="close" onClick={() => setSelectedId(null)}>×</button>
            </div>
            <div className="sk-dr-body">{drawerBody(selected)}</div>
            <div className="sk-dr-foot">
              <button className="btn ghost danger" onClick={() => { removeSkill(selected.id); setSelectedId(null); }}>remove</button>
              <div className="sk-spacer" />
              <button className="btn primary" onClick={() => setSelectedId(null)}>done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
