// Blueprint Author — 4 · REVIEW & PUBLISH. A hero + stat summary, a flow strip,
// the authoring lint (`authoringChecks`), a visibility picker, and the publish
// action. `authoringChecks` is exported for the Review-stage gate + tests.

import { Ic } from "@/features/planner/blueprints/blueprintIcons";
import { hue, tint, stageKind } from "@/features/planner/blueprints/blueprintCatalog";
import { Button } from "@/shared/ui/controls/Button";
import { StatTile } from "@/shared/ui/data/StatTile";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { Blueprint } from "@/features/planner/stages/blueprints";
import { gateCount, Lbl, type AuthorViewProps } from "./shared";

interface PublishCheck { id: string; label: string; ok: boolean; detail: string }

export function authoringChecks(bp: Blueprint): PublishCheck[] {
  const stages = bp.sections ?? [];
  const tags = bp.tags ?? [];
  const emptyPrompts = stages.filter((s) => !s.prompt?.trim()).length;
  return [
    { id: "name", label: "Name & pitch set", ok: !!bp.name?.trim() && !!bp.pitch?.trim(), detail: bp.name?.trim() && bp.pitch?.trim() ? "ok" : "missing" },
    { id: "tags", label: "At least one catalog tag", ok: tags.length > 0, detail: `${tags.length} tag${tags.length === 1 ? "" : "s"}` },
    { id: "count", label: "Two or more stages", ok: stages.length >= 2, detail: `${stages.length} stage${stages.length === 1 ? "" : "s"}` },
    { id: "prompts", label: "Every stage has a prompt module", ok: stages.length > 0 && emptyPrompts === 0, detail: `${emptyPrompts} empty` },
  ];
}

const VIS: { key: NonNullable<Blueprint["visibility"]>; glyph: string; title: string; desc: string }[] = [
  { key: "local", glyph: "folder", title: "Local only", desc: "Stays in your library." },
  { key: "private-gist", glyph: "lock", title: "Private gist", desc: "Shareable by link." },
  { key: "catalog", glyph: "public", title: "Public gist", desc: "Discoverable by everyone." },
];

export function PublishView({ bp, onChange, onPublish, published }: AuthorViewProps) {
  const stages = bp.sections ?? [];
  const h = bp.h ?? 195;
  const checks = authoringChecks(bp);
  const passed = checks.filter((c) => c.ok).length;
  const allPass = passed === checks.length;
  const vis = bp.visibility ?? "private-gist";
  const totalSkills = new Set(stages.flatMap((s) => s.skills ?? [])).size;
  const totalMcp = new Set(stages.flatMap((s) => s.mcp ?? [])).size;

  return (
    <Stack gap={16}>
      <Box className="hero" style={{ marginBottom: 0 }}>
        <Box as="span" className="hicon" bg={tint(h, 0.16)} style={{ color: hue(h) }}>{bp.icon || (bp.name?.[0] ?? "B").toUpperCase()}</Box>
        <Box className="htxt">
          <Text as="div" className="heyebrow">blueprint</Text>
          <Box className="mono" style={{ fontSize: 14, color: "var(--fg)", marginBottom: 3 }}>{bp.name || "Untitled blueprint"}</Box>
          <Text as="div" className="hbody">{bp.pitch || "—"}</Text>
        </Box>
      </Box>

      <Box className="stats" style={{ gridTemplateColumns: "repeat(4,1fr)", margin: 0 }}>
        <StatTile k="stages" v={stages.length} />
        <StatTile k="skills" v={totalSkills} />
        <StatTile k="MCP" v={totalMcp} />
        <StatTile k="checks" v={`${passed}/${checks.length}`} tone={allPass ? "success" : undefined} />
      </Box>

      <Box>
        <Lbl>Flow</Lbl>
        <Box className="seq" style={{ gap: 5 }}>
          {stages.map((s, i) => {
            const k = stageKind(s.key);
            return (
              <Box as="span" key={s.uid} style={{ display: "contents" }}>
                {i > 0 && <Text as="span" className="arr">→</Text>}
                <Box as="span" className={"st-g" + (gateCount(s) ? " gated" : "")} title={s.name} style={{ width: 24, height: 24 }}><Ic n={k.glyph} size={13} /></Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      <Box>
        <Lbl hint="lint · must pass to publish">Validation</Lbl>
        <Stack gap={5}>
          {checks.map((c) => (
            <Box key={c.id} className={"diff-line " + (c.ok ? "add" : "del")} style={{ marginBottom: 0 }}>
              <Text as="span" className="dmark">{c.ok ? "✓" : "✕"}</Text>
              <Text as="span" className="dtitle">{c.label}</Text>
              <Box as="span" style={{ flex: 1 }} />
              <Text as="span" size={10} className="dim">{c.detail}</Text>
            </Box>
          ))}
        </Stack>
      </Box>

      <Box>
        <Lbl>Visibility</Lbl>
        <Box className="disp-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
          {VIS.map((v) => (
            <Box key={v.key} className={"disp" + (vis === v.key ? " on" : "")} style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}
              onClick={() => onChange({ ...bp, visibility: v.key })}>
              <Box as="span" className="dgl" bg={vis === v.key ? tint(h, 0.18) : "var(--bg-elev)"} style={{ color: vis === v.key ? hue(h) : "var(--fg-muted)" }}><Ic n={v.glyph} size={13} /></Box>
              <Box as="span" className="dtxt"><Text as="div" className="dt">{v.title}</Text><Text as="div" className="dd">{v.desc}</Text></Box>
            </Box>
          ))}
        </Box>
      </Box>

      <Button variant="primary" disabled={!allPass || published} onClick={onPublish}
        style={{ height: 38, justifyContent: "center", fontSize: 12 }}>
        {published ? "✓ Published"
          : allPass ? <Box as="span" style={{ display: "flex", alignItems: "center", gap: 7 }}><Ic n="upload" size={14} /> {vis === "local" ? "Save to library" : "Publish blueprint"}</Box>
          : `Resolve ${checks.length - passed} check${checks.length - passed > 1 ? "s" : ""} to publish`}
      </Button>
    </Stack>
  );
}
