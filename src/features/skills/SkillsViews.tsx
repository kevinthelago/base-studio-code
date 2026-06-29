// Skills library view-mode renderers (#1706). Extracted from SkillsWorkspace.tsx: the shared skill
// row (List + Grouped), the card, and the three density views — List, Cards, Grouped/Kind. Pure
// presentation driven by props; SkillsWorkspace owns the state + handlers and the surrounding chrome.

import { KIND, PROFILE_COLOR, SOURCE_TAG, fmtCount, type SkillProfile } from "@/shared/data/skills";
import { Spark } from "@/shared/ui/charts";
import { Toggle } from "@/shared/ui/Toggle";
import { Checkbox } from "@/shared/ui/Checkbox";
import { DataTableRow, DataTableHeader } from "@/shared/ui/DataTableRow";
import type { SkillDef, SkillGroup } from "./lib/skills";
import type { GroupedSection } from "./lib/skillsFilter";
import { glyphTile, hueTile, pill, tintBg, sourcePill, scopePill, successColor } from "./skillStyles";

/** List/grouped row grid template; a leading checkbox column appears in select mode. */
const colTemplate = (sel: boolean) => (sel ? "26px " : "") + "24px minmax(190px,1fr) 90px minmax(120px,170px) 96px 150px 26px 40px";

/** Handlers + view state every skill row needs (shared by List + Grouped). */
export interface SkillRowHandlers {
  selectMode: boolean;
  selected: Set<string>;
  groupsBySkill: Map<string, SkillGroup[]>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onTogglePin: (id: string) => void;
  onToggle: (id: string) => void;
}

/** One library row (List density + the indented rows under each Grouped/Kind section). */
export function SkillRow({ s, i, h }: { s: SkillDef; i: number; h: SkillRowHandlers }) {
  const { selectMode, selected, groupsBySkill, onSelect, onOpen, onTogglePin, onToggle } = h;
  const isSel = selected.has(s.id);
  const groups = groupsBySkill.get(s.id);
  return (
    <DataTableRow
      className="skill-row"
      attrs={{ "data-skill-id": s.id }}
      template={colTemplate(selectMode)}
      index={i}
      off={!s.enabled}
      onClick={() => (selectMode ? onSelect(s.id) : onOpen(s.id))}
    >
      {selectMode && <Checkbox checked={isSel} />}
      <span style={glyphTile(s.kind)}>{KIND[s.kind].glyph}</span>
      <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name || "Untitled skill"}</span>
        {(groups?.length ?? 0) > 0 && <span title={groups!.map((g) => g.name).join(", ")} style={{ color: "var(--fg-dim)", fontSize: 10 }}>⬡{groups!.length > 1 ? groups!.length : ""}</span>}
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
      <span className="pin-btn" onClick={(e) => { e.stopPropagation(); onTogglePin(s.id); }} style={{ textAlign: "center", fontSize: 12, color: s.pinned ? "var(--accent)" : "var(--fg-dim)", cursor: "pointer" }}>★</span>
      <span style={{ display: "flex", justifyContent: "center" }}><Toggle size="sm" on={s.enabled} onClick={(e) => { e.stopPropagation(); onToggle(s.id); }} /></span>
    </DataTableRow>
  );
}

/** List density: a sticky column header + one {@link SkillRow} per filtered skill. */
export function SkillsListView({ filtered, h }: { filtered: SkillDef[]; h: SkillRowHandlers }) {
  return (
    <div>
      <DataTableHeader template={colTemplate(h.selectMode)}>
        {h.selectMode && <span />}<span /><span>Skill</span><span>Source</span><span>Tools</span><span>Scope</span><span style={{ textAlign: "right" }}>Usage</span><span style={{ textAlign: "center" }}>Pin</span><span style={{ textAlign: "center" }}>On</span>
      </DataTableHeader>
      {filtered.map((s, i) => <SkillRow key={s.id} s={s} i={i} h={h} />)}
    </div>
  );
}

