// Publish-progress view for the plan panel, split out of Planning.tsx (decomposition pass).
//
// Rendered inside the plan-sections aside once publishing starts (publishPhase !== "idle"): a status
// header (publishing / published / failed) with a "back to plan" escape once terminal, over the live
// GitHubStructureCard whose nodes update as each object is created. Pure presentation — the aside's
// measured layout stays in Planning.tsx; this is only its non-idle content.
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { GitHubStructureCard, type GhStatusMap } from "./GitHubStructureCard";
import type { GhStructure } from "../github/ghStructure";
import type { PublishPhase } from "./usePlanPublish";

export interface PublishProgressViewProps {
  publishPhase: PublishPhase;
  onBackToPlan: () => void;
  structure: GhStructure;
  status: GhStatusMap;
}

export function PublishProgressView({ publishPhase, onBackToPlan, structure, status }: PublishProgressViewProps) {
  return (
    <>
      {/* Publish progress header */}
      <Row className="mono" gap={8} style={{
        padding: "10px 18px", borderBottom: "1px solid var(--border-soft)",
        fontSize: 11,
      }}>
        <Text as="span" style={{
          color: publishPhase === "done"  ? "var(--success)"
               : publishPhase === "error" ? "var(--danger)"
               : "var(--accent)",
        }}>
          {publishPhase === "running" ? "⟳ publishing…"
           : publishPhase === "done"  ? "✓ published"
           : "✗ publish failed"}
        </Text>
        <Spacer />
        {(publishPhase === "done" || publishPhase === "error") && (
          // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled 'back to plan' button (mono, custom inline styling, not the .btn kit)
          <button
            className="mono"
            onClick={onBackToPlan}
            style={{
              padding: "2px 8px", borderRadius: 3, cursor: "pointer",
              background: "transparent", border: "1px solid var(--border-soft)",
              color: "var(--fg-dim)", fontSize: 10,
            }}
          >← back to plan</button>
        )}
      </Row>

      {/* Live GitHub structure — each node updates as it is created */}
      <Stack gap={10} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 18px" }}>
        <GitHubStructureCard structure={structure} status={status} />
      </Stack>
    </>
  );
}
