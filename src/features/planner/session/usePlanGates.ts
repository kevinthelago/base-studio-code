// usePlanGates (#1474) — the planner's gate/`signals` derivation, extracted verbatim from
// Planning.tsx. Owns the live `stageState` snapshot, the lint/injection gates, the skip/confirm
// signal bags, the flat `signals` bag the declarative section gates read, and the focused-pane
// derivations (`phases`, active index, current-gate-ready, plan-complete, status label).
//
// Pure derivation, no side effects. `planSecs` (the blueprint sections) and the focused-pane
// SELECTION state (`focusSel`/`focusSelectedIdx`/`focusSelPhase`) STAY in Planning and are passed
// in / read off this hook's outputs — only the auto-derived `phases`/`focusActiveIdx` move here.
// `isAuthoring`/`authoringSig` come from usePlannerBlueprint, so call this immediately after it.

import { useMemo } from "react";
import type { Section } from "../github/ghStructure";
import type { BlueprintStage } from "../stages/blueprints";
import { skippedSignal, confirmedSignal, planStagesComplete, authoringSignals } from "../stages/blueprints";
import { derivePlanStageState, planStateToSignals } from "../stages/planStageDerive";
import { FEATURES_KEY } from "../stages/planTopics";
import { parseIssuesFile } from "../issues/planIssues";
import { featuresGateComplete, featuresAllPhased, featuresSummary } from "../issues/featureList";
import { findPlanGaps } from "../lib/lintPlan";
import { findPlanInjections, injectionGate } from "../lib/planInjection";
import { deploymentDefined } from "../lib/deployConfig";
import { allSourcesConnected, migrationActive, datamodelSignals } from "../lib/sourceConfig";
import { destinationDefined, syncDefined } from "../lib/integrationConfig";
import { unlockedSharedRepos } from "../issues/dependencies";
import { phasesFrom, activeIndex, currentGateReady } from "../stages/focusedPlan";

interface PlanGatesDeps {
  sections: Section[];
  /** The active blueprint's sections (stays in Planning; passed in as gate input). */
  planSecs: BlueprintStage[];
  ctxRequired: string[];
  publishRepos: string[];
  planFleet: Record<string, { streams: { id: string; repo: string }[] }>;
  planAutomations: Record<string, unknown[]>;
  featureIssues: unknown[];
  effectiveProjectId: string;
  requiresUi: boolean;
  uiCounts: { approved: number; total: number };
  featureState: ReturnType<typeof featuresSummary>;
  featureCycle: string[];
  confirmedSet: Set<string>;
  skippedSet: Set<string>;
  planDependencies: Parameters<typeof unlockedSharedRepos>[0];
  sourceCfg: Parameters<typeof migrationActive>[0];
  injectionHardGate: boolean;
  planInjectionAck: Record<string, string>;
  planFeatures: Parameters<typeof featuresAllPhased>[0];
  deployCfg: Parameters<typeof deploymentDefined>[0];
  intgCfg: Parameters<typeof destinationDefined>[0];
  /** From usePlannerBlueprint. */
  isAuthoring: boolean;
  authoringSig: ReturnType<typeof authoringSignals>;
}

