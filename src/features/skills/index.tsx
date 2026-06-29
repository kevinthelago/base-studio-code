// Skills screen — "Skills at Scale" redesign (#skills-groups). A library that stays fast with
// hundreds of skills: search + multi-facet filters + sort, four densities (List / Cards / Group /
// Kind), bulk actions, a collapsible KPI digest, and TASK GROUPS — named, reusable skill bundles
// (the ⬡) that filter the library and can be toggled onto a session/stream (see SessionSkillsModal
// + the planner channel). Reads/mutates the store `skills` + `skillGroups` slices; every enabled,
// in-scope (or group-/override-enabled) skill is written into a launched session as
// `.claude/skills/<slug>/SKILL.md`. Edits are live. Telemetry (Runs) is real, from the skill log.
import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { Pane } from "@/shared/ui/Pane";
import { EmptyState } from "@/shared/ui/EmptyState";
import { useDraft } from "@/shared/hooks/useDraft";
import { usePoll } from "@/shared/hooks/usePoll";
import { useAppStore } from "@/store";
import {
  KIND, PROFILE_COLOR, fmtCount,
  type SkillKind, type SkillSource, type SkillProfile,
} from "@/shared/data/skills";
import {
  blankSkill, deriveSkillKpis, parseSkillsFile, skillSlug,
  groupSkillCount, type SkillDef, type SkillGroup,
} from "./lib/skills";
import {
  mergeSkillStats, indexGroupsBySkill, buildFacetDefs, filterSkills, buildGroupedSections,
  SORTS, type Density, type SortKey, type FacetSelection,
} from "./lib/skillsFilter";
import { parseSkillLog, aggregateSkillTelemetry, type SkillStats } from "./lib/skillTelemetry";
import { successColor, tintBg, glyphTile, pill } from "./skillStyles";
import { SkillsListView, SkillsCardsView, SkillsGroupedView, type SkillRowHandlers } from "./SkillsViews";
import { Spark, HBars } from "@/shared/ui/charts";
import { Toggle } from "@/shared/ui/Toggle";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { type TabItem } from "@/app/chrome/TabBar";
import { Screen } from "@/app/chrome/Screen";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { LessonsTab } from "./LessonsTab";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import type { GhProjectRef as GhProject } from "@/shared/lib/github/types";
import "./skills.css";

type Mode = "library" | "lessons" | "runs";

const KIND_KEYS = Object.keys(KIND) as SkillKind[];
const PROFILE_KEYS = Object.keys(PROFILE_COLOR) as SkillProfile[];
const SOURCE_KEYS: SkillSource[] = ["first-party", "team", "imported", "community"];
const GROUP_HUES = ["var(--accent)", "var(--danger)", "var(--info)", "var(--violet)", "var(--success)", "var(--fg-muted)"];
const DRAFT_ID = "__draft__";

const PROJECTS_QUERY = `{ viewer { projectsV2(first: 50) { nodes { id title number } } } }`;

const MODES: Array<{ k: Mode; label: string }> = [
  { k: "library", label: "Library" }, { k: "lessons", label: "Lessons" }, { k: "runs", label: "Runs" },
];
const SKILL_TABS: TabItem[] = MODES.map((m) => ({ id: m.k, label: m.label }));

