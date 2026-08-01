// Skills screen — "Skills at Scale" redesign (#skills-groups). A library that stays fast with
// hundreds of skills: search + multi-facet filters + sort, four densities (List / Cards / Group /
// Kind), bulk actions, a collapsible KPI digest, and TASK GROUPS — named, reusable skill bundles
// (the ⬡) that filter the library and can be toggled onto a session/stream (see SessionSkillsModal
// + the planner channel). Reads/mutates the store `skills` + `skillGroups` slices; every enabled,
// in-scope (or group-/override-enabled) skill is written into a launched session as
// `.claude/skills/<slug>/SKILL.md`. Edits are live. Telemetry (Runs) is real, from the skill log.
import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logsTail } from "@/shared/lib/core/logsBridge";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { useDraft } from "@/shared/hooks/useDraft";
import { usePoll } from "@/shared/hooks/usePoll";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { useAppStore } from "@/store";
import {
  blankSkill, deriveSkillKpis, groupSkillCount, type SkillDef,
} from "./lib/skills";
import {
  mergeSkillStats, indexGroupsBySkill, buildFacetDefs, filterSkills, buildGroupedSections,
  SORTS, type Density, type SortKey, type FacetSelection,
} from "./lib/skillsFilter";
import { parseSkillLog, aggregateSkillTelemetry, type SkillStats } from "./lib/skillTelemetry";
import { tintBg } from "./skillStyles";
import { SkillsListView, SkillsCardsView, SkillsGroupedView, type SkillRowHandlers } from "./SkillsViews";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { Button } from "@/shared/ui/controls/Button";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { RailSection } from "@/shared/ui/layouts/RailSection";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { useRailSections } from "@/shared/hooks/useRailSections";
import { type TabItem } from "@/shared/ui/layouts/TabBar";
import { Screen } from "@/shared/ui/layouts/Screen";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { LessonsTab } from "./LessonsTab";
import { NewGroupDialog } from "./NewGroupDialog";
import { SkillDrawer } from "./SkillDrawer";
import { SkillsDigestToggle, SkillsDigestPanel } from "./SkillsDigest";
import { RunsTab } from "./RunsTab";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import type { GhProjectRef as GhProject } from "@/shared/lib/github/types";
import "./skills.css";

