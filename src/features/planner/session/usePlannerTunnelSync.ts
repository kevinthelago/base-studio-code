// usePlannerTunnelSync (#1775, extracted from Planning.tsx) — the mobile-relay (#801/#934/#987)
// projection of the live planning session. Owns the canonical-plan derivation, the message poll,
// and every tunnel emit/listen effect, all of which no-op unless the relay is live:
//   • canonicalPlan — the project's plan files + stable id, routed to their canonical relpaths.
//   • (1) file-sync — push the plan files so a paired mobile planner reconciles over the relay (E2E).
//   • (2) PTY mirror — expose the planner pane so a paired phone can view/drive the terminal.
//   • (1b) plan_state — debounced snapshot; plan_status — cheap, un-debounced header update.
//   • plan_event — transient confirmed-section / stage-advanced / message-appended deltas (the refs
//     diff prev vs current at the transition sites).
//   • inbound DRIVE — confirm a section / advance a stage / chat into the PTY from the phone (gated
//     Rust-side behind the input grant; a view-only phone can't steer).
// Behavior-preserving move out of the component; NO logic change.
import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store";
import { hubToCanonical } from "@/features/planner/lib/plannerSync";
import {
  tunnelSetPlanState, tunnelEmitPlanState, tunnelEmitPlanStatus, tunnelEmitPlanEvent,
  publishTunnelDomain, recordTunnelAlerts, gateReadyAlert, plannerWaitingAlert,
} from "@/features/tunnel";
import { usePlannerMessages } from "./usePlannerMessages";
import { SKIPPED_KEY, FEATURES_KEY } from "../stages/planTopics";
import { FLEET_KEY } from "../fleet/planFleet";
import { DEPENDENCIES_KEY } from "../issues/dependencies";
import { buildPlanBoardPayload } from "./planBoardProjection";
import type { Stage } from "../stages/focusedPlan";

export interface PlannerTunnelSyncOpts {
  effectiveProjectId: string;
  /** The per-project section bucket — the canonical plan is derived from it. */
  savedSections: Record<string, string>;
  confirmedSet: Set<string>;
  /** The active stage key (from usePlanGates) — emitted in plan_state/status/events. */
  currentStage: string;
  planStatusLabel: string;
  /** The planner hub dir (from usePlannerTerminal) — gates the PTY mirror. */
  planningDir: string;
  paneId: string;
  projectTitle: string;
  confirmPlanStage: (projectId: string, key: string) => void;
  /** The focused-pane stage board (from usePlanGates, #2498) — published as the `plan`
   *  store_state domain the mobile Planner page renders. */
  stages: Stage[];
  /** The active stage's gate passed (awaiting the user-only confirm). */
  focusGateReady: boolean;
  planComplete: boolean;
}

