// Planning page notices strip, split out of Planning.tsx (decomposition pass).
//
// Pure presentation: the triage error/skip notices, the feature-dependency-cycle warning, and the
// "recover from GitHub" banner shown when the plan store is empty but the board has published
// issues. No hooks/refs/effects — Planning.tsx supplies every value + callback.
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Banner } from "@/shared/ui/feedback/Banner";

export interface PlanningNoticesProps {
  triageError: string | null;
  triageNote: string | null;
  featureCycle: string[];
  recoverable: number;
  recovering: boolean;
  onRecover: () => void;
  publishRepos: string[];
}

export function PlanningNotices({
  triageError, triageNote, featureCycle, recoverable, recovering, onRecover, publishRepos,
}: PlanningNoticesProps) {
  return (
    <>
      {triageError && (
        <Banner variant="inline" tone="danger" loud style={{ margin: "0 24px 8px" }}>
          ⚠ {triageError}
        </Banner>
      )}
      {triageNote && !triageError && (
        <Banner variant="inline" tone="neutral" style={{ margin: "0 24px 8px" }}>
          ⏭ {triageNote}
        </Banner>
      )}
      {featureCycle.length > 0 && (
        <Banner variant="inline" tone="danger" loud style={{ margin: "0 24px 8px" }}>
          ⚠ Feature dependency cycle: {featureCycle.join(" → ")} — break it to complete the Features stage.
        </Banner>
      )}
      {recoverable > 0 && (
        <Row className="mono" gap={10} style={{ padding: "0 24px 8px", fontSize: 12, color: "var(--fg-muted)" }}>
          <Box as="span">⤓ The plan store is empty — GitHub has {recoverable} published issue{recoverable === 1 ? "" : "s"} for {publishRepos.length === 1 ? "this repo" : "these repos"}.</Box>
          {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled recover button (mono, custom inline styling, not the .btn kit) */}
          <button
            className="mono"
            onClick={onRecover}
            disabled={recovering}
            style={{
              padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border-soft)",
              background: "var(--bg-elev2)", color: "var(--fg)", fontSize: 11,
              cursor: recovering ? "default" : "pointer", opacity: recovering ? 0.6 : 1,
            }}
          >
            {recovering ? "Recovering…" : "Recover from GitHub"}
          </button>
        </Row>
      )}
    </>
  );
}
