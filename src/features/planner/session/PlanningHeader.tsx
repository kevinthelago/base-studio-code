// Planning page header, split out of Planning.tsx (decomposition pass).
//
// Pure presentation: the back button, the editable project title (published vs draft variants),
// the drafting/expanding chip, the auto-planning progress line, and the restart / clear /
// switch-blueprint / triage action buttons. No hooks, refs, or effects — every value and callback
// is supplied by Planning.tsx, so extracting it does not change the parent's hook-call order.
import { BackButton } from "@/shared/ui/controls/BackButton";
import { Button } from "@/shared/ui/controls/Button";
import { Chip } from "@/shared/ui/data/Chip";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { canLaunchTriage, triageLockReason } from "@/shared/lib/github/projectSync";
import { clamp } from "@/shared/lib/core/math";

export interface PlanningHeaderProps {
  isExisting: boolean;
  activeProjectNumber: number | string;
  activeProjectName: string;
  onBack: () => void;
  // Published-title editing (#1226).
  titleEdit: string | null;
  setTitleEdit: (v: string | null) => void;
  renameErr: string | null;
  setRenameErr: (v: string | null) => void;
  commitRename: () => void;
  // Draft-title editing (#1222).
  planningTitle: string;
  setPlanningTitle: (v: string) => void;
  draftTitleErr: string | null;
  setDraftTitleErr: (v: string | null) => void;
  commitDraftTitle: () => void;
  // Auto-planning badge (#746).
  autopilotRunning: boolean;
  autopilotProgressPct: number;
  // Actions.
  handleRestart: () => void;
  restarting: boolean;
  onClearPlan: () => void;
  canSwitch: boolean;
  onSwitchBlueprint: () => void;
  // Triage launch gate (#444/#551).
  isAuthoring: boolean;
  published: boolean;
  hasRepos: boolean;
  hasFleet: boolean;
  triaging: boolean;
  planReady: boolean;
  launchTriage: () => void;
}

export function PlanningHeader({
  isExisting, activeProjectNumber, activeProjectName, onBack,
  titleEdit, setTitleEdit, renameErr, setRenameErr, commitRename,
  planningTitle, setPlanningTitle, draftTitleErr, setDraftTitleErr, commitDraftTitle,
  autopilotRunning, autopilotProgressPct,
  handleRestart, restarting, onClearPlan, canSwitch, onSwitchBlueprint,
  isAuthoring, published, hasRepos, hasFleet, triaging, planReady, launchTriage,
}: PlanningHeaderProps) {
  return (
    <Box style={{ padding: "14px 24px 14px 12px", display: "flex", alignItems: "flex-start", gap: 14 }}>
      <Box style={{ flex: 1 }}>
        <Row gap={10}>
          <BackButton variant="icon" onClick={onBack} aria-label="Back to Planner" />
          {isExisting
            ? (
              <>
                <Text as="span" mono size={10} tone="dim">#{activeProjectNumber}</Text>
                {/* Published title is editable (#1226): blur/Enter commits to the GitHub board + local name. */}
                {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline editable title (borderless, width-to-text, no .field wrapper); TextField would change layout */}
                <input
                  value={titleEdit ?? activeProjectName}
                  onChange={e => { setTitleEdit(e.target.value); if (renameErr) setRenameErr(null); }}
                  onBlur={commitRename}
                  onKeyDown={e => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    else if (e.key === "Escape") { setTitleEdit(null); setRenameErr(null); }
                  }}
                  title={renameErr ?? activeProjectName}
                  aria-label="Project title"
                  className="mono"
                  style={{
                    background: "none", border: "none", outline: "none", padding: 0,
                    margin: 0, fontSize: 16, fontWeight: 600,
                    color: renameErr ? "var(--danger)" : "var(--fg)",
                    // Size to the text, capped — a long name stops at the cap instead of pushing
                    // the status pill away; minWidth:0 lets it shrink in a narrow pane.
                    maxWidth: 282, minWidth: 0,
                    width: clamp(((titleEdit ?? activeProjectName).length || 14) * 9.5 + 16, 56, 282),
                  }}
                />
              </>
            )
            : (
              // eslint-disable-next-line no-restricted-syntax -- bespoke inline editable title (borderless, width-to-text, no .field wrapper); TextField would change layout
              <input
                value={planningTitle}
                onChange={e => { setPlanningTitle(e.target.value); if (draftTitleErr) setDraftTitleErr(null); }}
                onBlur={commitDraftTitle}
                onKeyDown={e => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  else if (e.key === "Escape") (e.target as HTMLInputElement).blur();
                }}
                placeholder="project title…"
                title={draftTitleErr ?? undefined}
                className="mono"
                style={{
                  background: "none", border: "none", outline: "none",
                  fontSize: 16, fontWeight: 600,
                  color: draftTitleErr ? "var(--danger)" : planningTitle ? "var(--fg)" : "var(--fg-dim)",
                  // Size to the text (snug), with a usable floor and a 400px cap so the status
                  // pill sits right next to the title.
                  width: clamp((planningTitle.length || 14) * 9.5 + 16, 56, 282),
                  padding: 0,
                }}
              />
            )
          }
          <Chip tone="accent">● {isExisting ? "expanding" : "drafting"}</Chip>
        </Row>
        {autopilotRunning && (
          <Text as="div" size={12} tone="accent" style={{ marginTop: 4 }}>
            ⚙ auto-planning · {autopilotProgressPct}%
          </Text>
        )}
      </Box>
      <Button variant="ghost" onClick={handleRestart} disabled={restarting}
        title="Restart the planner session (re-spawns Claude)">
        {restarting ? "restarting…" : "↺ restart"}
      </Button>
      <Button variant="ghost" danger onClick={onClearPlan} title="Wipe this project's plan and restart the planner (#664)">
        clear plan
      </Button>
      {/* Switch the project to a different blueprint (#923 / #1281 — any → any other). */}
      {canSwitch && (
        <Button variant="ghost" onClick={onSwitchBlueprint} title="Switch this project to a different blueprint">
          switch blueprint
        </Button>
      )}
      {/* No execution side for an authoring blueprint (#923) — its deliverable is the published
          blueprint gist, so there are no repos to triage / no fleet to launch. */}
      {!isAuthoring && (() => {
        // Full gate (#444/#551): plan complete + published + repos + fleet, not starting.
        const gate = {
          published,
          hasRepos,
          hasFleet,
          busy: triaging,
          planReady,
        };
        return (
          <Button
            variant="primary"
            onClick={launchTriage}
            disabled={!canLaunchTriage(gate)}
            title={triageLockReason(gate) ?? "Clone the repos and start a triage session"}
          >
            {triaging ? "starting triage…" : "Triage →"}
          </Button>
        );
      })()}
    </Box>
  );
}