/** Cards density: a two-column grid of {@link SkillCard}. */
export function SkillsCardsView({ filtered, groupsBySkill, onOpen, onPin, onToggle }: {
  filtered: SkillDef[];
  groupsBySkill: Map<string, SkillGroup[]>;
  onOpen: (id: string) => void;
  onPin: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, padding: "14px 18px" }}>
      {filtered.map((s) => <SkillCard key={s.id} s={s} groups={groupsBySkill.get(s.id) ?? []} onOpen={() => onOpen(s.id)} onPin={() => onPin(s.id)} onToggle={() => onToggle(s.id)} />)}
    </div>
  );
}

/** Grouped / Kind density: a hint when there are no task groups, then one section per group/kind. */
export function SkillsGroupedView({ sections, showNoGroupsHint, onNewGroup, h }: {
  sections: GroupedSection[];
  showNoGroupsHint: boolean;
  onNewGroup: () => void;
  h: SkillRowHandlers;
}) {
  return (
    <div style={{ padding: "12px 18px 0" }}>
      {showNoGroupsHint && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 12px", padding: "9px 13px", background: tintBg("var(--fg-dim)", 90), border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", fontSize: 11.5, color: "var(--fg-muted)" }}>
          <span style={{ color: "var(--fg-dim)" }}>⬡</span>
          <span>No task groups yet — every skill falls under <b style={{ color: "var(--fg)" }}>Ungrouped</b>. Create a group to bundle related skills.</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onNewGroup}>＋ New group</button>
        </div>
      )}
      {sections.map((sec, si) => (
        <div key={sec.id} className="skill-section" data-section-id={sec.id}
          style={{ marginBottom: 14, border: `1px solid ${tintBg(sec.hue, 78)}`, borderRadius: "var(--r-lg)", overflow: "hidden", background: "var(--bg-panel)" }}>
          {/* Section header — sticky; its own hue tile + a left accent rail ties the rows below to it.
              Later sections sit above earlier ones as they scroll under (descending z, opaque bg). */}
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 16px", position: "sticky", top: 0, zIndex: sections.length - si + 4, background: `color-mix(in oklch, ${sec.hue} 8%, var(--bg-elev))`, borderBottom: `1px solid ${tintBg(sec.hue, 74)}`, boxShadow: `inset 3px 0 0 ${sec.hue}` }}>
            <span style={hueTile(sec.hue)}>{sec.glyph}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)", textTransform: "capitalize" }}>{sec.label}</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: sec.hue, background: tintBg(sec.hue, 84), borderRadius: 99, padding: "1px 7px" }}>{sec.items.length}</span>
          </div>
          {/* Member rows, indented under the header so they clearly belong to this section. */}
          <div style={{ paddingLeft: 10, borderLeft: `2px solid ${tintBg(sec.hue, 70)}` }}>
            {sec.items.map((s, i) => <SkillRow key={s.id} s={s} i={i} h={h} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A single skill card (Cards density). */
export function SkillCard({ s, groups, onOpen, onPin, onToggle }: { s: SkillDef; groups: SkillGroup[]; onOpen: () => void; onPin: () => void; onToggle: () => void }) {
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
            <Toggle size="sm" on={s.enabled} onClick={(e) => { e.stopPropagation(); onToggle(); }} />
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
        <div style={{ display: "flex", gap: 5 }}>{s.profiles.map((p: SkillProfile) => <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: PROFILE_COLOR[p] }} /><span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{p}</span></span>)}</div>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: s.invocations ? "var(--fg-muted)" : "var(--fg-dim)" }}>{s.invocations ? fmtCount(s.invocations) + "×" : "never"}</span>
        {s.invocations > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: sc }}>{s.success}%</span>}
        {s.trend.length > 1 && <Spark data={s.trend} color={s.invocations ? KIND[s.kind].color : "var(--fg-dim)"} />}
      </div>
    </div>
  );
}
