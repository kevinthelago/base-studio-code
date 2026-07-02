// Skills library view-mode renderers (#1706). Extracted from SkillsWorkspace.tsx: the shared skill
// row (List + Grouped), the card, and the three density views — List, Cards, Grouped/Kind. Pure
// presentation driven by props; SkillsWorkspace owns the state + handlers and the surrounding chrome.

import { KIND, PROFILE_COLOR, SOURCE_TAG, fmtCount, type SkillProfile } from "@/shared/data/skills";
import { Spark } from "@/shared/ui/charts";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { Button } from "@/shared/ui/controls/Button";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";
import { DataTableRow, DataTableHeader } from "@/shared/ui/data/DataTableRow";
import { Card } from "@/shared/ui/data/Card";
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
      <Box as="span" style={glyphTile(s.kind)}>{KIND[s.kind].glyph}</Box>
      <Row gap={7} style={{ minWidth: 0 }}>
        <Text as="span" mono size={12} style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name || "Untitled skill"}</Text>
        {(groups?.length ?? 0) > 0 && <Text as="span" tone="dim" size={10} title={groups!.map((g) => g.name).join(", ")}>⬡{groups!.length > 1 ? groups!.length : ""}</Text>}
      </Row>
      <Box as="span"><Box as="span" style={sourcePill(s.source)}>{SOURCE_TAG[s.source].label}</Box></Box>
      <Row gap={4} style={{ overflow: "hidden" }}>
        {s.tools.slice(0, 2).map((t) => <Text key={t} as="span" className="kbd" size={10}>{t}</Text>)}
        {s.tools.length > 2 && <Text as="span" mono size={10} tone="dim">+{s.tools.length - 2}</Text>}
      </Row>
      <Box as="span"><Box as="span" style={scopePill(s.projects)}>{s.projects.length ? s.projects[0] + (s.projects.length > 1 ? " +" + (s.projects.length - 1) : "") : "global"}</Box></Box>
      <Row justify="end" gap={7}>
        <Text as="span" mono size={10.5} style={{ color: s.invocations ? "var(--fg-muted)" : "var(--fg-dim)", width: 38, textAlign: "right" }}>{s.invocations ? fmtCount(s.invocations) + "×" : "—"}</Text>
        {s.trend.length > 1 ? <Spark data={s.trend} color={s.invocations ? KIND[s.kind].color : "var(--fg-dim)"} /> : <Box as="span" style={{ width: 46 }} />}
      </Row>
      <Box as="span" className="pin-btn" onClick={(e) => { e.stopPropagation(); onTogglePin(s.id); }} style={{ textAlign: "center", fontSize: 12, color: s.pinned ? "var(--accent)" : "var(--fg-dim)", cursor: "pointer" }}>★</Box>
      <Row justify="center"><Toggle size="sm" on={s.enabled} onClick={(e) => { e.stopPropagation(); onToggle(s.id); }} /></Row>
    </DataTableRow>
  );
}

