// Blueprint preview types + the shared stage-summary view (#609 slice 5) — ported from the design's
// gist.jsx. The `PreviewBlueprint` shape drives resolve/import across the gist client (gist.ts); the
// `StageSummary` render is reused by the plan stage bar (#3802: the paste-URL `ImportModal` was
// removed with the gist-import modals — the not-yet-downloaded gists now live in the persistent
// `CloudBlueprints` column on the ProjectSetupPage).

import "../../../styles/blueprints.css";
import { Chip } from "@/shared/ui/data/Chip";
import { Ic } from "./blueprintIcons";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { stageKind, tint, hue } from "./blueprintCatalog";
import { type Blueprint, type BlueprintStage } from "../stages/blueprints";
import { type SkillPayload } from "./blueprintSkills";

/** A resolved import/preview blueprint (subset enough to preview + import). */
export interface PreviewBlueprint {
  name: string; icon: string; h: number; author?: string; rev?: string; sections: BlueprintStage[];
  /** The upstream gist id this preview came from (#955) — recorded on import so a re-import is
   *  recognized (dedupe → update in place) and the import page can show its sync state. */
  gistId?: string;
  /** The fully-coerced blueprint (#897) — carried so import preserves blueprint-wide
   *  skills/mcp/category/mode instead of reconstructing from the lossy preview subset. */
  blueprint?: Blueprint;
  /** Skill content embedded in the share (#897 Phase 5b) — reconstituted into the library on import. */
  bundled?: SkillPayload[];
}

export function StageSummary({ sections }: { sections: BlueprintStage[] }) {
  return (
    <Stack gap={4}>
      {sections.map((s, i) => {
        const k = stageKind(s.key);
        const caps = (s.skills?.length ?? 0) + (s.mcp?.length ?? 0);
        return (
          <Stack key={s.uid ?? i} gap={4} style={{ padding: "5px 0" }}>
            <Row gap={9}>
              <Box as="span" className="mono dim" style={{ fontSize: 9.5, width: 16 }}>{String(i + 1).padStart(2, "0")}</Box>
              <IconBox size={22} radius={5} background={tint(k.h, 0.16)} color={hue(k.h)}><Ic n={k.glyph} size={13} /></IconBox>
              <Text as="span" size={11.5} className="mono" style={{ color: "var(--fg)" }}>{s.name}</Text>
              <Box as="span" style={{ flex: 1 }} />
              {caps > 0 && <Text as="span" className="hint mono">{caps} attached</Text>}
              {s.gateRule && <Chip tone="accent">gate</Chip>}
            </Row>
            {/* The prompt is the substance of the stage (#1268) — dense text under the row, the
                icon as its index. pre-wrap keeps the prompt's own line breaks. */}
            {s.prompt?.trim() && (
              <Box className="mono" style={{ marginLeft: 25, fontSize: 10, lineHeight: 1.5, color: "var(--fg-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {s.prompt.trim()}
              </Box>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
