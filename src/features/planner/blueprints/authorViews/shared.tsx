// Shared helpers for the Blueprint Author phase views (#923). The four views
// (Purpose/Stages/Capabilities/Publish) each edit the in-progress blueprint and
// emit the whole thing via `onChange`; these are the props contract + the small
// presentational helpers reused across them.

import type { CSSProperties } from "react";
import { Ic } from "@/features/planner/blueprints/blueprintIcons";
import { hue, tint, stageKind } from "@/features/planner/blueprints/blueprintCatalog";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { Blueprint, BlueprintStage } from "@/features/planner/stages/blueprints";
import type { BlueprintSkillItem } from "@/features/planner/blueprints/blueprintSkills";
import type { McpLibraryItem } from "@/features/planner/blueprints/blueprintMcp";

export const gateCount = (s: BlueprintStage) => (s.gateRule ? 1 : 0);

export interface AuthorViewProps {
  bp: Blueprint;
  onChange: (bp: Blueprint) => void;
  /** Pickable skill/knowledge + MCP libraries (Capabilities stage). */
  skillLibrary?: BlueprintSkillItem[];
  mcpLibrary?: McpLibraryItem[];
  /** Selected stage in the Stages editor. */
  selectedUid?: string | null;
  onSelectStage?: (uid: string | null) => void;
  /** Publish the authored blueprint (Review stage); visibility comes from `bp.visibility`. */
  onPublish?: () => void;
  published?: boolean;
}

export function Lbl({ children, hint, style }: { children: React.ReactNode; hint?: string; style?: CSSProperties }) {
  return <Box className="lbl" style={style}>{children}<Box as="span" className="ln" />{hint && <Text as="span" className="lhint">{hint}</Text>}</Box>;
}

export function StageGlyph({ k, size = 26 }: { k: string; size?: number }) {
  const meta = stageKind(k);
  return (
    <Box as="span" bg={tint(meta.h, 0.16)} radius={6} style={{ width: size, height: size, flex: `0 0 ${size}px`,
      display: "flex", alignItems: "center", justifyContent: "center", color: hue(meta.h) }}>
      <Ic n={meta.glyph} size={size * 0.56} />
    </Box>
  );
}