/** List density: a sticky column header + one {@link SkillRow} per filtered skill. */
export function SkillsListView({ filtered, h }: { filtered: SkillDef[]; h: SkillRowHandlers }) {
  return (
    <Box>
      <DataTableHeader template={colTemplate(h.selectMode)}>
        {h.selectMode && <Box as="span" />}<Box as="span" /><Box as="span">Skill</Box><Box as="span">Source</Box><Box as="span">Tools</Box><Box as="span">Scope</Box><Box as="span" style={{ textAlign: "right" }}>Usage</Box><Box as="span" style={{ textAlign: "center" }}>Pin</Box><Box as="span" style={{ textAlign: "center" }}>On</Box>
      </DataTableHeader>
      {filtered.map((s, i) => <SkillRow key={s.id} s={s} i={i} h={h} />)}
    </Box>
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
    <Grid cols={2} gap={12} style={{ padding: "14px 18px" }}>
      {filtered.map((s) => <SkillCard key={s.id} s={s} groups={groupsBySkill.get(s.id) ?? []} onOpen={() => onOpen(s.id)} onPin={() => onPin(s.id)} onToggle={() => onToggle(s.id)} />)}
    </Grid>
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
    <Box style={{ padding: "12px 18px 0" }}>
      {showNoGroupsHint && (
        <Row gap={10} style={{ margin: "0 0 12px", padding: "9px 13px", background: tintBg("var(--fg-dim)", 90), border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", fontSize: 11.5, color: "var(--fg-muted)" }}>
          <Text as="span" tone="dim">⬡</Text>
          <Box as="span">No task groups yet — every skill falls under <b style={{ color: "var(--fg)" }}>Ungrouped</b>. Create a group to bundle related skills.</Box>
          <Box as="span" style={{ flex: 1 }} />
          <Button onClick={onNewGroup}>＋ New group</Button>
        </Row>
      )}
      {sections.map((sec, si) => (
        <Box key={sec.id} className="skill-section" data-section-id={sec.id}
          bg="var(--bg-panel)" radius="lg" style={{ marginBottom: 14, border: `1px solid ${tintBg(sec.hue, 78)}`, overflow: "hidden"}}>
          {/* Section header — sticky; its own hue tile + a left accent rail ties the rows below to it.
              Later sections sit above earlier ones as they scroll under (descending z, opaque bg). */}
          <Row gap={9} style={{ padding: "10px 16px", position: "sticky", top: 0, zIndex: sections.length - si + 4, background: `color-mix(in oklch, ${sec.hue} 8%, var(--bg-elev))`, borderBottom: `1px solid ${tintBg(sec.hue, 74)}`, boxShadow: `inset 3px 0 0 ${sec.hue}` }}>
            <Box as="span" style={hueTile(sec.hue)}>{sec.glyph}</Box>
            <Text as="span" size={12} weight={600} style={{ color: "var(--fg)", textTransform: "capitalize" }}>{sec.label}</Text>
            <Box as="span" className="mono" pad={[1, 7]} bg={tintBg(sec.hue, 84)} radius={99} style={{ fontSize: 10, color: sec.hue}}>{sec.items.length}</Box>
          </Row>
          {/* Member rows, indented under the header so they clearly belong to this section. */}
          <Box style={{ paddingLeft: 10, borderLeft: `2px solid ${tintBg(sec.hue, 70)}` }}>
            {sec.items.map((s, i) => <SkillRow key={s.id} s={s} i={i} h={h} />)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** A single skill card (Cards density). */
export function SkillCard({ s, groups, onOpen, onPin, onToggle }: { s: SkillDef; groups: SkillGroup[]; onOpen: () => void; onPin: () => void; onToggle: () => void }) {
  const sc = successColor(s.invocations > 0 ? s.success : null);
  return (
    <Card className="skill-card" interactive onClick={onOpen} style={{ opacity: s.enabled ? 1 : 0.6 }}>
      <Row align="start" gap={11}>
        <Box as="span" style={glyphTile(s.kind, true)}>{KIND[s.kind].glyph}</Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Row gap={8}>
            <Text as="span" mono size={13} weight={500} style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name || "Untitled"}</Text>
            <Box as="span" style={{ flex: 1 }} />
            <Text as="span" size={13} onClick={(e: React.MouseEvent) => { e.stopPropagation(); onPin(); }} style={{ color: s.pinned ? "var(--accent)" : "var(--fg-dim)", cursor: "pointer" }}>★</Text>
            <Toggle size="sm" on={s.enabled} onClick={(e) => { e.stopPropagation(); onToggle(); }} />
          </Row>
          <Text as="div" size={11.5} tone="muted" style={{ marginTop: 3, lineHeight: 1.45, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{s.desc || "No description yet."}</Text>
        </Box>
      </Row>
      {groups.length > 0 && <Row align="stretch" gap={6} wrap style={{ marginTop: 9 }}>{groups.map((g) => <Box as="span" key={g.id} style={{ ...pill(g.hue), display: "inline-flex", alignItems: "center", gap: 4 }}>⬡ {g.name}</Box>)}</Row>}
      <Row gap={6} wrap style={{ marginTop: 11 }}>
        <Box as="span" style={sourcePill(s.source)}>{SOURCE_TAG[s.source].label}</Box>
        <Box as="span" style={scopePill(s.projects)}>{s.projects.length ? s.projects[0] : "global"}</Box>
        <Box as="span" style={{ flex: 1 }} />
        {s.tools.slice(0, 3).map((t) => <Text key={t} as="span" className="kbd" size={10}>{t}</Text>)}
      </Row>
      <Row gap={10} style={{ marginTop: 11, paddingTop: 10, borderTop: "1px solid var(--border-soft)" }}>
        <Row align="stretch" gap={5}>{s.profiles.map((p: SkillProfile) => <Row key={p} inline gap={4}><Box as="span" bg={PROFILE_COLOR[p]} style={{ width: 6, height: 6, borderRadius: "50%"}} /><Text as="span" mono size={9.5} tone="dim">{p}</Text></Row>)}</Row>
        <Box as="span" style={{ flex: 1 }} />
        <Text as="span" mono size={10.5} style={{ color: s.invocations ? "var(--fg-muted)" : "var(--fg-dim)" }}>{s.invocations ? fmtCount(s.invocations) + "×" : "never"}</Text>
        {s.invocations > 0 && <Text as="span" mono size={10} style={{ color: sc }}>{s.success}%</Text>}
        {s.trend.length > 1 && <Spark data={s.trend} color={s.invocations ? KIND[s.kind].color : "var(--fg-dim)"} />}
      </Row>
    </Card>
  );
}
