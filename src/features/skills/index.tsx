// Skills screen — "Skills at Scale" redesign (#skills-groups). A library that stays fast with
// hundreds of skills: search + multi-facet filters + sort, four densities (List / Cards / Group /
// Kind), bulk actions, a collapsible KPI digest, and TASK GROUPS — named, reusable skill bundles
// (the ⬡) that filter the library and can be toggled onto a session/stream (see SessionSkillsModal
// + the planner channel). Reads/mutates the store `skills` + `skillGroups` slices; every enabled,
// in-scope (or group-/override-enabled) skill is written into a launched session as
// `.claude/skills/<slug>/SKILL.md`. Edits are live. Telemetry (Runs) is real, from the skill log.
import { useState, useEffect, useMemo } from "react";
import { Banner } from "@/shared/ui/feedback/Banner";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { Pane } from "@/shared/ui/overlay/Pane";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { useDraft } from "@/shared/hooks/useDraft";
import { usePoll } from "@/shared/hooks/usePoll";
import { useAppStore } from "@/store";
import {
  KIND, PROFILE_COLOR, fmtCount,
  type SkillKind, type SkillSource, type SkillProfile,
} from "@/shared/data/skills";
import {
  blankSkill, deriveSkillKpis, skillSlug,
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
import { Toggle } from "@/shared/ui/controls/Toggle";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { Button } from "@/shared/ui/controls/Button";
import { TextField } from "@/shared/ui/controls/Field";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
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
      className="skills-workspace"
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


      {mode === "library" && (
        <Stack style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          {/* KPI digest (collapsible) */}
          <Box bg="var(--bg-canvas)" style={{ borderBottom: "1px solid var(--border-soft)"}}>
            <Row gap={18} style={{ padding: "9px 18px", fontSize: 11.5, color: "var(--fg-muted)" }}>
              {/* eslint-disable-next-line no-restricted-syntax -- bespoke borderless disclosure toggle (chevron + label), not a .btn control */}
              <button onClick={() => setDigestOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "var(--fg-dim)", cursor: "pointer", fontSize: 11, padding: 0 }}>
                <Text as="span" size={9} style={{ display: "inline-block", transform: digestOpen ? "rotate(90deg)" : "none" }}>▸</Text>
                <Text as="span" mono size={9.5} style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>Fleet digest · 7d</Text>
              </button>
              <Box as="span"><b className="mono" style={{ color: "var(--fg)" }}>{kpis.total}</b> skills</Box>
              <Box as="span"><b className="mono" style={{ color: "var(--fg)" }}>{merged.filter((s) => s.enabled).length}</b> enabled</Box>
              <Text as="span" tone="accent">★ <b className="mono" style={{ color: "var(--fg)" }}>{kpis.pinned}</b></Text>
              <Box as="span"><b className="mono" style={{ color: "var(--fg)" }}>{invToday}</b> today</Box>
              <Box as="span"><b className="mono" style={{ color: "var(--success)" }}>{kpis.invWeek ? kpis.avgSuccess + "%" : "—"}</b> avg success</Box>
            </Row>
            {digestOpen && (
              <Row gap={14} align="stretch" className="skills-digest" style={{ padding: "0 18px 14px 18px" }}>
                {[
                  { label: "Invoked 7d", value: fmtCount(kpis.invWeek), sub: leaders.length + " active skills" },
                  { label: "Avg success", value: kpis.invWeek ? kpis.avgSuccess + "%" : "—", sub: "across active" },
                  { label: "Never run", value: String(neverRun), sub: "candidates to prune" },
                ].map((t) => (
                  <Box key={t.label} pad={[11, 13]} bg="var(--bg-panel)" border="soft" radius="lg" style={{ flex: "0 0 auto", width: 150}}>
                    <Box className="mono-label">{t.label}</Box>
                    <Text as="div" mono size={20} weight={600} style={{ color: "var(--fg)", marginTop: 5 }}>{t.value}</Text>
                    <Text as="div" size={10.5} tone="muted" style={{ marginTop: 2 }}>{t.sub}</Text>
                  </Box>
                ))}
                <Box className="skills-leaderboard" pad={[10, 14]} bg="var(--bg-panel)" border="soft" radius="lg" style={{ flex: 1}}>
                  <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 7 }}>Most invoked</Text>
                  {leaders.length === 0 ? (
                    <Text as="div" size={11} tone="dim">No invocations yet — run the fleet to populate the leaderboard.</Text>
                  ) : (
                    <HBars
                      rows={leaders.map((s, i) => ({
                        label: `${i + 1}  ${s.name}`,
                        value: s.invocations,
                        color: KIND[s.kind].color,
                        strong: true,
                        tag: <Text as="span" mono size={10} style={{ color: successColor(s.success) }}>{s.success}%</Text>,
                      }))}
                      fmtV={(v) => fmtCount(v) + "×"}
                    />
                  )}
                </Box>
              </Row>
            )}
          </Box>

          {/* Command bar */}
          <Row gap={10} style={{ padding: "10px 18px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
            <Row gap={8} style={{ flex: 1, maxWidth: 440, height: 30, padding: "0 11px", background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
              <Text as="span" tone="dim" size={13}>⌕</Text>
              {/* eslint-disable-next-line no-restricted-syntax -- inline borderless search box inside a toolbar Row; TextField's .field wrapper doesn't fit */}
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, description, tools…" style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--fg)", fontSize: 12.5 }} />
            </Row>
            <Text as="span" mono size={11} tone="muted">{filtered.length} <Text as="span" tone="dim">of {kpis.total}</Text></Text>
            <Box as="span" style={{ flex: 1 }} />
            <Row gap={6} style={{ position: "relative" }}>
              <Text as="span" mono size={10} tone="dim" style={{ textTransform: "uppercase" }}>Sort</Text>
              {/* eslint-disable-next-line no-restricted-syntax -- bespoke dropdown trigger with a custom popover menu, not a .btn control */}
              <button onClick={() => setSortOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", background: "var(--bg-canvas)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", fontSize: 11.5, color: "var(--fg)", cursor: "pointer" }}>{sort} <Text as="span" tone="dim" size={9}>▾</Text></button>
              {sortOpen && (
                <Box pad={4} bg="var(--bg-elev)" border radius="md" style={{ position: "absolute", top: 34, right: 0, zIndex: 40, minWidth: 184, boxShadow: "0 14px 36px rgba(0,0,0,.45)"}}>
                  {SORTS.map((o) => <Row key={o} onClick={() => { setSort(o); setSortOpen(false); }} gap={8} style={{ padding: "6px 9px", borderRadius: 4, fontSize: 11.5, cursor: "pointer", color: sort === o ? "var(--fg)" : "var(--fg-muted)", background: sort === o ? "var(--bg-elev2)" : "transparent" }}><Box as="span" style={{ flex: 1 }}>{o}</Box><Text as="span" tone="accent">{sort === o ? "✓" : ""}</Text></Row>)}
                </Box>
              )}
            </Row>
            <Row align="stretch" style={{ height: 28, border: "1px solid var(--border)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
              {([["list", "☰ List"], ["cards", "▦ Cards"], ["grouped", "⬡ Group"], ["kind", "⊟ Kind"]] as const).map(([d, lbl], i) => (
                <Row key={d} onClick={() => setDensity(d)} style={{ padding: "0 11px", fontSize: 11, cursor: "pointer", background: density === d ? "var(--bg-elev2)" : "transparent", color: density === d ? "var(--fg)" : "var(--fg-dim)", borderRight: i < 3 ? "1px solid var(--border)" : "none" }}>{lbl}</Row>
              ))}
            </Row>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke toggle button with active-state inline styling, not a .btn control */}
            <button onClick={() => (selectMode ? exitSelect() : setSelectMode(true))} style={{ height: 28, padding: "0 12px", borderRadius: "var(--r-md)", fontSize: 11.5, cursor: "pointer", border: "1px solid " + (selectMode ? "var(--accent-dim)" : "var(--border)"), background: selectMode ? tintBg("var(--accent)", 86) : "var(--bg-canvas)", color: selectMode ? "var(--accent)" : "var(--fg)" }}>{selectMode ? "✓ Selecting" : "☑ Select"}</button>
          </Row>

          {/* Body */}
          <Row align="stretch" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            {/* Facet column */}
            <Box bg="var(--bg-canvas)" style={{ flex: "0 0 200px", overflowY: "auto", borderRight: "1px solid var(--border-soft)", padding: "14px 14px 40px 18px" }}>
              {/* Groups — the task-group selector (single-select, like the old quick-filter). */}
              <Box style={{ marginBottom: 18 }}>
                <Row gap={6} style={{ marginBottom: 8 }}>
                  <Text as="span" mono size={9.5} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>⬡ Groups</Text>
                  <Box as="span" style={{ flex: 1 }} />
                  {/* eslint-disable-next-line no-restricted-syntax -- bespoke borderless text link in a facet header, not a .btn control */}
                  <button onClick={() => setAddGroupOpen(true)} title="New group" style={{ background: "none", border: "none", color: "var(--fg-dim)", cursor: "pointer", fontSize: 11, padding: 0 }}>＋ New group</button>
                </Row>
                {/* "All" / clear row */}
                <Row onClick={() => setGroupFilter(null)} gap={8} style={{ padding: "3px 0", cursor: "pointer" }}>
                  <Text as="span" size={11} style={{ width: 13, textAlign: "center", color: !groupFilter ? "var(--accent)" : "var(--fg-dim)" }}>≡</Text>
                  <Text as="span" size={12} style={{ color: !groupFilter ? "var(--fg)" : "var(--fg-muted)", fontWeight: !groupFilter ? 600 : 400 }}>All</Text>
                  <Box as="span" style={{ flex: 1 }} />
                  <Text as="span" mono size={10} tone="dim">{merged.length}</Text>
                </Row>
                {skillGroups.map((g) => { const active = groupFilter === g.id; return (
                  <Row key={g.id} data-group-id={g.id} onClick={() => setGroupFilter((v) => (v === g.id ? null : g.id))} gap={8} style={{ padding: "3px 0", cursor: "pointer" }}>
                    <Text as="span" size={11} style={{ width: 13, textAlign: "center", color: g.hue }}>⬡</Text>
                    <Text as="span" size={12} style={{ color: active ? g.hue : "var(--fg)", fontWeight: active ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</Text>
                    {active && <Text as="span" tone="danger" size={11} title="Delete group" onClick={(e: React.MouseEvent) => { e.stopPropagation(); if (confirm("Delete this group? Skills are not deleted.")) { removeSkillGroup(g.id); setGroupFilter(null); } }} style={{ cursor: "pointer" }}>✕</Text>}
                    <Box as="span" style={{ flex: 1 }} />
                    <Text as="span" mono size={10} tone="dim">{groupSkillCount(g, skills)}</Text>
                  </Row>
                ); })}
                {skillGroups.length === 0 && <Text as="div" size={10.5} tone="dim" style={{ padding: "2px 0", lineHeight: 1.4 }}>No groups yet — bundle related skills into a group.</Text>}
              </Box>
              {facetDefs.map((f) => (
                <Box key={f.key} style={{ marginBottom: 18 }}>
                  <Text as="div" mono size={9.5} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>{f.title}</Text>
                  {f.options.map((o) => { const on = facetSel[f.key]?.has(o.value) ?? false; return (
                    <Row key={o.value} onClick={() => toggleFacet(f.key, o.value)} gap={8} style={{ padding: "3px 0", cursor: "pointer" }}>
                      <Checkbox checked={on} />
                      {o.glyph && <Text as="span" mono size={11} style={{ color: o.color, width: 13, textAlign: "center" }}>{o.glyph}</Text>}
                      <Text as="span" size={12} style={{ color: "var(--fg)", textTransform: "capitalize" }}>{o.label}</Text>
                      <Box as="span" style={{ flex: 1 }} />
                      <Text as="span" mono size={10} tone="dim">{o.count}</Text>
                    </Row>
                  ); })}
                </Box>
              ))}
              {(activeFacetCount > 0 || query || groupFilter) &&
                // eslint-disable-next-line no-restricted-syntax -- bespoke borderless underlined text link, not a .btn control
                <button onClick={clearFilters} style={{ fontSize: 11, color: "var(--fg-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>clear all filters</button>}
            </Box>

            {/* Main */}
            <Box style={{ flex: 1, minWidth: 0, overflowY: "auto", paddingBottom: 60 }}>
              {selectMode && (
                <Row gap={10} wrap style={{ margin: "12px 18px", padding: "9px 13px", background: tintBg("var(--accent)", 90), border: "1px solid var(--accent-dim)", borderRadius: "var(--r-lg)" }}>
                  <Text as="span" mono size={12} weight={600} tone="accent">{selected.size} selected</Text>
                  <Text as="span" size={11} tone="muted" onClick={selectAllMatching} style={{ textDecoration: "underline", cursor: "pointer" }}>Select all {filtered.length} matching</Text>
                  <Box as="span" style={{ flex: 1 }} />
                  <Button onClick={() => bulk((id) => { const s = skills.find((x) => x.id === id); if (s && !s.enabled) toggleSkill(id); })}>Enable</Button>
                  <Button onClick={() => bulk((id) => { const s = skills.find((x) => x.id === id); if (s && s.enabled) toggleSkill(id); })}>Disable</Button>
                  <Button onClick={() => bulk((id) => { const s = skills.find((x) => x.id === id); if (s && !s.pinned) toggleSkillPin(id); })}>★ Pin</Button>
                  <Row inline align="stretch" style={{ position: "relative" }}>
                    <Button disabled={selected.size === 0} onClick={() => setScopePickerOpen((v) => !v)}>Set scope…</Button>
                    {scopePickerOpen && (
                      <Box pad={4} bg="var(--bg-elev)" border radius="md" style={{ position: "absolute", top: 32, left: 0, zIndex: 50, minWidth: 200, maxHeight: 240, overflowY: "auto", boxShadow: "0 14px 36px rgba(0,0,0,.45)"}}>
                        <Text as="div" size={11.5} onClick={() => bulkSetScope([])} style={{ padding: "6px 9px", borderRadius: 4, cursor: "pointer", color: "var(--fg)" }}>Global (all projects)</Text>
                        {projects.length === 0
                          ? <Text as="div" size={10.5} tone="dim" style={{ padding: "6px 9px" }}>Connect GitHub in Settings to scope per project.</Text>
                          : projects.map((p) => <Text as="div" key={p.id} size={11.5} tone="muted" onClick={() => bulkSetScope([String(p.number)])} style={{ padding: "6px 9px", borderRadius: 4, cursor: "pointer" }}>{p.title} <Text as="span" tone="dim">#{p.number}</Text></Text>)}
                      </Box>
                    )}
                  </Row>
                  {skillGroups.length > 0 && (
                    // eslint-disable-next-line no-restricted-syntax -- inline self-resetting action select in a bulk-action toolbar Row; SelectField's labelled .field wrapper doesn't fit
                    <select className="input" style={{ height: 26, fontSize: 11 }} value="" onChange={(e) => { if (e.target.value) bulkAddToGroup(e.target.value); e.target.value = ""; }}>
                      <option value="">⬡ Add to group…</option>
                      {skillGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  )}
                  <Button disabled={selected.size === 0} onClick={bulkExport}>Export</Button>
                  <Button style={{ borderColor: tintBg("var(--danger)", 60), color: "var(--danger)" }} onClick={bulkDelete}>Delete</Button>
                </Row>
              )}

              {isEmpty ? (
                <EmptyState
                  icon="⌕"
                  iconVariant="dashed"
                  title="No skills match"
                  description="Nothing matches the active search + filters. Create a skill, import one, or clear the filters."
                  style={{ padding: "80px 20px" }}
                  actions={<>
                    <Button onClick={clearFilters}>Clear filters</Button>
                    <Button variant="primary" onClick={drawer.startDraft}>+ new skill</Button>
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
            </Box>
          </Row>
        </Stack>
      )}

      {mode === "lessons" && (
        <LessonsTab projectKey={lessonProjectKey} projectName={activeProjectName ?? undefined} />
      )}

      {mode === "runs" && (
        <Box as="section" className="an-page"><Box className="an-wrap">
          <h2 className="mono" style={{ margin: "0 0 4px", fontSize: 18 }}>Runs</h2>
          <Text as="div" tone="muted" size={12} style={{ marginBottom: 14 }}>Live skill invocations from the usage log · last 7 days</Text>
          {runRows.length === 0 ? (
            <EmptyState title="No runs yet" description="Run the fleet — each time an agent invokes a skill it's logged here with its success rate and 7-day trend." />
          ) : (
            <Box border="soft" radius={6} style={{ overflow: "hidden" }}>
              <Grid className="mono" cols="1.6fr 86px 60px 64px 90px" gap={10} style={{ padding: "8px 12px", background: "var(--bg-panel)", fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase" }}>
                <Box as="span">skill</Box><Box as="span" style={{ textAlign: "right" }}>invocations</Box><Box as="span" style={{ textAlign: "right" }}>today</Box><Box as="span" style={{ textAlign: "right" }}>success</Box><Box as="span" style={{ textAlign: "right" }}>7-day</Box>
              </Grid>
              {runRows.map((s, i) => { const sc = successColor(s.success); const today = stats[skillSlug(s.name)]?.today ?? 0; return (
                <Grid key={s.id} cols="1.6fr 86px 60px 64px 90px" gap={10} align="center" style={{ padding: "9px 12px", background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)", cursor: "pointer" }} onClick={() => { select("library"); drawer.select(s.id); }}>
                  <Row inline gap={8} style={{ minWidth: 0 }}><Text as="span" style={{ color: KIND[s.kind].color }}>{KIND[s.kind].glyph}</Text><Text as="span" mono size={11} style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</Text></Row>
                  <Text as="span" mono size={11} tone="muted" style={{ textAlign: "right" }}>{fmtCount(s.invocations)}</Text>
                  <Text as="span" mono size={11} tone="muted" style={{ textAlign: "right" }}>{today}</Text>
                  <Text as="span" mono size={11} style={{ textAlign: "right", color: sc }}>{s.success}%</Text>
                  <Row justify="end">{s.trend.length > 1 ? <Spark data={s.trend} color={KIND[s.kind].color} /> : <Box as="span" className="hint">—</Box>}</Row>
                </Grid>
              ); })}
            </Box>
          )}
        </Box></Box>
      )}

    </Screen>
  );
}

function NewGroupDialog({ onCreate, onClose }: { onCreate: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <Box className="modal-scrim" onClick={onClose}>
      <Box onClick={(e) => e.stopPropagation()} pad={18} bg="var(--bg-panel)" border radius="lg" style={{ width: 360, boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
        <Text as="div" size={14} weight={600} style={{ marginBottom: 4 }}>New task group</Text>
        <Text as="div" size={11.5} tone="muted" style={{ marginBottom: 12 }}>A named ⬡ bundle of skills you can toggle onto a session or fleet stream at once.</Text>
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke autofocus dialog input with Enter-to-submit and a layout-critical marginBottom that TextField's .field wrapper would displace */}
        <input autoFocus className="input" placeholder="e.g. Release day" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(name.trim()); }} style={{ width: "100%", marginBottom: 14 }} />
        <Row align="stretch" gap={8} justify="end">
          <Button onClick={onClose}>cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => onCreate(name.trim())}>create</Button>
        </Row>
      </Box>
    </Box>
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
        <Box as="span" style={glyphTile(s.kind, true)}>{KIND[s.kind].glyph}</Box>
        <Box className="name">{s.name || (isDraft ? "New skill" : "Untitled skill")}</Box>
      </>}
    >
          <TextField label={<>name <Box as="span" className="hint">— slugs to .claude/skills/{skillSlug(s.name) || "…"}</Box></>} value={s.name} placeholder="Skill name" onChange={(v) => onPatch({ name: v })} />
          <Row align="stretch" gap={16}>
            <Row inline gap={8}><Box as="span" className="hint">enabled</Box><Toggle size="sm" on={s.enabled} onClick={() => onPatch({ enabled: !s.enabled })} /></Row>
            <Row inline gap={8}><Box as="span" className="hint">pinned</Box><Text as="span" size={14} onClick={() => onPatch({ pinned: !s.pinned })} style={{ color: s.pinned ? "var(--accent)" : "var(--fg-dim)", cursor: "pointer" }}>★</Text></Row>
          </Row>
          <Box className="field"><label>kind</label><SegmentedControl options={KIND_KEYS.map((k) => ({ label: KIND[k].label, on: s.kind === k, onClick: () => onPatch({ kind: k }) }))} /></Box>
          <Box className="field"><label>source</label><SegmentedControl options={SOURCE_KEYS.map((src) => ({ label: src, on: s.source === src, onClick: () => onPatch({ source: src }) }))} /></Box>
          <TextField label="description" value={s.desc} placeholder="One line — SKILL.md frontmatter" onChange={(v) => onPatch({ desc: v })} />
          <Box className="field"><label>procedure — SKILL.md body</label>
            {/* eslint-disable-next-line no-restricted-syntax -- multiline procedure body; the UI-kit has no textarea primitive */}
            <textarea className="ta" value={s.prompt} placeholder="The steps the agent follows…" onChange={(e) => onPatch({ prompt: e.target.value })} /></Box>
          <TextField label="bundled tools (comma-separated)" value={s.tools.join(", ")} placeholder="create_pr, git_diff" onChange={(v) => onPatch({ tools: v.split(",").map((t) => t.trim()).filter(Boolean) })} />
          <Box className="field"><label>allowed profiles</label><SegmentedControl options={PROFILE_KEYS.map((p) => ({ label: p, on: s.profiles.includes(p), onClick: () => onPatch({ profiles: s.profiles.includes(p) ? s.profiles.filter((x) => x !== p) : [...s.profiles, p] }) }))} /></Box>
          {/* Task groups */}
          <Box className="field">
            <label>task groups</label>
            <Row align="stretch" gap={6} wrap>
              {groups.length === 0 && <Box as="span" className="hint">No groups yet — create one from the Task groups bar.</Box>}
              {groups.map((g) => { const member = g.skillIds.includes(s.id); return (
                <Box as="span" key={g.id} onClick={() => onToggleGroup(g.id)} style={{ ...pill(g.hue, !member), cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, opacity: member ? 1 : 0.6 }}>⬡ {g.name} {member ? "✓" : "＋"}</Box>
              ); })}
            </Row>
          </Box>
          {/* Project assignment */}
          <Box className="field">
            <label>project assignment</label>
            <Banner tone="success" style={isGlobal ? undefined : { opacity: 0.6 }} lead={<Box as="span" bg="var(--success)" style={{ width: 7, height: 7, borderRadius: "50%"}} />}>
              <b style={{ color: isGlobal ? "var(--success)" : "var(--fg-muted)", fontWeight: 600 }}>Global (all projects)</b><Spacer />
              <Toggle size="sm" on={isGlobal} onClick={() => onPatch({ projects: isGlobal ? (projects[0] ? [String(projects[0].number)] : ["scoped"]) : [] })} />
            </Banner>
            {!isGlobal && (projects.length === 0
              ? <Box className="hint" style={{ marginTop: 6 }}>No GitHub projects — connect GitHub in Settings to scope per project.</Box>
              : <Box className="proj-multi" style={{ marginTop: 6 }}>{projects.map((p) => { const sel = s.projects.includes(String(p.number)); return (
                  <Box key={p.id} className={"pm-row" + (sel ? " on" : "")} onClick={() => onPatch({ projects: sel ? s.projects.filter((x) => x !== String(p.number)) : [...s.projects, String(p.number)] })}><Box className="check">{sel ? "✓" : ""}</Box><Box className="pname">{p.title} <Box as="span" className="hint">#{p.number}</Box></Box></Box>
                ); })}</Box>)}
          </Box>
    </Pane>
  );
}

// Re-exported feature surface — this index is the skills feature's public API barrel (#1309).
export { SkillsStatus } from "./SkillsStatus";
export { SessionSkillsModal, type SessionSkillsModalProps } from "./SessionSkillsModal";