type Mode = "library" | "lessons" | "runs";

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
  const railSections = useRailSections();                                  // collapsible sidebar sections (#2803)
  // Drag-resizable left rail (#2816), same pattern as the graph rails (GraphCanvas railResizable).
  const railDrag = useDragResize({ initial: 200, min: 180, max: 420, axis: "x" });
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

  // Real telemetry, merged over the library. `statsLoaded` flips true on the first poll return so the
  // telemetry surfaces (Runs, the digest leaderboard) show a loading skeleton rather than a cold
  // "nothing yet" empty state before the log has been read once (#2245).
  const [stats, setStats] = useState<Record<string, SkillStats>>({});
  const [statsLoaded, setStatsLoaded] = useState(false);
  usePoll(async (isCancelled) => {
    const lines = await logsTail("skill", 4000);
    if (!isCancelled()) { setStats(aggregateSkillTelemetry(parseSkillLog((lines ?? []).join("\n")), new Date())); setStatsLoaded(true); }
  }, 5000);

  const merged = useMemo<SkillDef[]>(() => mergeSkillStats(skills, stats), [skills, stats]);

  // group membership index: skillId -> the groups it's in
  const groupsBySkill = useMemo(() => indexGroupsBySkill(skillGroups), [skillGroups]);

  const kpis = useMemo(() => deriveSkillKpis(merged), [merged]);

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
        // Unified layout (#2813): the search + collapsible facets live in the LEFT RAIL; a slim header
        // sits OVER THE LIST (digest stats + sort/density/Select) — no full-width top header.
        <Row align="stretch" className="skills-main" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            {/* Left rail — DRAG-RESIZABLE (#2816), the same pattern GraphCanvas uses (railResizable): a
                sized wrapper + a `.resize-x` splitter. GraphRail fills the wrapper (its default flex:1). */}
            <Box style={{ flex: `0 0 ${railDrag.size}px`, width: railDrag.size, minWidth: 0, display: "flex", overflow: "hidden" }}>
            {/* #3854: no `tools` — search moved to the list HEADER. `query` is still read here for the
                clear-all-filters footer below. (A `//` comment here is JSX TEXT, not a comment — it
                rendered above the rail, #4179.) */}
            <GraphRail
              bodyPad="12px 10px 20px"
              footer={(activeFacetCount > 0 || query || groupFilter) ? (
                <Box style={{ borderTop: "1px solid var(--border-soft)", padding: "10px 12px" }}>
                  <Box as="button" onClick={clearFilters} style={{ fontSize: 11, color: "var(--fg-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>clear all filters</Box>
                </Box>
              ) : undefined}
            >
              {/* Groups — the task-group selector (single-select), collapsible (#2813: the ＋New group
                  action was removed; groups are still created from the grouped-density empty-state hint). */}
              <RailSection
                label="⬡ Groups"
                open={railSections.isOpen("groups")}
                onToggle={() => railSections.toggle("groups")}
              >
                {/* "All" / clear row */}
                <RailRow active={!groupFilter} onClick={() => setGroupFilter(null)}
                  leading={<Box as="span" style={{ width: 13, textAlign: "center", color: !groupFilter ? "var(--accent)" : "var(--fg-dim)" }}>≡</Box>}
                  trailing={<Text as="span" mono size={10} tone="dim">{merged.length}</Text>}>
                  All
                </RailRow>
                {skillGroups.map((g) => { const active = groupFilter === g.id; return (
                  <RailRow key={g.id} data-group-id={g.id} active={active}
                    onClick={() => setGroupFilter((v) => (v === g.id ? null : g.id))}
                    leading={<Box as="span" style={{ width: 13, textAlign: "center", color: g.hue }}>⬡</Box>}
                    trailing={<>
                      {active && <Text as="span" tone="danger" size={11} title="Delete group" onClick={(e: React.MouseEvent) => { e.stopPropagation(); if (confirm("Delete this group? Skills are not deleted.")) { removeSkillGroup(g.id); setGroupFilter(null); } }} style={{ cursor: "pointer" }}>✕</Text>}
                      <Text as="span" mono size={10} tone="dim">{groupSkillCount(g, skills)}</Text>
                    </>}>
                    {g.name}
                  </RailRow>
                ); })}
                {skillGroups.length === 0 && <Text as="div" size={10.5} tone="dim" style={{ padding: "2px 0", lineHeight: 1.4 }}>No groups yet — bundle related skills into a group.</Text>}
              </RailSection>
              {facetDefs.map((f) => (
                <RailSection key={f.key} label={f.title} count={f.options.length}
                  open={railSections.isOpen(f.key)} onToggle={() => railSections.toggle(f.key)}>
                  {f.options.map((o) => { const on = facetSel[f.key]?.has(o.value) ?? false; return (
                    <RailRow key={o.value} aria-pressed={on} onClick={() => toggleFacet(f.key, o.value)}
                      leading={<>
                        <Toggle on={on} size="xs" />
                        {o.glyph && <Box as="span" style={{ fontFamily: "var(--mono)", fontSize: 11, color: o.color, width: 13, textAlign: "center", marginLeft: 6 }}>{o.glyph}</Box>}
                      </>}
                      trailing={<Text as="span" mono size={10} tone="dim">{o.count}</Text>}>
                      <Box as="span" style={{ textTransform: "capitalize" }}>{o.label}</Box>
                    </RailRow>
                  ); })}
                </RailSection>
              ))}
            </GraphRail>
            </Box>
            <Box className="resize-x" {...railDrag.handleProps} title="Drag to resize" />

            {/* Main column: the header OVER THE LIST (digest stats + controls), then the list (#2813).
                A query container so the header can drop the digest first when this column narrows. */}
            <Stack className="skills-listcol" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
              {/* Header like the graph toolbar (#2816): 52px, elevated bg, soft border. */}
              <Row className="skills-listhead" gap={16} align="center" style={{ height: 52, flex: "none", padding: "0 16px", background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)" }}>
                {/* #3854: the header LEADS with search — the control users reach for. It replaced an
                    always-on KPI digest (skills/enabled/pinned/today/avg-success), which did not earn the
                    primary slot; the digest PANEL is still one click away via the toggle on the right. */}
                <SearchField
                  value={query} onChange={setQuery}
                  placeholder="Search name, description, tools…" aria-label="Search skills"
                  style={{ flex: "0 1 320px", minWidth: 0 }}
                />
                <Box as="span" style={{ flex: 1 }} />
                {/* Controls — always kept. */}
                <SkillsDigestToggle digestOpen={digestOpen} onToggle={() => setDigestOpen((v) => !v)} />
                <Text as="span" mono size={11} tone="muted" style={{ flex: "none" }}>{filtered.length} <Text as="span" tone="dim">of {kpis.total}</Text></Text>
                <Row gap={6} style={{ position: "relative", flex: "none" }}>
                  <Text as="span" mono size={10} tone="dim" style={{ textTransform: "uppercase" }}>Sort</Text>
                  <Button onClick={() => setSortOpen((v) => !v)} style={{ padding: "0 10px", background: "var(--bg-canvas)", border: "1px solid var(--border)", fontSize: 11.5, color: "var(--fg)" }}>{sort} <Text as="span" tone="dim" size={9}>▾</Text></Button>
                  {sortOpen && (
                    <Box pad={4} bg="var(--bg-elev)" border radius="md" style={{ position: "absolute", top: 34, right: 0, zIndex: 40, minWidth: 184, boxShadow: "0 14px 36px rgba(0,0,0,.45)"}}>
                      {SORTS.map((o) => <Row key={o} onClick={() => { setSort(o); setSortOpen(false); }} gap={8} style={{ padding: "6px 9px", borderRadius: 4, fontSize: 11.5, cursor: "pointer", color: sort === o ? "var(--fg)" : "var(--fg-muted)", background: sort === o ? "var(--bg-elev2)" : "transparent" }}><Box as="span" style={{ flex: 1 }}>{o}</Box><Text as="span" tone="accent">{sort === o ? "✓" : ""}</Text></Row>)}
                    </Box>
                  )}
                </Row>
                <Row align="stretch" style={{ height: 28, border: "1px solid var(--border)", borderRadius: "var(--r-md)", overflow: "hidden", flex: "none" }}>
                  {([["list", "☰ List"], ["cards", "▦ Cards"], ["grouped", "⬡ Group"], ["kind", "⊟ Kind"]] as const).map(([d, lbl], i) => (
                    <Row key={d} onClick={() => setDensity(d)} style={{ padding: "0 11px", fontSize: 11, cursor: "pointer", background: density === d ? "var(--bg-elev2)" : "transparent", color: density === d ? "var(--fg)" : "var(--fg-dim)", borderRight: i < 3 ? "1px solid var(--border)" : "none" }}>{lbl}</Row>
                  ))}
                </Row>
                <Button onClick={() => (selectMode ? exitSelect() : setSelectMode(true))} style={{ fontSize: 11.5, flex: "none", border: "1px solid " + (selectMode ? "var(--accent-dim)" : "var(--border)"), background: selectMode ? tintBg("var(--accent)", 86) : "var(--bg-canvas)", color: selectMode ? "var(--accent)" : "var(--fg)" }}>{selectMode ? "✓ Selecting" : "☑ Select"}</Button>
              </Row>
              {/* The expandable "Fleet digest" panel drops below the header when open (#2813). */}
              {digestOpen && <SkillsDigestPanel merged={merged} kpis={kpis} statsLoaded={statsLoaded} />}
              {/* The list */}
              <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", paddingBottom: 60 }}>
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
                  <Button danger onClick={bulkDelete}>Delete</Button>
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
            </Stack>
          </Row>
      )}

      {mode === "lessons" && (
        <LessonsTab projectKey={lessonProjectKey} projectName={activeProjectName ?? undefined} />
      )}

      {mode === "runs" && (
        <RunsTab merged={merged} stats={stats} statsLoaded={statsLoaded} onOpen={(id) => { select("library"); drawer.select(id); }} />
      )}

    </Screen>
  );
}

// Re-exported feature surface — this index is the skills feature's public API barrel (#1309).
export { SkillsGraphHost } from "./SkillsGraphHost"; // the graph-hosted workspace (#3654)
export { SkillsStatus } from "./SkillsStatus";
export { SessionSkillsModal, type SessionSkillsModalProps } from "./SessionSkillsModal";

// #1545: public API for cross-feature consumers (planner, app/console).
export {
  type SkillDef, skillFromPayload, resolveSkills, effectiveSessionSkills,
  expandGroups, toSkillCfgs,
} from "./lib/skills";
export { loadPendingLessons, lessonTitle, type Lesson } from "./lib/lessons";
