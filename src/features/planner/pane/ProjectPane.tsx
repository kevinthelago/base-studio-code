// ProjectPane — planning-page right visualizer pane.
// v5: stage-focused one-at-a-time view (#652) with real data (#674).
// Ported from design/project-pane-v4/recommended; now wraps in a 7-stage stepper
// so the planning workflow is one focused stage at a time.
import { useState, useEffect } from "react";
import { Pane } from "@/shared/ui/overlay/Pane";
import "./projectPane.css";
import type { Flow, ContextFile, ProjectPaneData, McpServer } from "./projectPaneData";
import { type ModelId } from "@/app/console/lib/models";
import type { Stage, GatePill, FooterKind } from "../stages/focusedPlan";
import {
  Stepper as FocusedStepper,
  StageHeader as FocusedStageHeader,
  LockBanner as FocusedLockBanner,
  StageFooter as FocusedStageFooter,
} from "./FocusedShell";
import type { StagePrompt } from "../session/plannerConductor";
import type { DeployConfig } from "../lib/deployConfig";
import { type Topology } from "../relationship/relationshipGraph";
import { type DirectorDrive } from "../fleet/directorDrive";
import { FocusedStageBody, type AuthoringWiring } from "./FocusedBodies";
import { KindDot } from "./focusedPrimitives";
export function ProjectPane({
  data,
  projectId,
  onFlow,
  onModel,
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
}: {
  data?: ProjectPaneData;
  projectId?: string;
  onFlow?: (streamId: string, flow: Flow) => void;
  /** Permissions stage: set a stream's per-agent LLM model (undefined ⇒ global default) (#…). */
  onModel?: (streamId: string, model: ModelId | undefined) => void;
  /** The sequenced-rail focused mode (#652) — the sole render path (#1061 removed the legacy
   *  staged/flat view + its hardcoded PLAN_STAGES gate). */
  focus?: {
    stages: Stage[];
    selectedIdx: number;
    activeIdx: number;
    onSelect: (i: number) => void;
    pill: GatePill;
    footer: { kind: FooterKind; enabled: boolean; canSkip?: boolean };
    onBack: () => void;
    onPrimary: () => void;
    /** Skip the active OPTIONAL stage (#921) — rendered when `footer.canSkip`. */
    onSkip?: () => void;
    /** The project already has a GitHub board — the publish action reads as "Update GitHub" (#823). */
    published?: boolean;
    /** Override the footer publish label (#923) — "Publish blueprint" for an authoring project. */
    publishLabel?: string;
    /** Blueprint-authoring wiring (#923) — present only for an authoring project; drives the
     *  interactive Purpose/Stages/Capabilities/Review editor views. */
    authoring?: AuthoringWiring;
    /** The selected stage's injectable prompts + inject handler — drives the header "?" helper (#…),
     *  replacing the removed auto-injecting conductor. */
    promptHelp?: { prompts: StagePrompt[]; onInject: (text: string) => void };
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
}) {
  // Context file viewer modal
  const [viewing, setViewing] = useState<ContextFile | null>(null);
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setViewing(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  // The context-file viewer modal — shared by BOTH the focused and full-pane renders so
  // clicking an md file opens it in either (the focused pane previously had no viewer, #…).
  const viewerModal = viewing && (
    <div className="modal-scrim" onClick={() => setViewing(null)} style={{ padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(720px, 92vw)", maxHeight: "84vh", display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
        borderRadius: 10, boxShadow: "0 16px 50px rgba(0,0,0,.45)", overflow: "hidden",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "12px 14px",
          borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)",
        }}>
          <KindDot kind={viewing.kind} />
          <span className="mono" style={{ flex: 1, fontSize: 12, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{viewing.name}</span>
          <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{viewing.tok} · {viewing.scope}</span>
          <span className="mono" onClick={() => setViewing(null)} style={{ cursor: "pointer", fontSize: 13, color: "var(--fg-muted)", padding: "0 2px 0 8px" }}>✕</span>
        </div>
        <pre className="mono" style={{
          margin: 0, padding: "14px 16px", overflow: "auto", flex: 1,
          fontSize: 11, lineHeight: 1.55, color: "var(--fg-muted)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{viewing.content || "(empty)"}</pre>
      </div>
    </div>
  );

  // Focused mode: sequenced-rail one-stage view (#652)
  if (focus) {
    const selected = focus.stages[focus.selectedIdx];
    const active   = focus.stages[focus.activeIdx];
    const isLocked = focus.selectedIdx > focus.activeIdx;
    return (
      <Pane mode="inline" bare className="pp fp">
        <FocusedStepper stages={focus.stages} selectedIdx={focus.selectedIdx} onSelect={focus.onSelect} />
        <FocusedStageHeader stage={selected} pill={focus.pill} promptHelp={focus.promptHelp} />
        {isLocked && <FocusedLockBanner activeName={active?.name ?? ""} />}
        <div className="pp-scroll">
          <FocusedStageBody stage={selected} data={data} projectId={projectId} authoring={focus.authoring} onLinkRepo={onLinkRepo} onView={setViewing}
            onFlow={onFlow} onModel={onModel} onTopology={onTopology} onDirectorDrive={onDirectorDrive}
            onToggleMcp={onToggleMcp} onBuildMcp={onBuildMcp} onAddMcp={onAddMcp} onRemoveMcp={onRemoveMcp} onDeployChange={onDeployChange} requiredContext={focus.requiredContext} />
        </div>
        <FocusedStageFooter stage={selected} action={focus.footer} published={focus.published} publishLabel={focus.publishLabel} onBack={focus.onBack} onPrimary={focus.onPrimary} onSkip={focus.onSkip} />
        {viewerModal}
      </Pane>
    );
  }

  return null;
}