export function SkillsWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  const skills = useAppStore((s) => s.skills);
  const addSkill = useAppStore((s) => s.addSkill);
  const updateSkill = useAppStore((s) => s.updateSkill);
  const removeSkill = useAppStore((s) => s.removeSkill);
  const toggleSkill = useAppStore((s) => s.toggleSkill);
  const toggleSkillPin = useAppStore((s) => s.toggleSkillPin);
  const setSkillProjects = useAppStore((s) => s.setSkillProjects);
  const upsertSkills = useAppStore((s) => s.upsertSkills);
  const githubToken = useAppStore((s) => s.githubToken);
  // Lessons (#1362) are per-project (plan.db); the queue scopes to the active project.
  const activeProjectName = useAppStore((s) => s.activeProjectName);
  const lessonProjectKey = activeProjectName ? sanitizeProjectKey(activeProjectName) : "";
  const skillGroups = useAppStore((s) => s.skillGroups);
  const addSkillGroup = useAppStore((s) => s.addSkillGroup);
  const removeSkillGroup = useAppStore((s) => s.removeSkillGroup);
  const toggleSkillGroupMember = useAppStore((s) => s.toggleSkillGroupMember);

  const { tabs: skillTabs, activeId, select, reorder, tearOff } = usePageTabs("skills", SKILL_TABS);
  const mode: Mode = (pageOverride ?? activeId) as Mode;

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("Most invoked");
  const [sortOpen, setSortOpen] = useState(false);
  const [density, setDensity] = useState<Density>("list");
  const [digestOpen, setDigestOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupFilter, setGroupFilter] = useState<string | null>(null);     // selected task group id
  const [facetSel, setFacetSel] = useState<FacetSelection>({});
  const drawer = useDraft<SkillDef>({
    items: skills,
    newDraft: () => ({ ...blankSkill(), id: DRAFT_ID }),
    onUpdate: updateSkill,
    onCreate: (d) => { const { id: _id, ...def } = d; return addSkill(def); },
  });
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
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
  usePoll(async (isCancelled) => {
    const lines = await safeInvoke<string[]>("read_skill_log", { limit: 4000 }, []);
    if (!isCancelled()) setStats(aggregateSkillTelemetry(parseSkillLog((lines ?? []).join("\n")), new Date()));
  }, 5000);

  const merged = useMemo<SkillDef[]>(() => mergeSkillStats(skills, stats), [skills, stats]);

  // group membership index: skillId -> the groups it's in
  const groupsBySkill = useMemo(() => indexGroupsBySkill(skillGroups), [skillGroups]);

  const kpis = useMemo(() => deriveSkillKpis(merged), [merged]);
  const invToday = useMemo(() => Object.values(stats).reduce((a, s) => a + s.today, 0), [stats]);
  // Expanded digest: the "Most invoked" leaderboard (top 5 by invocations, actually run).
  const leaders = useMemo(
    () => [...merged].filter((s) => s.invocations > 0).sort((a, b) => b.invocations - a.invocations).slice(0, 5),
    [merged],
  );
  const neverRun = useMemo(() => merged.filter((s) => s.invocations === 0).length, [merged]);

  // ── facets ──────────────────────────────────────────────────────────────────
  const facetDefs = useMemo(() => buildFacetDefs(merged), [merged]);

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
  const filtered = useMemo(
    () => filterSkills(merged, { query, groupFilter, skillGroups, facetDefs, facetSel, sort }),
    [merged, query, groupFilter, skillGroups, facetDefs, facetSel, sort],
  );

  const isEmpty = filtered.length === 0;

  // ── selection / bulk ──────────────────────────────────────────────────────────
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAllMatching = () => setSelected(new Set(filtered.map((s) => s.id)));
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); setScopePickerOpen(false); };
  const bulk = (fn: (id: string) => void) => { selected.forEach(fn); };
  const bulkAddToGroup = (groupId: string) => { selected.forEach((id) => { const g = skillGroups.find((x) => x.id === groupId); if (g && !g.skillIds.includes(id)) toggleSkillGroupMember(groupId, id); }); };
  const bulkDelete = () => { selected.forEach((id) => removeSkill(id)); exitSelect(); };
  /** Set the selected skills' scope: [] = global, [projectNumber] = a single GitHub project. */
  const bulkSetScope = (projects: string[]) => { selected.forEach((id) => setSkillProjects(id, projects)); setScopePickerOpen(false); };
  /** Export the selected skills as a downloaded JSON array (the same shape `import` ingests). */
  const bulkExport = () => {
    const defs = skills.filter((s) => selected.has(s.id));
    if (!defs.length) return;
    const blob = new Blob([JSON.stringify(defs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `skills-export-${defs.length}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── drawer ────────────────────────────────────────────────────────────────────
  const editing = drawer.selected;
  const isDraft = drawer.isDraft;
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

  // ── shared row handlers (List + Grouped views) ──────────────────────────────────
  const rowHandlers: SkillRowHandlers = {
    selectMode, selected, groupsBySkill,
    onSelect: toggleSel,
    onOpen: drawer.select,
    onTogglePin: toggleSkillPin,
    onToggle: toggleSkill,
  };

  // grouped sections (by task group, or by kind in "kind" density)
  const groupedSections = useMemo(() => buildGroupedSections(density, filtered, skillGroups), [density, filtered, skillGroups]);
  // Grouped density with no task groups at all → everything lands in one "Ungrouped"
  // section; surface a hint to create groups rather than reading as a broken single bucket.
  const groupedNoGroups = density === "grouped" && skillGroups.length === 0;


  // ── runs ──────────────────────────────────────────────────────────────────────
  const runRows = useMemo(() => [...merged].filter((s) => s.invocations > 0).sort((a, b) => b.invocations - a.invocations), [merged]);

  return (
    <Screen
      tabs={skillTabs}
      active={mode}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      pageOverride={pageOverride}
      className="skills-screen"
      right={mode === "library"
        ? <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="btn" onClick={() => fileRef.current?.click()}>import</button>
            <button className="btn primary" onClick={drawer.startDraft}>+ skill</button>
            <span className="sync">● github sync</span>
          </div>
        : <span className="sync">● github sync</span>}
      overlay={
        <>
          {addGroupOpen && <NewGroupDialog onClose={() => setAddGroupOpen(false)} onCreate={(name) => { const id = addSkillGroup(name, GROUP_HUES[skillGroups.length % GROUP_HUES.length]); setGroupFilter(id); setAddGroupOpen(false); }} />}
          {editing && (
            <SkillDrawer
              s={editing} isDraft={isDraft} projects={projects} groups={skillGroups}
              onPatch={drawer.patch} onClose={drawer.close}
              onCommit={drawer.commit} onDelete={() => { removeSkill(editing.id); drawer.close(); }}
              onToggleGroup={(gid) => toggleSkillGroupMember(gid, editing.id)}
            />
          )}
        </>
      }
    >
      {/* Hidden import file input (the header "import" button triggers it). */}
      <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) importSkills(f); e.target.value = ""; }} />


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
            {digestOpen && (
              <div className="skills-digest" style={{ display: "flex", gap: 14, padding: "0 18px 14px 18px", alignItems: "stretch" }}>
                {[
                  { label: "Invoked 7d", value: fmtCount(kpis.invWeek), sub: leaders.length + " active skills" },
                  { label: "Avg success", value: kpis.invWeek ? kpis.avgSuccess + "%" : "—", sub: "across active" },
                  { label: "Never run", value: String(neverRun), sub: "candidates to prune" },
                ].map((t) => (
                  <div key={t.label} style={{ flex: "0 0 auto", width: 150, padding: "11px 13px", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }}>
                    <div style={{ fontSize: 10, color: "var(--fg-dim)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em" }}>{t.label}</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600, color: "var(--fg)", marginTop: 5 }}>{t.value}</div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 2 }}>{t.sub}</div>
                  </div>
                ))}
                <div className="skills-leaderboard" style={{ flex: 1, padding: "10px 14px", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)" }}>
                  <div style={{ fontSize: 10, color: "var(--fg-dim)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 7 }}>Most invoked</div>
                  {leaders.length === 0 ? (
                    <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>No invocations yet — run the fleet to populate the leaderboard.</div>
                  ) : (
                    <HBars
                      rows={leaders.map((s, i) => ({
                        label: `${i + 1}  ${s.name}`,
                        value: s.invocations,
                        color: KIND[s.kind].color,
                        strong: true,
                        tag: <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: successColor(s.success) }}>{s.success}%</span>,
                      }))}
                      fmtV={(v) => fmtCount(v) + "×"}
                    />
                  )}
                </div>
              </div>
            )}
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
          </div>

          {/* Body */}
          <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", overflow: "hidden" }}>
            {/* Facet column */}
            <div style={{ flex: "0 0 200px", overflowY: "auto", borderRight: "1px solid var(--border-soft)", background: "var(--bg-canvas)", padding: "14px 14px 40px 18px" }}>
              {/* Groups — the task-group selector (single-select, like the old quick-filter). */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--fg-dim)" }}>⬡ Groups</span>
                  <span style={{ flex: 1 }} />
                  <button onClick={() => setAddGroupOpen(true)} title="New group" style={{ background: "none", border: "none", color: "var(--fg-dim)", cursor: "pointer", fontSize: 11, padding: 0 }}>＋ New group</button>
                </div>
                {/* "All" / clear row */}
                <div onClick={() => setGroupFilter(null)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}>
                  <span style={{ width: 13, textAlign: "center", color: !groupFilter ? "var(--accent)" : "var(--fg-dim)", fontSize: 11 }}>≡</span>
                  <span style={{ fontSize: 12, color: !groupFilter ? "var(--fg)" : "var(--fg-muted)", fontWeight: !groupFilter ? 600 : 400 }}>All</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{merged.length}</span>
                </div>
                {skillGroups.map((g) => { const active = groupFilter === g.id; return (
                  <div key={g.id} data-group-id={g.id} onClick={() => setGroupFilter((v) => (v === g.id ? null : g.id))} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}>
                    <span style={{ width: 13, textAlign: "center", color: g.hue, fontSize: 11 }}>⬡</span>
                    <span style={{ fontSize: 12, color: active ? g.hue : "var(--fg)", fontWeight: active ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
                    {active && <span title="Delete group" onClick={(e) => { e.stopPropagation(); if (confirm("Delete this group? Skills are not deleted.")) { removeSkillGroup(g.id); setGroupFilter(null); } }} style={{ color: "var(--danger)", fontSize: 11, cursor: "pointer" }}>✕</span>}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{groupSkillCount(g, skills)}</span>
                  </div>
                ); })}
                {skillGroups.length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-dim)", padding: "2px 0", lineHeight: 1.4 }}>No groups yet — bundle related skills into a group.</div>}
              </div>
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
                  <div style={{ position: "relative", display: "inline-flex" }}>
                    <button className="btn" disabled={selected.size === 0} onClick={() => setScopePickerOpen((v) => !v)}>Set scope…</button>
                    {scopePickerOpen && (
                      <div style={{ position: "absolute", top: 32, left: 0, zIndex: 50, minWidth: 200, maxHeight: 240, overflowY: "auto", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", boxShadow: "0 14px 36px rgba(0,0,0,.45)", padding: 4 }}>
                        <div onClick={() => bulkSetScope([])} style={{ padding: "6px 9px", borderRadius: 4, fontSize: 11.5, cursor: "pointer", color: "var(--fg)" }}>Global (all projects)</div>
                        {projects.length === 0
                          ? <div style={{ padding: "6px 9px", fontSize: 10.5, color: "var(--fg-dim)" }}>Connect GitHub in Settings to scope per project.</div>
                          : projects.map((p) => <div key={p.id} onClick={() => bulkSetScope([String(p.number)])} style={{ padding: "6px 9px", borderRadius: 4, fontSize: 11.5, cursor: "pointer", color: "var(--fg-muted)" }}>{p.title} <span style={{ color: "var(--fg-dim)" }}>#{p.number}</span></div>)}
                      </div>
                    )}
                  </div>
                  {skillGroups.length > 0 && (
                    <select className="input" style={{ height: 26, fontSize: 11 }} value="" onChange={(e) => { if (e.target.value) bulkAddToGroup(e.target.value); e.target.value = ""; }}>
                      <option value="">⬡ Add to group…</option>
                      {skillGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  )}
                  <button className="btn" disabled={selected.size === 0} onClick={bulkExport}>Export</button>
                  <button className="btn" style={{ borderColor: tintBg("var(--danger)", 60), color: "var(--danger)" }} onClick={bulkDelete}>Delete</button>
                </div>
              )}

              {isEmpty ? (
                <EmptyState
                  icon="⌕"
                  iconVariant="dashed"
                  title="No skills match"
                  description="Nothing matches the active search + filters. Create a skill, import one, or clear the filters."
                  style={{ padding: "80px 20px" }}
                  actions={<>
                    <button className="btn" onClick={clearFilters}>Clear filters</button>
                    <button className="btn primary" onClick={drawer.startDraft}>+ new skill</button>
                  </>}
                />
              ) : density === "list" ? (
                <SkillsListView filtered={filtered} h={rowHandlers} />
              ) : density === "cards" ? (
                <SkillsCardsView filtered={filtered} groupsBySkill={groupsBySkill}
                  onOpen={drawer.select} onPin={toggleSkillPin} onToggle={toggleSkill} />
              ) : (
                <SkillsGroupedView sections={groupedSections} showNoGroupsHint={groupedNoGroups}
                  onNewGroup={() => setAddGroupOpen(true)} h={rowHandlers} />
              )}
            </div>
          </div>
        </div>
      )}

      {mode === "lessons" && (
        <LessonsTab projectKey={lessonProjectKey} projectName={activeProjectName ?? undefined} />
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
                <div key={s.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 86px 60px 64px 90px", gap: 10, alignItems: "center", padding: "9px 12px", background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)", cursor: "pointer" }} onClick={() => { select("library"); drawer.select(s.id); }}>
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

    </Screen>
  );
}

function NewGroupDialog({ onCreate, onClose }: { onCreate: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 360, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: 18, boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>New task group</div>
        <div style={{ fontSize: 11.5, color: "var(--fg-muted)", marginBottom: 12 }}>A named ⬡ bundle of skills you can toggle onto a session or fleet stream at once.</div>
        <input autoFocus className="input" placeholder="e.g. Release day" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(name.trim()); }} style={{ width: "100%", marginBottom: 14 }} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>cancel</button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => onCreate(name.trim())}>create</button>
        </div>
      </div>
    </div>
  );
}

function SkillDrawer({ s, isDraft, projects, groups, onPatch, onClose, onCommit, onDelete, onToggleGroup }: {
  s: SkillDef; isDraft: boolean; projects: GhProject[]; groups: SkillGroup[];
  onPatch: (p: Partial<SkillDef>) => void; onClose: () => void; onCommit: () => void; onDelete: () => void; onToggleGroup: (groupId: string) => void;
}) {
  const isGlobal = s.projects.length === 0;
  return (
    <Pane
      open
      isDraft={isDraft}
      onClose={onClose}
      onCommit={onCommit}
      onRemove={onDelete}
      commitDisabled={!s.name.trim()}
      header={<>
        <span style={glyphTile(s.kind, true)}>{KIND[s.kind].glyph}</span>
        <div className="name">{s.name || (isDraft ? "New skill" : "Untitled skill")}</div>
      </>}
    >
          <div className="field"><label>name <span className="hint">— slugs to .claude/skills/{skillSlug(s.name) || "…"}</span></label><input className="input" value={s.name} placeholder="Skill name" onChange={(e) => onPatch({ name: e.target.value })} /></div>
          <div style={{ display: "flex", gap: 16 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span className="hint">enabled</span><Toggle size="sm" on={s.enabled} onClick={() => onPatch({ enabled: !s.enabled })} /></span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span className="hint">pinned</span><span onClick={() => onPatch({ pinned: !s.pinned })} style={{ fontSize: 14, color: s.pinned ? "var(--accent)" : "var(--fg-dim)", cursor: "pointer" }}>★</span></span>
          </div>
          <div className="field"><label>kind</label><SegmentedControl options={KIND_KEYS.map((k) => ({ label: KIND[k].label, on: s.kind === k, onClick: () => onPatch({ kind: k }) }))} /></div>
          <div className="field"><label>source</label><SegmentedControl options={SOURCE_KEYS.map((src) => ({ label: src, on: s.source === src, onClick: () => onPatch({ source: src }) }))} /></div>
          <div className="field"><label>description</label><input className="input" value={s.desc} placeholder="One line — SKILL.md frontmatter" onChange={(e) => onPatch({ desc: e.target.value })} /></div>
          <div className="field"><label>procedure — SKILL.md body</label><textarea className="ta" value={s.prompt} placeholder="The steps the agent follows…" onChange={(e) => onPatch({ prompt: e.target.value })} /></div>
          <div className="field"><label>bundled tools (comma-separated)</label><input className="input" value={s.tools.join(", ")} placeholder="create_pr, git_diff" onChange={(e) => onPatch({ tools: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} /></div>
          <div className="field"><label>allowed profiles</label><SegmentedControl options={PROFILE_KEYS.map((p) => ({ label: p, on: s.profiles.includes(p), onClick: () => onPatch({ profiles: s.profiles.includes(p) ? s.profiles.filter((x) => x !== p) : [...s.profiles, p] }) }))} /></div>
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
              <Toggle size="sm" on={isGlobal} onClick={() => onPatch({ projects: isGlobal ? (projects[0] ? [String(projects[0].number)] : ["scoped"]) : [] })} />
            </div>
            {!isGlobal && (projects.length === 0
              ? <div className="hint" style={{ marginTop: 6 }}>No GitHub projects — connect GitHub in Settings to scope per project.</div>
              : <div className="proj-multi" style={{ marginTop: 6 }}>{projects.map((p) => { const sel = s.projects.includes(String(p.number)); return (
                  <div key={p.id} className={"pm-row" + (sel ? " on" : "")} onClick={() => onPatch({ projects: sel ? s.projects.filter((x) => x !== String(p.number)) : [...s.projects, String(p.number)] })}><div className="check">{sel ? "✓" : ""}</div><div className="pname">{p.title} <span className="hint">#{p.number}</span></div></div>
                ); })}</div>)}
          </div>
    </Pane>
  );
}

// Re-exported feature surface — this index is the skills feature's public API barrel (#1309).
export { SkillsStatus } from "./SkillsStatus";
export { SessionSkillsModal, type SessionSkillsModalProps } from "./SessionSkillsModal";
