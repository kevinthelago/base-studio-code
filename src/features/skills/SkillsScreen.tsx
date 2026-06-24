// Skills screen — "Skills at Scale" redesign (#skills-groups). A library that stays fast with
// hundreds of skills: search + multi-facet filters + sort, four densities (List / Cards / Group /
// Kind), bulk actions, a collapsible KPI digest, and TASK GROUPS — named, reusable skill bundles
// (the ⬡) that filter the library and can be toggled onto a session/stream (see SessionSkillsModal
// + the planner channel). Reads/mutates the store `skills` + `skillGroups` slices; every enabled,
// in-scope (or group-/override-enabled) skill is written into a launched session as
// `.claude/skills/<slug>/SKILL.md`. Edits are live. Telemetry (Runs) is real, from the skill log.
import { useState, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import {
  KIND, PROFILE_COLOR, SOURCE_TAG, skillCatalog, fmtCount,
  type SkillKind, type SkillSource, type SkillProfile,
} from "@/data/skills";
import {
  blankSkill, defFromCatalog, deriveSkillKpis, parseSkillsFile, skillSlug,
  groupSkillCount, type SkillDef, type SkillGroup,
} from "./lib/skills";
import { parseSkillLog, aggregateSkillTelemetry, type SkillStats } from "./lib/skillTelemetry";
import { Spark } from "./SkillsCharts";
import { TabBar, type TabItem } from "@/components/chrome/TabBar";
import { usePageTabs } from "@/hooks/usePageTabs";
import "./skills.css";

type Mode = "library" | "runs" | "catalog";
type Density = "list" | "cards" | "grouped" | "kind";
type SortKey = "Most invoked" | "Name (A–Z)" | "Success rate" | "Recently used" | "Recently added";

const KIND_KEYS = Object.keys(KIND) as SkillKind[];
const PROFILE_KEYS = Object.keys(PROFILE_COLOR) as SkillProfile[];
const SOURCE_KEYS: SkillSource[] = ["first-party", "team", "imported", "community"];
const SORTS: SortKey[] = ["Most invoked", "Name (A–Z)", "Success rate", "Recently used", "Recently added"];
const GROUP_HUES = ["var(--accent)", "var(--danger)", "var(--info)", "var(--violet)", "var(--success)", "var(--fg-muted)"];
const DRAFT_ID = "__draft__";

interface GhProject { id: string; number: number; title: string }
const PROJECTS_QUERY = `{ viewer { projectsV2(first: 50) { nodes { id title number } } } }`;

const MODES: Array<{ k: Mode; label: string }> = [
  { k: "library", label: "Library" }, { k: "runs", label: "Runs" }, { k: "catalog", label: "Catalog" },
];
const SKILL_TABS: TabItem[] = MODES.map((m) => ({ id: m.k, label: m.label }));

const successColor = (s: number | null): string =>
  s == null ? "var(--fg-dim)" : s >= 95 ? "var(--success)" : s >= 85 ? "var(--accent)" : "var(--danger)";

function tintBg(hue: string, t = 88): string { return `color-mix(in oklch, ${hue}, transparent ${t}%)`; }
function pill(hue: string, plain = false): CSSProperties {
  const base: CSSProperties = { fontFamily: "var(--mono)", fontSize: 9.5, padding: "2px 7px", borderRadius: 99, lineHeight: 1.1, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center" };
  if (plain) return { ...base, background: tintBg("var(--fg-dim)"), border: "1px solid " + tintBg("var(--fg-dim)", 80), color: "var(--fg-muted)" };
  return { ...base, background: tintBg(hue), border: `1px solid ${tintBg(hue, 74)}`, color: hue };
}
function glyphTile(kind: SkillKind, lg = false): CSSProperties {
  const c = KIND[kind].color; const d = lg ? 30 : 22;
  return { width: d, height: d, flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, fontFamily: "var(--mono)", fontSize: lg ? 15 : 12, color: c, background: `color-mix(in oklch, ${c} 22%, var(--bg-elev))`, border: `1px solid ${tintBg(c, 70)}` };
}
function Toggle({ on, onClick }: { on: boolean; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <span onClick={onClick} style={{ width: 26, height: 15, borderRadius: 99, position: "relative", flex: "0 0 auto", cursor: onClick ? "pointer" : "default", background: on ? "var(--accent)" : "var(--bg-elev2)", border: "1px solid " + (on ? "transparent" : "var(--border)") }}>
      <span style={{ position: "absolute", top: 1, left: on ? 12 : 1, width: 11, height: 11, borderRadius: "50%", background: on ? "var(--bg-canvas)" : "var(--fg-dim)" }} />
    </span>
  );
}
const sourcePill = (src: SkillSource): CSSProperties =>
  src === "team" ? pill("var(--info)") : src === "imported" ? pill("var(--accent)") : pill("", true);
const scopePill = (projects: string[]): CSSProperties => (projects.length ? pill("var(--info)") : pill("", true));

/** Stable pseudo-recency from the id so "Recently used/added" sort is deterministic in the demo. */
const hashN = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export function SkillsScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
  const skills = useAppStore((s) => s.skills);
  const addSkill = useAppStore((s) => s.addSkill);
  const updateSkill = useAppStore((s) => s.updateSkill);
  const removeSkill = useAppStore((s) => s.removeSkill);
  const toggleSkill = useAppStore((s) => s.toggleSkill);
  const toggleSkillPin = useAppStore((s) => s.toggleSkillPin);
  const upsertSkills = useAppStore((s) => s.upsertSkills);
  const githubToken = useAppStore((s) => s.githubToken);
  const skillGroups = useAppStore((s) => s.skillGroups);
  const addSkillGroup = useAppStore((s) => s.addSkillGroup);
  const removeSkillGroup = useAppStore((s) => s.removeSkillGroup);
  const toggleSkillGroupMember = useAppStore((s) => s.toggleSkillGroupMember);

  const { tabs: skillTabs, activeId, select, reorder, tearOff } = usePageTabs("skills", SKILL_TABS);
  const mode: Mode = (sectionOverride ?? activeId) as Mode;

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("Most invoked");
  const [sortOpen, setSortOpen] = useState(false);
  const [density, setDensity] = useState<Density>("list");
  const [digestOpen, setDigestOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupFilter, setGroupFilter] = useState<string | null>(null);     // selected task group id
  const [facetSel, setFacetSel] = useState<Record<string, Set<string>>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SkillDef | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [projects, setProjects] = useState<GhProject[]>([]);
  useEffect(() => {
    if (!githubToken) return;
    let cancelled = false;
    invoke<{ viewer: { projectsV2: { nodes: GhProject[] } } }>("github_graphql", { token: githubToken, query: PROJECTS_QUERY, variables: null })
      .then((d) => { if (!cancelled) setProjects(d?.viewer?.projectsV2?.nodes ?? []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [githubToken]);

  // Real telemetry, merged over the library.
  const [stats, setStats] = useState<Record<string, SkillStats>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const lines = await invoke<string[]>("read_skill_log", { limit: 4000 }).catch(() => [] as string[]);
      if (!cancelled) setStats(aggregateSkillTelemetry(parseSkillLog((lines ?? []).join("\n")), new Date()));
    };
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const merged = useMemo<SkillDef[]>(() => skills.map((s) => {
    const st = stats[skillSlug(s.name)];
    return st ? { ...s, invocations: st.invocations, success: st.successRate, trend: st.trend } : { ...s, invocations: 0, success: 0, trend: [] };
  }), [skills, stats]);

  // group membership index: skillId -> the groups it's in
  const groupsBySkill = useMemo(() => {
    const m = new Map<string, SkillGroup[]>();
    for (const g of skillGroups) for (const id of g.skillIds) { const a = m.get(id) ?? []; a.push(g); m.set(id, a); }
    return m;
  }, [skillGroups]);

  const kpis = useMemo(() => deriveSkillKpis(merged), [merged]);
  const invToday = useMemo(() => Object.values(stats).reduce((a, s) => a + s.today, 0), [stats]);

  // ── facets ──────────────────────────────────────────────────────────────────
  const facetDefs = useMemo(() => {
    const c = (pred: (s: SkillDef) => boolean) => merged.filter(pred).length;
    return [
      { key: "kind", title: "Kind", options: KIND_KEYS.map((k) => ({ value: k, label: k, glyph: KIND[k].glyph, color: KIND[k].color, count: c((s) => s.kind === k), match: (s: SkillDef) => s.kind === k })) },
      { key: "source", title: "Source", options: SOURCE_KEYS.map((k) => ({ value: k, label: k, glyph: "", color: "", count: c((s) => s.source === k), match: (s: SkillDef) => s.source === k })) },
      { key: "scope", title: "Scope", options: [
        { value: "global", label: "global", glyph: "", color: "", count: c((s) => !s.projects.length), match: (s: SkillDef) => !s.projects.length },
        { value: "scoped", label: "project-scoped", glyph: "", color: "", count: c((s) => s.projects.length > 0), match: (s: SkillDef) => s.projects.length > 0 },
      ] },
      { key: "status", title: "Status", options: [
        { value: "enabled", label: "enabled", glyph: "", color: "", count: c((s) => s.enabled), match: (s: SkillDef) => s.enabled },
        { value: "disabled", label: "disabled", glyph: "", color: "", count: c((s) => !s.enabled), match: (s: SkillDef) => !s.enabled },
        { value: "pinned", label: "pinned", glyph: "", color: "", count: c((s) => s.pinned), match: (s: SkillDef) => s.pinned },
      ] },
      { key: "usage", title: "Usage", options: [
        { value: "used", label: "used · 7d", glyph: "", color: "", count: c((s) => s.invocations > 0), match: (s: SkillDef) => s.invocations > 0 },
        { value: "never", label: "never run", glyph: "", color: "", count: c((s) => s.invocations === 0), match: (s: SkillDef) => s.invocations === 0 },
      ] },
    ];
  }, [merged]);

  const toggleFacet = (facetKey: string, value: string) => setFacetSel((prev) => {
    const next = { ...prev };
    const set = new Set(next[facetKey] ?? []);
    if (set.has(value)) set.delete(value); else set.add(value);
    if (set.size) next[facetKey] = set; else delete next[facetKey];
    return next;
  });
  const activeFacetCount = Object.values(facetSel).reduce((a, s) => a + s.size, 0);
  const clearFilters = () => { setQuery(""); setGroupFilter(null); setFacetSel({}); };

  // ── filter + sort ─────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let pool = merged;
    if (groupFilter) { const g = skillGroups.find((x) => x.id === groupFilter); const ids = new Set(g?.skillIds ?? []); pool = pool.filter((s) => ids.has(s.id)); }
    if (q) pool = pool.filter((s) => (s.name + " " + s.desc + " " + s.tools.join(" ") + " " + s.source).toLowerCase().includes(q));
    for (const def of facetDefs) {
      const sel = facetSel[def.key]; if (!sel?.size) continue;
      const opts = def.options.filter((o) => sel.has(o.value));
      pool = pool.filter((s) => opts.some((o) => o.match(s)));   // OR within a facet
    }
    const sorters: Record<SortKey, (a: SkillDef, b: SkillDef) => number> = {
      "Name (A–Z)": (a, b) => a.name.localeCompare(b.name),
      "Most invoked": (a, b) => b.invocations - a.invocations,
      "Success rate": (a, b) => (b.success || 0) - (a.success || 0),
      "Recently used": (a, b) => hashN(b.id + "u") - hashN(a.id + "u"),
      "Recently added": (a, b) => hashN(b.id + "a") - hashN(a.id + "a"),
    };
    return [...pool].sort(sorters[sort]);
  }, [merged, query, groupFilter, skillGroups, facetDefs, facetSel, sort]);

  const isEmpty = filtered.length === 0;

  // ── selection / bulk ──────────────────────────────────────────────────────────
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAllMatching = () => setSelected(new Set(filtered.map((s) => s.id)));
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };
  const bulk = (fn: (id: string) => void) => { selected.forEach(fn); };
  const bulkAddToGroup = (groupId: string) => { selected.forEach((id) => { const g = skillGroups.find((x) => x.id === groupId); if (g && !g.skillIds.includes(id)) toggleSkillGroupMember(groupId, id); }); };
  const bulkDelete = () => { selected.forEach((id) => removeSkill(id)); exitSelect(); };

  // ── drawer ────────────────────────────────────────────────────────────────────
  const selectedSkill = selectedId ? skills.find((s) => s.id === selectedId) ?? null : null;
  const editing = draft ?? selectedSkill;
  const isDraft = !!draft;
  function patch(id: string, p: Partial<SkillDef>) { if (draft && id === DRAFT_ID) setDraft((d) => (d ? { ...d, ...p } : d)); else updateSkill(id, p); }
  function newSkill() { setSelectedId(null); setDraft({ ...blankSkill(), id: DRAFT_ID }); }
  function commitDraft() { if (!draft) return; const { id: _id, ...def } = draft; setSelectedId(addSkill(def)); setDraft(null); }
  function closeDrawer() { setSelectedId(null); setDraft(null); }
  function importSkills(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      let normalized = text;
      try { const parsed = JSON.parse(text); if (parsed && !Array.isArray(parsed)) normalized = JSON.stringify([parsed]); } catch { /* parseSkillsFile handles */ }
      const defs = parseSkillsFile(normalized);
      if (defs.length) upsertSkills(defs);
    };
    reader.readAsText(file);
  }

  // ── shared row renderer (List + Grouped) ────────────────────────────────────────
  const colTemplate = (sel: boolean) => (sel ? "26px " : "") + "24px minmax(190px,1fr) 90px minmax(120px,170px) 96px 150px 26px 40px";
  function SkillRow({ s, i }: { s: SkillDef; i: number }) {
    const isSel = selected.has(s.id);
    return (
      <div className="skill-row" data-skill-id={s.id} onClick={() => (selectMode ? toggleSel(s.id) : (setSelectedId(s.id), setDraft(null)))}
        style={{ display: "grid", gridTemplateColumns: colTemplate(selectMode), alignItems: "center", gap: 10, height: 37, padding: "0 18px", background: i % 2 ? "var(--bg-elev)" : "var(--bg-panel)", borderBottom: "1px solid var(--border-soft)", cursor: "pointer", opacity: s.enabled ? 1 : 0.55 }}>
        {selectMode && <span style={{ width: 14, height: 14, borderRadius: 4, border: "1px solid " + (isSel ? "var(--accent)" : "var(--border)"), background: isSel ? "var(--accent)" : "transparent", color: "var(--bg-canvas)", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>{isSel ? "✓" : ""}</span>}
        <span style={glyphTile(s.kind)}>{KIND[s.kind].glyph}</span>
        <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name || "Untitled skill"}</span>
          {(groupsBySkill.get(s.id)?.length ?? 0) > 0 && <span title={groupsBySkill.get(s.id)!.map((g) => g.name).join(", ")} style={{ color: "var(--fg-dim)", fontSize: 10 }}>⬡{groupsBySkill.get(s.id)!.length > 1 ? groupsBySkill.get(s.id)!.length : ""}</span>}
        </span>
        <span><span style={sourcePill(s.source)}>{SOURCE_TAG[s.source].label}</span></span>
        <span style={{ display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>
          {s.tools.slice(0, 2).map((t) => <span key={t} className="kbd" style={{ fontSize: 10 }}>{t}</span>)}
          {s.tools.length > 2 && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>+{s.tools.length - 2}</span>}
        </span>
        <span><span style={scopePill(s.projects)}>{s.projects.length ? s.projects[0] + (s.projects.length > 1 ? " +" + (s.projects.length - 1) : "") : "global"}</span></span>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: s.invocations ? "var(--fg-muted)" : "var(--fg-dim)", width: 38, textAlign: "right" }}>{s.invocations ? fmtCount(s.invocations) + "×" : "—"}</span>
          {s.trend.length > 1 ? <Spark data={s.trend} color={s.invocations ? KIND[s.kind].color : "var(--fg-dim)"} /> : <span style={{ width: 46 }} />}
        </span>
        <span className="pin-btn" onClick={(e) => { e.stopPropagation(); toggleSkillPin(s.id); }} style={{ textAlign: "center", fontSize: 12, color: s.pinned ? "var(--accent)" : "var(--fg-dim)", cursor: "pointer" }}>★</span>
        <span style={{ display: "flex", justifyContent: "center" }}><Toggle on={s.enabled} onClick={(e) => { e.stopPropagation(); toggleSkill(s.id); }} /></span>
      </div>
    );
  }

  // grouped sections (by task group, or by kind in "kind" density)
  const groupedSections = useMemo(() => {
    if (density === "kind") {
      return KIND_KEYS.map((k) => ({ id: k, label: KIND[k].label, glyph: KIND[k].glyph, hue: KIND[k].color, items: filtered.filter((s) => s.kind === k) })).filter((g) => g.items.length);
    }
    const sections = skillGroups.map((g) => ({ id: g.id, label: g.name, glyph: "⬡", hue: g.hue, items: filtered.filter((s) => g.skillIds.includes(s.id)) })).filter((g) => g.items.length);
    const grouped = new Set(skillGroups.flatMap((g) => g.skillIds));
    const ungrouped = filtered.filter((s) => !grouped.has(s.id));
    if (ungrouped.length) sections.push({ id: "__ungrouped__", label: "Ungrouped", glyph: "·", hue: "var(--fg-dim)", items: ungrouped });
    return sections;
  }, [density, filtered, skillGroups]);

  // ── catalog ─────────────────────────────────────────────────────────────────
  const existingNames = useMemo(() => new Set(skills.map((s) => s.name)), [skills]);
  const availableCatalog = useMemo(() => skillCatalog().filter((c) => !existingNames.has(c.name)), [existingNames]);
  const catalogList = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    return q ? availableCatalog.filter((c) => (c.name + " " + c.desc + " " + c.by).toLowerCase().includes(q)) : availableCatalog;
  }, [catalogQuery, availableCatalog]);

  // ── runs ──────────────────────────────────────────────────────────────────────
  const runRows = useMemo(() => [...merged].filter((s) => s.invocations > 0).sort((a, b) => b.invocations - a.invocations), [merged]);

  return (
    <div className="skills-screen">
      {!sectionOverride && <TabBar tabs={skillTabs} activeId={activeId} onSelect={select} onReorder={reorder} onTearOff={tearOff} right={<span className="sync">● github sync</span>} />}

      {mode === "library" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* KPI digest (collapsible) */}
          <div style={{ borderBottom: "1px solid var(--border-soft)", background: "var(--bg-canvas)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "9px 18px", fontSize: 11.5, color: "var(--fg-muted)" }}>
              <button onClick={() => setDigestOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--fg-dim)", cursor: "pointer", fontSize: 11, padding: 0 }}>
                <span style={{ display: "inline-block", transform: digestOpen ? "rotate(90deg)" : "none", fontSize: 9 }}>▸</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em" }}>Fleet digest · 7d</span>
              </button>
              <span><b style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>{kpis.total}</b> skills</span>
              <span><b style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>{merged.filter((s) => s.enabled).length}</b> enabled</span>
              <span style={{ color: "var(--accent)" }}>★ <b style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>{kpis.pinned}</b></span>
              <span><b style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>{invToday}</b> today</span>
              <span><b style={{ fontFamily: "var(--mono)", color: "var(--success)" }}>{kpis.invWeek ? kpis.avgSuccess + "%" : "—"}</b> avg success</span>
            </div>
          </div>

          {/* Command bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
            <div style={{ flex: 1, maxWidth: 440, display: "flex", alignItems: "center", gap: 8, height: 30, padding: "0 11px", background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
              <span style={{ color: "var(--fg-dim)", fontSize: 13 }}>⌕</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, description, tools…" style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--fg)", fontSize: 12.5 }} />
            </div>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>{filtered.length} <span style={{ color: "var(--fg-dim)" }}>of {kpis.total}</span></span>
            <span style={{ flex: 1 }} />
            <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "var(--fg-dim)", fontFamily: "var(--mono)", textTransform: "uppercase" }}>Sort</span>
              <button onClick={() => setSortOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", fontSize: 11.5, color: "var(--fg)", cursor: "pointer" }}>{sort} <span style={{ color: "var(--fg-dim)", fontSize: 9 }}>▾</span></button>
              {sortOpen && (
                <div style={{ position: "absolute", top: 34, right: 0, zIndex: 40, minWidth: 184, background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", boxShadow: "0 14px 36px rgba(0,0,0,.45)", padding: 4 }}>
                  {SORTS.map((o) => <div key={o} onClick={() => { setSort(o); setSortOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", borderRadius: 4, fontSize: 11.5, cursor: "pointer", color: sort === o ? "var(--fg)" : "var(--fg-muted)", background: sort === o ? "var(--bg-elev2)" : "transparent" }}><span style={{ flex: 1 }}>{o}</span><span style={{ color: "var(--accent)" }}>{sort === o ? "✓" : ""}</span></div>)}
                </div>
              )}
            </div>
            <div style={{ display: "flex", height: 28, border: "1px solid var(--border)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
              {([["list", "☰ List"], ["cards", "▦ Cards"], ["grouped", "⬡ Group"], ["kind", "⊟ Kind"]] as const).map(([d, lbl], i) => (
                <div key={d} onClick={() => setDensity(d)} style={{ display: "flex", alignItems: "center", padding: "0 11px", fontSize: 11, cursor: "pointer", background: density === d ? "var(--bg-elev2)" : "transparent", color: density === d ? "var(--fg)" : "var(--fg-dim)", borderRight: i < 3 ? "1px solid var(--border)" : "none" }}>{lbl}</div>
              ))}
            </div>
            <button onClick={() => (selectMode ? exitSelect() : setSelectMode(true))} style={{ height: 28, padding: "0 12px", borderRadius: "var(--r-md)", fontSize: 11.5, cursor: "pointer", border: "1px solid " + (selectMode ? "var(--accent-dim)" : "var(--border)"), background: selectMode ? tintBg("var(--accent)", 86) : "var(--bg-canvas)", color: selectMode ? "var(--accent)" : "var(--fg)" }}>{selectMode ? "✓ Selecting" : "☑ Select"}</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>import</button>
            <button className="btn primary" onClick={newSkill}>+ skill</button>
            <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) importSkills(f); e.target.value = ""; }} />
          </div>

          {/* Task-group quick-filter bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border-soft)", overflowX: "auto" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--fg-dim)", flex: "0 0 auto" }}>⬡ Task groups</span>
            {(() => { const active = !groupFilter; return (
              <button onClick={() => setGroupFilter(null)} style={groupChip("var(--accent)", active)}><span style={{ opacity: 0.75 }}>≡</span>All<span style={{ fontFamily: "var(--mono)", fontSize: 9.5, opacity: 0.7 }}>{merged.length}</span></button>
            ); })()}
            {skillGroups.map((g) => { const active = groupFilter === g.id; return (
              <button key={g.id} onClick={() => setGroupFilter((v) => (v === g.id ? null : g.id))} style={groupChip(g.hue, active)}><span style={{ opacity: 0.75 }}>⬡</span>{g.name}<span style={{ fontFamily: "var(--mono)", fontSize: 9.5, opacity: 0.7 }}>{groupSkillCount(g, skills)}</span></button>
            ); })}
            <button onClick={() => setAddGroupOpen(true)} style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 24, padding: "0 10px", borderRadius: 99, border: "1px dashed var(--border)", background: "transparent", color: "var(--fg-dim)", fontSize: 11, cursor: "pointer", flex: "0 0 auto" }}>＋ New group</button>
            {groupFilter && <button onClick={() => { if (confirm("Delete this group? Skills are not deleted.")) { removeSkillGroup(groupFilter); setGroupFilter(null); } }} style={{ fontSize: 10.5, color: "var(--danger)", background: "none", border: "none", cursor: "pointer", flex: "0 0 auto" }}>delete group</button>}
          </div>

          {/* Body */}
          <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", overflow: "hidden" }}>
            {/* Facet column */}
            <div style={{ flex: "0 0 200px", overflowY: "auto", borderRight: "1px solid var(--border-soft)", background: "var(--bg-canvas)", padding: "14px 14px 40px 18px" }}>
              {facetDefs.map((f) => (
                <div key={f.key} style={{ marginBottom: 18 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--fg-dim)", marginBottom: 8 }}>{f.title}</div>
                  {f.options.map((o) => { const on = facetSel[f.key]?.has(o.value) ?? false; return (
                    <div key={o.value} onClick={() => toggleFacet(f.key, o.value)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}>
                      <span style={{ width: 14, height: 14, borderRadius: 4, border: "1px solid " + (on ? "var(--accent)" : "var(--border)"), background: on ? "var(--accent)" : "transparent", color: "var(--bg-canvas)", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}>{on ? "✓" : ""}</span>
                      {o.glyph && <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: o.color, width: 13, textAlign: "center" }}>{o.glyph}</span>}
                      <span style={{ fontSize: 12, color: "var(--fg)", textTransform: "capitalize" }}>{o.label}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{o.count}</span>
                    </div>
                  ); })}
                </div>
              ))}
              {(activeFacetCount > 0 || query || groupFilter) && <button onClick={clearFilters} style={{ fontSize: 11, color: "var(--fg-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>clear all filters</button>}
            </div>

            {/* Main */}
            <div style={{ flex: 1, minWidth: 0, overflowY: "auto", paddingBottom: 60 }}>
              {selectMode && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 18px", padding: "9px 13px", background: tintBg("var(--accent)", 90), border: "1px solid var(--accent-dim)", borderRadius: "var(--r-lg)", flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>{selected.size} selected</span>
                  <span onClick={selectAllMatching} style={{ fontSize: 11, color: "var(--fg-muted)", textDecoration: "underline", cursor: "pointer" }}>Select all {filtered.length} matching</span>
                  <span style={{ flex: 1 }} />
                  <button className="btn" onClick={() => bulk((id) => { const s = skills.find((x) => x.id === id); if (s && !s.enabled) toggleSkill(id); })}>Enable</button>
                  <button className="btn" onClick={() => bulk((id) => { const s = skills.find((x) => x.id === id); if (s && s.enabled) toggleSkill(id); })}>Disable</button>
                  <button className="btn" onClick={() => bulk((id) => { const s = skills.find((x) => x.id === id); if (s && !s.pinned) toggleSkillPin(id); })}>★ Pin</button>
                  {skillGroups.length > 0 && (
                    <select className="input" style={{ height: 26, fontSize: 11 }} value="" onChange={(e) => { if (e.target.value) bulkAddToGroup(e.target.value); e.target.value = ""; }}>
                      <option value="">⬡ Add to group…</option>
                      {skillGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  )}
                  <button className="btn" style={{ borderColor: tintBg("var(--danger)", 60), color: "var(--danger)" }} onClick={bulkDelete}>Delete</button>
                </div>
              )}

              {isEmpty ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px", textAlign: "center" }}>
                  <div style={{ width: 52, height: 52, borderRadius: "var(--r-lg)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-dim)", fontSize: 22 }}>⌕</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)", marginTop: 16 }}>No skills match</div>
                  <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 6, maxWidth: 360, lineHeight: 1.5 }}>Nothing matches the active search + filters. Create a skill, import one, or clear the filters.</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
                    <button className="btn" onClick={clearFilters}>Clear filters</button>
                    <button className="btn primary" onClick={newSkill}>+ new skill</button>
                  </div>
                </div>
              ) : density === "list" ? (
                <div>
                  <div style={{ display: "grid", gridTemplateColumns: colTemplate(selectMode), alignItems: "center", gap: 10, height: 32, padding: "0 18px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--fg-dim)", position: "sticky", top: 0, zIndex: 6 }}>
                    {selectMode && <span />}<span /><span>Skill</span><span>Source</span><span>Tools</span><span>Scope</span><span style={{ textAlign: "right" }}>Usage</span><span style={{ textAlign: "center" }}>Pin</span><span style={{ textAlign: "center" }}>On</span>
                  </div>
                  {filtered.map((s, i) => <SkillRow key={s.id} s={s} i={i} />)}
                </div>
              ) : density === "cards" ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, padding: "14px 18px" }}>
                  {filtered.map((s) => <SkillCard key={s.id} s={s} groups={groupsBySkill.get(s.id) ?? []} onOpen={() => { setSelectedId(s.id); setDraft(null); }} onPin={() => toggleSkillPin(s.id)} onToggle={() => toggleSkill(s.id)} />)}
                </div>
              ) : (
                <div>
                  {groupedSections.map((sec) => (
                    <div key={sec.id}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 18px", position: "sticky", top: 0, zIndex: 5, background: "var(--bg-elev)", borderTop: "1px solid var(--border-soft)", borderBottom: "1px solid var(--border-soft)" }}>
                        <span style={{ ...glyphTile("workflow"), color: sec.hue, background: `color-mix(in oklch, ${sec.hue} 22%, var(--bg-elev))`, border: `1px solid ${tintBg(sec.hue, 70)}` }}>{sec.glyph}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)", textTransform: "capitalize" }}>{sec.label}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", background: "var(--bg-elev2)", borderRadius: 99, padding: "1px 7px" }}>{sec.items.length}</span>
                      </div>
                      {sec.items.map((s, i) => <SkillRow key={s.id} s={s} i={i} />)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {mode === "runs" && (
        <section className="an-page"><div className="an-wrap">
          <h2 style={{ margin: "0 0 4px", fontFamily: "var(--mono)", fontSize: 18 }}>Runs</h2>
          <div style={{ color: "var(--fg-muted)", fontSize: 12, marginBottom: 14 }}>Live skill invocations from the usage log · last 7 days</div>
          {runRows.length === 0 ? (
            <div className="empty"><h3 style={{ margin: 0 }}>No runs yet</h3><p className="hint" style={{ maxWidth: 420, margin: 0 }}>Run the fleet — each time an agent invokes a skill it's logged here with its success rate and 7-day trend.</p></div>
          ) : (
            <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.6fr 86px 60px 64px 90px", gap: 10, padding: "8px 12px", background: "var(--bg-panel)", fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase" }}>
                <span>skill</span><span style={{ textAlign: "right" }}>invocations</span><span style={{ textAlign: "right" }}>today</span><span style={{ textAlign: "right" }}>success</span><span style={{ textAlign: "right" }}>7-day</span>
              </div>
              {runRows.map((s, i) => { const sc = successColor(s.success); const today = stats[skillSlug(s.name)]?.today ?? 0; return (
                <div key={s.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 86px 60px 64px 90px", gap: 10, alignItems: "center", padding: "9px 12px", background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)", cursor: "pointer" }} onClick={() => { select("library"); setSelectedId(s.id); }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}><span style={{ color: KIND[s.kind].color }}>{KIND[s.kind].glyph}</span><span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span></span>
                  <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>{fmtCount(s.invocations)}</span>
                  <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>{today}</span>
                  <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: sc }}>{s.success}%</span>
                  <span style={{ display: "flex", justifyContent: "flex-end" }}>{s.trend.length > 1 ? <Spark data={s.trend} color={KIND[s.kind].color} /> : <span className="hint">—</span>}</span>
                </div>
              ); })}
            </div>
          )}
        </div></section>
      )}

      {mode === "catalog" && (
        <section className="an-page"><div className="an-wrap">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <input className="input" placeholder="Search the catalog…" value={catalogQuery} onChange={(e) => setCatalogQuery(e.target.value)} style={{ maxWidth: 320 }} />
            <span className="hint">{catalogList.length} of {availableCatalog.length}</span>
          </div>
          {catalogList.length === 0 ? (
            <div className="empty"><h3 style={{ margin: 0 }}>{availableCatalog.length === 0 ? "Library complete" : "No matches"}</h3></div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {catalogList.map((c) => (
                <div key={c.name} className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", gap: 11 }}><span style={{ width: 30, height: 30, borderRadius: 7, background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)", fontSize: 15, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{c.glyph}</span><div style={{ minWidth: 0 }}><div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", fontWeight: 600 }}>{c.name}</div><div className="hint" style={{ fontSize: 9.5 }}>by {c.by}</div></div></div>
                  <p style={{ margin: 0, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, flex: 1 }}>{c.desc}</p>
                  <button className="btn" onClick={() => setSelectedId(addSkill(defFromCatalog(c.name)))}>add to library</button>
                </div>
              ))}
            </div>
          )}
        </div></section>
      )}

      {/* New-group prompt */}
      {addGroupOpen && <NewGroupDialog onClose={() => setAddGroupOpen(false)} onCreate={(name) => { const id = addSkillGroup(name, GROUP_HUES[skillGroups.length % GROUP_HUES.length]); setGroupFilter(id); setAddGroupOpen(false); }} />}

      {/* Edit drawer */}
      {editing && (
        <SkillDrawer
          s={editing} isDraft={isDraft} projects={projects} groups={skillGroups}
          onPatch={(p) => patch(editing.id, p)} onClose={closeDrawer}
          onCommit={commitDraft} onDelete={() => { removeSkill(editing.id); closeDrawer(); }}
          onToggleGroup={(gid) => toggleSkillGroupMember(gid, editing.id)}
        />
      )}
    </div>
  );
}