export function usePlannerTunnelSync(opts: PlannerTunnelSyncOpts) {
  const {
    effectiveProjectId, savedSections, confirmedSet, currentStage, planStatusLabel,
    planningDir, paneId, projectTitle, confirmPlanStage,
    stages, focusGateReady, planComplete,
  } = opts;
  const tunnelRunning = useAppStore((s) => s.tunnelRunning);

  // The active project's canonical plan (files + the stable proj-<hex> id). Route the JSON
  // manifests to their canonical relpaths; everything else is a `.md` section. commands.json/
  // features.json are outside the canonical-sync contract (isPlanFile), so they're excluded.
  // Shared by the file-sync path (1) and the live-frame emit (1b).
  const canonicalPlan = useMemo(() => {
    if (Object.keys(savedSections).length === 0) return null;
    const md: Record<string, string> = {};
    let phasesJson, issuesJson, fleetJson, reposJson, skippedContent: string | undefined;
    for (const [k, v] of Object.entries(savedSections)) {
      if (k === "phases") phasesJson = v;
      else if (k === "issues") issuesJson = v;
      else if (k === FLEET_KEY) fleetJson = v;
      // Legacy `repos` SECTION-CONTENT key (not the stage key, #1914) — the mobile canonical-sync
      // contract still routes a `reposJson` relpath via hubToCanonical, so keep reading it if present.
      else if (k === "repos") reposJson = v;
      else if (k === SKIPPED_KEY) skippedContent = v;
      else if (k === FEATURES_KEY || k === DEPENDENCIES_KEY) continue;
      else md[k] = v;
    }
    return hubToCanonical({
      projectTitle: effectiveProjectId,
      sections: md,
      confirmedSections: [...confirmedSet],
      phasesJson, issuesJson, fleetJson, reposJson, skippedContent,
    });
  }, [savedSections, confirmedSet, effectiveProjectId]);

  // The planner is a PTY running `claude`, so the structured conversation lives in Claude's
  // transcript — poll it (newest 50 turns) while paired so the phone renders the real chat,
  // not the raw terminal. pipelineRuns stays empty: the planner runs no pipelines (#220).
  const plannerMessages = usePlannerMessages(tunnelRunning, paneId);

  // (1) Plan-sync — push the canonical plan files so a paired mobile planner reconciles over
  // the relay (E2E) instead of the API. Unchanged async file-sync path.
  useEffect(() => {
    if (!tunnelRunning || !canonicalPlan) return;
    tunnelSetPlanState(canonicalPlan.meta.projectId, canonicalPlan.files).catch(() => {});
  }, [tunnelRunning, canonicalPlan]);

  // (2) PTY mirror — register the planner pane in the session roster (keyed source, #2497)
  // so a paired phone can view (and, if granted, drive) the live planner terminal.
  // Unregistered when the planner unmounts or the relay stops.
  useEffect(() => {
    const register = useAppStore.getState().registerTunnelPanes;
    if (!tunnelRunning || !planningDir) { register("planner", []); return; }
    register("planner", [{
      id: paneId, cwd: planningDir, name: `Planner — ${projectTitle}`,
      status: "running" as const, kind: "planner" as const,
    }]);
    return () => useAppStore.getState().registerTunnelPanes("planner", []);
  }, [tunnelRunning, planningDir, paneId, projectTitle]);

  // (1b) plan_state — debounced snapshot (replayed to newly-paired clients Rust-side).
  useEffect(() => {
    if (!tunnelRunning || !canonicalPlan) return;
    const id = setTimeout(() => {
      tunnelEmitPlanState(canonicalPlan.meta.projectId, currentStage, [...confirmedSet], canonicalPlan.files, plannerMessages, []).catch(() => {});
    }, 500);
    return () => clearTimeout(id);
  }, [tunnelRunning, canonicalPlan, currentStage, confirmedSet, plannerMessages]);

  // plan_status — cheap header update, un-debounced on stage/status change.
  useEffect(() => {
    if (!tunnelRunning || !canonicalPlan) return;
    tunnelEmitPlanStatus(canonicalPlan.meta.projectId, currentStage, planStatusLabel).catch(() => {});
  }, [tunnelRunning, canonicalPlan, currentStage, planStatusLabel]);

  // plan_event — transient deltas at the transition sites (refs diff prev vs current).
  const prevConfirmedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (tunnelRunning && canonicalPlan) {
      for (const k of confirmedSet) {
        if (!prevConfirmedRef.current.has(k)) {
          tunnelEmitPlanEvent(canonicalPlan.meta.projectId, { kind: "section_confirmed", at: Date.now(), section: k }).catch(() => {});
        }
      }
    }
    prevConfirmedRef.current = new Set(confirmedSet);
  }, [confirmedSet, tunnelRunning, canonicalPlan]);

  const prevStageRef = useRef("");
  useEffect(() => {
    if (tunnelRunning && canonicalPlan && currentStage && currentStage !== prevStageRef.current) {
      tunnelEmitPlanEvent(canonicalPlan.meta.projectId, { kind: "stage_advanced", at: Date.now(), stage: currentStage }).catch(() => {});
    }
    prevStageRef.current = currentStage;
  }, [currentStage, tunnelRunning, canonicalPlan]);

  const prevMsgCountRef = useRef(0);
  useEffect(() => {
    if (tunnelRunning && canonicalPlan && plannerMessages.length > prevMsgCountRef.current) {
      const last = plannerMessages[plannerMessages.length - 1];
      tunnelEmitPlanEvent(canonicalPlan.meta.projectId, { kind: "message_appended", at: last.at || Date.now(), message: last }).catch(() => {});
    }
    prevMsgCountRef.current = plannerMessages.length;
  }, [plannerMessages, tunnelRunning, canonicalPlan]);

  // (1c) The `plan` store_state domain (#2498): the stage/gate board the mobile Planner page
  // renders — the same `stagesFrom` output the desktop stepper shows, plus fleet streams and
  // the deploy/market gate summaries. COMPLEMENTS plan_state (files + transcript, above); the
  // shared domain publisher debounces, dedups unchanged payloads, and stamps the rev.
  const planFleet = useAppStore((s) => s.planFleet);
  const planSkippedStages = useAppStore((s) => s.planSkippedStages);
  const planDeployConfig = useAppStore((s) => s.planDeployConfig);
  const planMarketConfig = useAppStore((s) => s.planMarketConfig);
  useEffect(() => {
    if (!tunnelRunning || !effectiveProjectId) return;
    publishTunnelDomain("plan", buildPlanBoardPayload({
      projectId: effectiveProjectId,
      title: projectTitle,
      currentStage,
      statusLabel: planStatusLabel,
      gateReady: focusGateReady,
      planComplete,
      stages,
      confirmed: confirmedSet,
      skipped: planSkippedStages[effectiveProjectId] ?? [],
      fleet: planFleet[effectiveProjectId],
      deploy: planDeployConfig[effectiveProjectId],
      market: planMarketConfig[effectiveProjectId],
    }));
  }, [
    tunnelRunning, effectiveProjectId, projectTitle, currentStage, planStatusLabel,
    focusGateReady, planComplete, stages, confirmedSet,
    planSkippedStages, planFleet, planDeployConfig, planMarketConfig,
  ]);

  // gate-ready alert (#2498): the active stage's gate JUST passed — only the USER can confirm,
  // so this is exactly the "come back and advance the plan" moment. Fires only on an OBSERVED
  // not-ready→ready transition per stage: the first run just primes the ref, so remounting the
  // planner over an already-passed gate never re-alerts (each alert mints a fresh id).
  const prevGateRef = useRef<{ stage: string; ready: boolean } | null>(null);
  useEffect(() => {
    const prev = prevGateRef.current;
    if (prev && tunnelRunning && focusGateReady && currentStage &&
        !(prev.ready && prev.stage === currentStage)) {
      recordTunnelAlerts([gateReadyAlert(effectiveProjectId, currentStage, Date.now())]);
    }
    prevGateRef.current = { stage: currentStage, ready: focusGateReady };
  }, [tunnelRunning, focusGateReady, currentStage, effectiveProjectId]);

  // planner-waiting alert (#2498): the planner's newest transcript turn is an ASSISTANT turn —
  // it finished and is waiting on the user. The poll re-delivers the same transcript every few
  // seconds, so the turn key ref (its `at`, falling back to the text) guards re-derivation and
  // the alert hub's id dedup backstops it — one alert per turn.
  const lastPlannerTurnRef = useRef("");
  useEffect(() => {
    if (!tunnelRunning || plannerMessages.length === 0) return;
    const last = plannerMessages[plannerMessages.length - 1];
    if (last.role !== "assistant") return;
    const turnKey = last.at ? String(last.at) : last.text;
    if (turnKey === lastPlannerTurnRef.current) return;
    lastPlannerTurnRef.current = turnKey;
    recordTunnelAlerts([plannerWaitingAlert(effectiveProjectId, paneId, last.text, last.at || Date.now())]);
  }, [tunnelRunning, plannerMessages, effectiveProjectId, paneId]);

  // Inbound DRIVE from the phone (#934): confirm a section, advance a stage, or chat into the
  // planner PTY. Gated Rust-side behind the input grant (a view-only phone can't steer).
  useEffect(() => {
    const subs = [
      listen<{ section: string }>("tunnel://plan-confirm", (e) => confirmPlanStage(effectiveProjectId, e.payload.section)),
      listen<{ stageKey: string }>("tunnel://plan-advance", (e) => confirmPlanStage(effectiveProjectId, e.payload.stageKey)),
      listen<{ text: string }>("tunnel://plan-chat", (e) => { void invoke("pty_write", { paneId, data: e.payload.text + "\r" }); }),
    ];
    return () => { for (const s of subs) void s.then((off) => off()); };
  }, [effectiveProjectId, paneId, confirmPlanStage]);
}
