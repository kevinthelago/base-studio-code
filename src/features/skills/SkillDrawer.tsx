// SkillDrawer — the skill editor drawer (a Pane) for the Skills library. Edits are live: every
// field patches the draft/skill in place. Rendered as the Screen overlay when a skill is selected.
import { Pane } from "@/shared/ui/overlay/Pane";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { TextField } from "@/shared/ui/controls/Field";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import {
  KIND, PROFILE_COLOR,
  type SkillKind, type SkillSource, type SkillProfile,
} from "@/shared/data/skills";
import { skillSlug, type SkillDef, type SkillGroup } from "./lib/skills";
import { glyphTile, pill } from "./skillStyles";
import type { GhProjectRef as GhProject } from "@/shared/lib/github/types";

const KIND_KEYS = Object.keys(KIND) as SkillKind[];
const PROFILE_KEYS = Object.keys(PROFILE_COLOR) as SkillProfile[];
const SOURCE_KEYS: SkillSource[] = ["first-party", "team", "imported", "community"];

export function SkillDrawer({ s, isDraft, projects, groups, onPatch, onClose, onCommit, onDelete, onToggleGroup }: {
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