function groupChip(hue: string, active: boolean): CSSProperties {
  return { display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", borderRadius: 99, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", flex: "0 0 auto", border: "1px solid " + (active ? hue : "var(--border)"), background: active ? tintBg(hue, 85) : "transparent", color: active ? hue : "var(--fg-muted)" };
}

function SkillCard({ s, groups, onOpen, onPin, onToggle }: { s: SkillDef; groups: SkillGroup[]; onOpen: () => void; onPin: () => void; onToggle: () => void }) {
  const sc = successColor(s.invocations > 0 ? s.success : null);
  return (
    <div className="skill-card" data-skill-id={s.id} onClick={onOpen} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: "13px 14px", cursor: "pointer", opacity: s.enabled ? 1 : 0.6 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
        <span style={glyphTile(s.kind, true)}>{KIND[s.kind].glyph}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 500, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name || "Untitled"}</span>
            <span style={{ flex: 1 }} />
            <span onClick={(e) => { e.stopPropagation(); onPin(); }} style={{ fontSize: 13, color: s.pinned ? "var(--accent)" : "var(--fg-dim)", cursor: "pointer" }}>★</span>
            <Toggle on={s.enabled} onClick={(e) => { e.stopPropagation(); onToggle(); }} />
          </div>
          <div style={{ fontSize: 11.5, color: "var(--fg-muted)", marginTop: 3, lineHeight: 1.45, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{s.desc || "No description yet."}</div>
        </div>
      </div>
      {groups.length > 0 && <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>{groups.map((g) => <span key={g.id} style={{ ...pill(g.hue), display: "inline-flex", alignItems: "center", gap: 4 }}>⬡ {g.name}</span>)}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 11, flexWrap: "wrap" }}>
        <span style={sourcePill(s.source)}>{SOURCE_TAG[s.source].label}</span>
        <span style={scopePill(s.projects)}>{s.projects.length ? s.projects[0] : "global"}</span>
        <span style={{ flex: 1 }} />
        {s.tools.slice(0, 3).map((t) => <span key={t} className="kbd" style={{ fontSize: 10 }}>{t}</span>)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 11, paddingTop: 10, borderTop: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", gap: 5 }}>{s.profiles.map((p) => <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: PROFILE_COLOR[p] }} /><span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{p}</span></span>)}</div>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: s.invocations ? "var(--fg-muted)" : "var(--fg-dim)" }}>{s.invocations ? fmtCount(s.invocations) + "×" : "never"}</span>
        {s.invocations > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: sc }}>{s.success}%</span>}
        {s.trend.length > 1 && <Spark data={s.trend} color={s.invocations ? KIND[s.kind].color : "var(--fg-dim)"} />}
      </div>
    </div>
  );
}

