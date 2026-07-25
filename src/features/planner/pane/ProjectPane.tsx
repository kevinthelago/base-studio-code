// ProjectPane — planning-page right visualizer pane.
// v5: stage-focused one-at-a-time view (#652) with real data (#674).
// Ported from design/project-pane-v4/recommended; now wraps in a 7-stage stepper
// so the planning workflow is one focused stage at a time.
import { useState } from "react";
import { Pane } from "@/shared/ui/overlay/Pane";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import "./projectPane.css";
import type { Flow, ContextFile, ProjectPaneData, McpServer } from "./projectPaneData";
import { type ModelId } from "@/app/console/lib/models";
import { hasStageGuidance, type Stage, type GatePill, type FooterKind } from "../stages/focusedPlan";
import {
  Stepper as FocusedStepper,
  StageHeader as FocusedStageHeader,
  StageGuidanceCard as FocusedStageGuidance,
  LockBanner as FocusedLockBanner,
  StageFooter as FocusedStageFooter,
} from "./FocusedShell";
import type { StagePrompt } from "../session/plannerConductor";
import type { DeployConfig } from "../lib/deployConfig";
import { type Topology } from "../relationship/relationshipGraph";
import { type DirectorDrive } from "../fleet/directorDrive";
import { FocusedStageBody } from "./FocusedBodies";
import { KindDot } from "./focusedPrimitives";
export function ProjectPane({
  data,
  projectId,
  onFlow,
  onModel,
  onPersona,
  // focused mode: one-stage sequenced rail (#652) — the only render mode (#1061)
  focus,
  onLinkRepo,
  onTopology,
  onDirectorDrive,
  onToggleMcp,
  onBuildMcp,
  onAddMcp,
  onRemoveMcp,
  onDeployChange,
  onInject,
}: {
  data?: ProjectPaneData;
  projectId?: string;
  onFlow?: (streamId: string, flow: Flow) => void;
  /** Permissions stage: set a stream's per-agent LLM model (undefined ⇒ global default) (#…). */
  onModel?: (streamId: string, model: ModelId | undefined) => void;
  onPersona?: (streamId: string, personaId: string | undefined) => void;
  /** The sequenced-rail focused mode (#652) — the sole render path (#1061 removed the legacy
   *  staged/flat view + its hardcoded PLAN_STAGES gate). */
  focus?: {
    stages: Stage[];
    selectedIdx: number;
    activeIdx: number;
    onSelect: (i: number) => void;
    pill: GatePill;
    footer: { kind: FooterKind; enabled: boolean; canSkip?: boolean; skipEnabled?: boolean };
    onBack: () => void;
    onPrimary: () => void;
    /** Skip the active stage (#921/#2854) — rendered only when `footer.skipEnabled` (the stage is
     *  skippable now, or gate-override is on); a required stage shows no Skip. */
    onSkip?: () => void;
    /** The project already has a GitHub board — the publish action reads as "Update GitHub" (#823). */
    published?: boolean;
    /** Override the footer publish label (#3280) — e.g. "Commit plan" when publishing offline. */
    publishLabel?: string;
    /** The selected stage's injectable prompts + inject handler — drives the header "?" helper (#…),
     *  replacing the removed auto-injecting conductor. */
    promptHelp?: { prompt: StagePrompt; onInject: (text: string) => void };
    /** The project's live required-context topics (#1061) — the Context body lists each by name
     *  with written/missing state so the user sees exactly which files the gate still needs. */
    requiredContext?: string[];
  };
  /** Callback to link a repository from the focused repos body (#677). */
  onLinkRepo?: (repo: string) => void;
  /** Set the project's coordination topology (#…) — director / peer / hybrid. */
  onTopology?: (t: Topology) => void;
  /** Set the director's drive mode (#…) — event / heartbeat / manual / off. */
  onDirectorDrive?: (d: DirectorDrive) => void;
  /** MCP stage (#878): toggle a server's fleet grant, download+build it, add a new one
   *  (catalog name / command / URL), or remove it. */
  onToggleMcp?: (id: string) => void;
  onBuildMcp?: (s: McpServer) => void;
  onAddMcp?: (input: string) => void;
  onRemoveMcp?: (id: string) => void;
  /** Deploy stage (#919): persist the edited deployment config. */
  onDeployChange?: (next: DeployConfig) => void;
  /** Inject a prompt into the live planner terminal (#1986) — threaded to the Source body so the
   *  "+ Add a source" affordance nudges the planner to author the connector. Same seam as the
   *  per-stage "?" prompt helper (`sendPrompt` in Planning.tsx). */
  onInject?: (text: string) => void;
}) {
  // Context file viewer modal — its scrim (ModalScrim) owns Escape + backdrop dismiss.
  const [viewing, setViewing] = useState<ContextFile | null>(null);
  // The stage-guidance disclosure (#3257) — the gate detail + Inject button are HIDDEN by default and
  // revealed by clicking the gate pill. Stored as WHICH stage's gate is open, so navigating to another
  // stage auto-collapses (derived, no reset effect); `null` ⇒ none open.
  const [openGateIdx, setOpenGateIdx] = useState<number | null>(null);

  // The context-file viewer modal — shared by BOTH the focused and full-pane renders so
  // clicking an md file opens it in either (the focused pane previously had no viewer, #…).
  const viewerModal = viewing && (
    <ModalScrim onDismiss={() => setViewing(null)} style={{ padding: 24 }}>
      <Stack style={{
        width: "min(720px, 92vw)", maxHeight: "84vh",
        background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
        borderRadius: 10, boxShadow: "0 16px 50px rgba(0,0,0,.45)", overflow: "hidden",
      }}>
        <Row gap={8} style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)",
        }}>
          <KindDot kind={viewing.kind} />
          <Text as="span" mono size={12} style={{ flex: 1, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{viewing.name}</Text>
          <Text as="span" mono size={9.5} tone="dim">{viewing.tok} · {viewing.scope}</Text>
          <Text as="span" mono onClick={() => setViewing(null)} size={13} tone="muted" style={{ cursor: "pointer", padding: "0 2px 0 8px" }}>✕</Text>
        </Row>
        <pre className="mono" style={{
          margin: 0, padding: "14px 16px", overflow: "auto", flex: 1,
          fontSize: 11, lineHeight: 1.55, color: "var(--fg-muted)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{viewing.content || "(empty)"}</pre>
      </Stack>
    </ModalScrim>
  );

  // Focused mode: sequenced-rail one-stage view (#652)
  if (focus) {
    const selected = focus.stages[focus.selectedIdx];
    const active   = focus.stages[focus.activeIdx];
    const isLocked = focus.selectedIdx > focus.activeIdx;
    // The gate pill toggles the guidance card ONLY when there's guidance to reveal (#3257); otherwise it
    // stays a plain status chip. Open iff THIS stage is the open one (auto-collapses on stage change).
    const canToggleGate = hasStageGuidance(selected, focus.pill, focus.promptHelp?.prompt, focus.promptHelp?.onInject);
    const gateOpen = openGateIdx === focus.selectedIdx;
    return (
      <Pane mode="inline" bare className="pp fp">
        <FocusedStepper stages={focus.stages} selectedIdx={focus.selectedIdx} onSelect={focus.onSelect} />
        <FocusedStageHeader stage={selected} pill={focus.pill} open={gateOpen} onToggleGate={canToggleGate ? () => setOpenGateIdx(gateOpen ? null : focus.selectedIdx) : undefined} />
        {isLocked && <FocusedLockBanner activeName={active?.name ?? ""} />}
        <FocusedStageGuidance stage={selected} pill={focus.pill} prompt={focus.promptHelp?.prompt} onInject={focus.promptHelp?.onInject} open={gateOpen} />
        <Box className="pp-scroll">
          <FocusedStageBody stage={selected} data={data} projectId={projectId} onLinkRepo={onLinkRepo} onView={setViewing}
            onFlow={onFlow} onModel={onModel} onPersona={onPersona} onTopology={onTopology} onDirectorDrive={onDirectorDrive}
            onToggleMcp={onToggleMcp} onBuildMcp={onBuildMcp} onAddMcp={onAddMcp} onRemoveMcp={onRemoveMcp} onDeployChange={onDeployChange} requiredContext={focus.requiredContext} onInject={onInject} />
        </Box>
        <FocusedStageFooter stage={selected} action={focus.footer} published={focus.published} publishLabel={focus.publishLabel} onBack={focus.onBack} onPrimary={focus.onPrimary} onSkip={focus.onSkip} />
        {viewerModal}
      </Pane>
    );
  }

  return null;
}