export function usePlanGates(deps: PlanGatesDeps) {
  const {
    sections, planSecs, ctxRequired, publishRepos, planFleet, planAutomations,
    featureIssues, effectiveProjectId, requiresUi, uiCounts, featureState, featureCycle,
    confirmedSet, skippedSet, planDependencies, sourceCfg, injectionHardGate, planInjectionAck,
    planFeatures, deployCfg, intgCfg, isAuthoring, authoringSig,
  } = deps;

  // The live snapshot the declarative section gates read.
  const stageState = useMemo(() => {
    const streams = planFleet[effectiveProjectId]?.streams ?? [];
    const issueCount =
      parseIssuesFile(sections.find(s => s.k === "issues")?.content ?? "").length + featureIssues.length;
    return derivePlanStageState({
      sections: sections.map(s => ({ k: s.k, state: s.state })),
      discoveryRequired: ctxRequired,
      repoCount: publishRepos.length,
      issueCount,
      fleetStreams: streams.length,
      // Unified role→profile model: every stream auto-gets its role's default profile at launch
      // (no per-stream generated profile to assign), so "profiles complete" simply means the fleet
      // has been planned — i.e. there are streams.
      fleetProfilesComplete: streams.length > 0,
      automationsAck: (planAutomations[effectiveProjectId]?.length ?? 0) > 0,
      skillsAck: false,
      requiresUi,
      ui: uiCounts,
      // Routing dropped design files to the project completes the UI stage — recorded as a
      // confirmation of the `ui` section so it persists (#837).
      uiRouted: confirmedSet.has("ui"),
      // Features completes ONLY when every feature is populated AND the user has confirmed the set
      // (#plan-db) — `allConfirmed` (all-defined) alone used to auto-advance after a single feature.
      // Folding the user-confirm in here keeps the gate signal (`featuresConfirmed`) unchanged.
      features: { count: featureState.count, allConfirmed: featuresGateComplete(featureState, confirmedSet.has(FEATURES_KEY)) && featureCycle.length === 0 },
      // Dependencies (#1111/#1127): the Deploy gate passes once ≥1 library is locked in the manifest.
      dependencies: { count: planDependencies.length },
      // Source migration (#1205): the scan drives whether the source stage applies + its gate
      // signals, so the source-inferred schema can dictate features/structure.
      migrationSourceEnabled: migrationActive(sourceCfg),
      datamodelArtifact: datamodelSignals(sourceCfg),
    });
  }, [sections, ctxRequired, publishRepos, planFleet, planAutomations, featureIssues, effectiveProjectId, requiresUi, uiCounts, featureState, featureCycle, confirmedSet, planDependencies, sourceCfg]);
  // lint-as-gate (#897 Phase 4b — lint-plan folded into the declarative gate). A WRITTEN section
  // (drafted/confirmed; pending ones aren't authored yet) must not carry a deliberate "fill this
  // in later" marker (TODO / TBD / FIXME / XXX / TKTK). Scanned ONLY over sections that belong to
  // the ACTIVE blueprint (so stale files from a prior blueprint can't block), and only those
  // markers — NOT ellipsis or the word "placeholder", which are normal prose and were
  // false-positiving (#918). Surfaced as `hasPlanGaps`; the gate requires it false, absent-safe.
  const hasPlanGaps = useMemo(() => {
    const enabled = new Set(planSecs.map((s) => s.key));
    const written: Record<string, string> = {};
    for (const s of sections) if (s.state !== "pending" && enabled.has(s.k)) written[`${s.k}.md`] = s.content ?? "";
    return findPlanGaps(written).some((g) => g.endsWith("unresolved placeholder"));
  }, [sections, planSecs]);
  // Plan-injection provenance gate (#1107): scan the planner-authored section prose for injected
  // instructions, then gate plan→fleet promotion. Acknowledge-to-clear by default; hard-block when
  // the `injectionHardGate` setting is on. Surfaced as a banner; `cleared` gates publish.
  const injectionGateState = useMemo(() => {
    const enabled = new Set(planSecs.map((s) => s.key));
    const written: Record<string, string> = {};
    for (const s of sections) if (s.state !== "pending" && enabled.has(s.k)) written[`${s.k}.md`] = s.content ?? "";
    return injectionGate(findPlanInjections(written), { hardGate: injectionHardGate, ackSig: planInjectionAck[effectiveProjectId] });
  }, [sections, planSecs, injectionHardGate, planInjectionAck, effectiveProjectId]);
  // User-skipped optional stages (#921) surface as `skipped:<key>` signals so the data-driven
  // gate model (`stageDone`) treats them as resolved.
  const skipSignals = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const k of skippedSet) out[skippedSignal(k)] = true;
    return out;
  }, [skippedSet]);
  // A gateless ("informational") section is done only once CONFIRMED (#664) — `stageDone` reads a
  // `confirmed:<key>` signal. Workspace those so a confirmed gateless stage (testing, cleanup, the data
  // stages, a user-authored stage, …) reads as complete and the frontier advances (#954).
  const confirmSignals = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const k of confirmedSet) out[confirmedSignal(k)] = true;
    return out;
  }, [confirmedSet]);
  const signals = useMemo(() => {
    // Shared-deps gate (#1429): every repo built by 2+ streams must have its deps locked; single-owner
    // repos (and no-fleet plans) auto-satisfy. Derived from the fleet streams' repos + the manifest.
    const repoStreams: Record<string, string[]> = {};
    for (const s of (planFleet[effectiveProjectId]?.streams ?? [])) { if (s.repo) (repoStreams[s.repo] ??= []).push(s.id); }
    const sharedDepsLocked = unlockedSharedRepos(planDependencies, repoStreams).length === 0;
    return { ...planStateToSignals(stageState), hasPlanGaps, featuresPhased: featuresAllPhased(planFeatures), deploymentDefined: deploymentDefined(deployCfg), sharedDepsLocked, sourcesConnected: allSourcesConnected(sourceCfg), destinationDefined: destinationDefined(intgCfg), syncDefined: syncDefined(intgCfg), ...(isAuthoring ? authoringSig : {}), ...skipSignals, ...confirmSignals };
  }, [stageState, hasPlanGaps, planFeatures, deployCfg, sourceCfg, intgCfg, isAuthoring, authoringSig, skipSignals, confirmSignals, planFleet, effectiveProjectId, planDependencies]);

  // Focused pane (#652): one phase at a time. `phases` derive from the blueprint sections +
  // signals; the active phase auto-follows the frontier (the user-pick SELECTION stays in Planning).
  const phases = useMemo(() => phasesFrom(planSecs, signals), [planSecs, signals]);
  const focusActiveIdx = useMemo(() => activeIndex(phases), [phases]);
  const focusGateReady = useMemo(() => currentGateReady(planSecs, signals), [planSecs, signals]);
  const planComplete = useMemo(() => planStagesComplete(planSecs, signals), [planSecs, signals]);
  const currentStage = phases[focusActiveIdx]?.key ?? "";
  const planStatusLabel = planComplete ? "complete" : currentStage ? "in_progress" : "starting";
  // Legacy alias kept for the publish/recovery readers (#854): the dynamic blueprint gate IS the
  // completion gate.
  const planReady = planComplete;

  return { injectionGateState, phases, focusActiveIdx, focusGateReady, planComplete, currentStage, planStatusLabel, planReady };
}