function NewGroupDialog({ onCreate, onClose }: { onCreate: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.5)" }} />
      <div style={{ position: "fixed", top: "30%", left: "50%", transform: "translateX(-50%)", zIndex: 71, width: 360, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>New task group</div>
        <div style={{ fontSize: 11.5, color: "var(--fg-muted)", marginBottom: 12 }}>A named ⬡ bundle of skills you can toggle onto a session or fleet stream at once.</div>
        <input autoFocus className="input" placeholder="e.g. Release day" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(name.trim()); }} style={{ width: "100%", marginBottom: 14 }} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>cancel</button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => onCreate(name.trim())}>create</button>
        </div>
      </div>
    </>
  );
}

function SkillDrawer({ s, isDraft, projects, groups, onPatch, onClose, onCommit, onDelete, onToggleGroup }: {
  s: SkillDef; isDraft: boolean; projects: GhProject[]; groups: SkillGroup[];
  onPatch: (p: Partial<SkillDef>) => void; onClose: () => void; onCommit: () => void; onDelete: () => void; onToggleGroup: (groupId: string) => void;
}) {
  const isGlobal = s.projects.length === 0;
  return (
    <>
      <div className="scrim on" onClick={onClose} />
      <div className="drawer on">
        <div className="dr-head">
          <span style={glyphTile(s.kind, true)}>{KIND[s.kind].glyph}</span>
          <div className="name">{s.name || (isDraft ? "New skill" : "Untitled skill")}</div>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="dr-body">
          <div className="field"><label>name <span className="hint">— slugs to .claude/skills/{skillSlug(s.name) || "…"}</span></label><input className="input" value={s.name} placeholder="Skill name" onChange={(e) => onPatch({ name: e.target.value })} /></div>
          <div style={{ display: "flex", gap: 16 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span className="hint">enabled</span><Toggle on={s.enabled} onClick={() => onPatch({ enabled: !s.enabled })} /></span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span className="hint">pinned</span><span onClick={() => onPatch({ pinned: !s.pinned })} style={{ fontSize: 14, color: s.pinned ? "var(--accent)" : "var(--fg-dim)", cursor: "pointer" }}>★</span></span>
          </div>
          <div className="field"><label>kind</label><div className="scope">{KIND_KEYS.map((k) => <button key={k} className={s.kind === k ? "on" : ""} onClick={() => onPatch({ kind: k })}>{KIND[k].label}</button>)}</div></div>
          <div className="field"><label>source</label><div className="scope">{SOURCE_KEYS.map((src) => <button key={src} className={s.source === src ? "on" : ""} onClick={() => onPatch({ source: src })}>{src}</button>)}</div></div>
          <div className="field"><label>description</label><input className="input" value={s.desc} placeholder="One line — SKILL.md frontmatter" onChange={(e) => onPatch({ desc: e.target.value })} /></div>
          <div className="field"><label>procedure — SKILL.md body</label><textarea className="ta" value={s.prompt} placeholder="The steps the agent follows…" onChange={(e) => onPatch({ prompt: e.target.value })} /></div>
          <div className="field"><label>bundled tools (comma-separated)</label><input className="input" value={s.tools.join(", ")} placeholder="create_pr, git_diff" onChange={(e) => onPatch({ tools: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} /></div>
          <div className="field"><label>allowed profiles</label><div className="scope">{PROFILE_KEYS.map((p) => <button key={p} className={s.profiles.includes(p) ? "on" : ""} onClick={() => onPatch({ profiles: s.profiles.includes(p) ? s.profiles.filter((x) => x !== p) : [...s.profiles, p] })}>{p}</button>)}</div></div>
          {/* Task groups */}
          <div className="field">
            <label>task groups</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {groups.length === 0 && <span className="hint">No groups yet — create one from the Task groups bar.</span>}
              {groups.map((g) => { const member = g.skillIds.includes(s.id); return (
                <span key={g.id} onClick={() => onToggleGroup(g.id)} style={{ ...pill(g.hue, !member), cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, opacity: member ? 1 : 0.6 }}>⬡ {g.name} {member ? "✓" : "＋"}</span>
              ); })}
            </div>
          </div>
          {/* Project assignment */}
          <div className="field">
            <label>project assignment</label>
            <div className="global-banner" style={isGlobal ? undefined : { opacity: 0.6 }}>
              <span className="gd" /><b style={{ color: isGlobal ? "var(--success)" : "var(--fg-muted)", fontWeight: 600 }}>Global (all projects)</b><div style={{ flex: 1 }} />
              <Toggle on={isGlobal} onClick={() => onPatch({ projects: isGlobal ? (projects[0] ? [String(projects[0].number)] : ["scoped"]) : [] })} />
            </div>
            {!isGlobal && (projects.length === 0
              ? <div className="hint" style={{ marginTop: 6 }}>No GitHub projects — connect GitHub in Settings to scope per project.</div>
              : <div className="proj-multi" style={{ marginTop: 6 }}>{projects.map((p) => { const sel = s.projects.includes(String(p.number)); return (
                  <div key={p.id} className={"pm-row" + (sel ? " on" : "")} onClick={() => onPatch({ projects: sel ? s.projects.filter((x) => x !== String(p.number)) : [...s.projects, String(p.number)] })}><div className="check">{sel ? "✓" : ""}</div><div className="pname">{p.title} <span className="hint">#{p.number}</span></div></div>
                ); })}</div>)}
          </div>
        </div>
        <div className="dr-foot">
          {isDraft ? <button className="btn ghost" onClick={onClose}>cancel</button> : <button className="btn ghost danger" onClick={onDelete}>remove</button>}
          <div className="spacer" />
          {isDraft ? <button className="btn primary" disabled={!s.name.trim()} onClick={onCommit}>done</button> : <button className="btn primary" onClick={onClose}>done</button>}
        </div>
      </div>
    </>
  );
}
