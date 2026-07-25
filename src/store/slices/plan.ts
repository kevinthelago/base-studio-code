// PlanSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import { bscRun, bscWrite } from "@/shared/lib/core/bsc";
import { hashString } from "@/shared/lib/core/hashString";
import type { AppStore } from "../types";
import { makeBlueprints, mkStage, cloneStages, DEFAULT_BLUEPRINT_ID, type Blueprint } from "@/features/planner/stages/blueprints";
import { packagedUiKitPin, resolveBlueprintUiKit } from "@/features/planner/blueprints/uiKitPin";
import { packagedSoundKitPin, resolveBlueprintSoundKit } from "@/features/planner/blueprints/soundKitPin";
import { canonicalTopicKey, FEATURES_KEY } from "@/features/planner/stages/planTopics";
import { emptyFleet } from "@/features/planner/fleet/planFleet";
import { defaultStageConfig, discoveryOnlyStageConfig, enabledOrderedStages } from "@/features/planner/stages/planStages";
import { normalizeFlow, resolveFlow } from "@/features/planner/fleet/agentFlow";
import { setMapEntry } from "../updateHelpers";
import { dropProjectScoped } from "./projectScopedMaps";
/** The `repoPublic` key for one repo within a project (#1227): `<projectKey>::<repoFullName>`,
 *  the repo-scoped convention used elsewhere (e.g. repoStartupPromptDoc). */
export function repoVisibilityKey(projectKey: string, repoId: string): string {
  return `${projectKey}::${repoId}`;
}

/**
 * Resolve a repo's create-time GitHub visibility (#1227): the per-repo override if set, else the
 * project-level default (`reposPublic`), else **private**. Used at the Repos card + at publish so
 * the UI and the create call agree.
 */
export function resolveRepoPublic(
  repoPublic: Record<string, boolean>,
  reposPublic: Record<string, boolean>,
  projectKey: string,
  repoId: string,
): boolean {
  const k = repoVisibilityKey(projectKey, repoId);
  if (k in repoPublic) return repoPublic[k];
  return reposPublic[projectKey] ?? false;
}

/** Record the project→kit consumer-index edge for a blueprint bind (#2277). If the blueprint declares a
 *  component `kit`, the seeded project is a CONSUMER of it, so `addKitUsage` files the edge (idempotent by
 *  (projectKey, kitId), write-through to `bsc ui usage`). A blueprint with no `kit` is a no-op — so
 *  this fills the consumer index automatically at every blueprint bind (creation + switch). */
function recordBlueprintKit(get: () => AppStore, projectId: string, blueprintId: string): void {
  const kit = get().blueprints.find((b) => b.id === blueprintId)?.kit;
  if (kit) get().addKitUsage(projectId, kit);
}

type PlanSlice = Pick<AppStore,
  "configProfiles" | "addConfigProfile" | "updateConfigProfile" | "removeConfigProfile" | "planStages" | "setPlanStage" | "planConfirmedStages" | "confirmPlanStage" | "unconfirmPlanStage" | "markStageConfirmedLocal" | "planAuthoredBlueprint" | "setAuthoredBlueprint" | "planDeployConfig" | "setPlanDeployConfig" | "planMarketConfig" | "setPlanMarketConfig" | "planTransformations" | "setPlanTransformations" | "planSourceConfig" | "setPlanSourceConfig" | "reposPublic" | "setReposPublic" | "repoPublic" | "setRepoPublic" | "planInjectionAck" | "acknowledgePlanInjections" | "planSkippedStages" | "skipPlanStage" | "unskipPlanStage" | "markStageSkippedLocal" | "canonicalizePlanStages" | "planAutomations" | "setPlanAutomations" | "clearPlanAutomations" | "planStageConfig" | "setStageEnabled" | "reorderStages" | "setProjectStageConfig" | "seedDiscoveryOnlyStages" | "blueprints" | "activeBlueprintId" | "setActiveBlueprint" | "projectBlueprintId" | "setProjectBlueprintId" | "addBlueprint" | "generateBlueprint" | "duplicateBlueprint" | "updateBlueprintMeta" | "setBlueprintStages" | "removeBlueprint" | "importBlueprint" | "stageRuns" | "setStageRun" | "stagePreview" | "setStagePreview" | "uiScreens" | "addUiScreen" | "uiApproved" | "setUiScreenApproved" | "planFleet" | "pinnedContext" | "togglePinnedContext" | "setPlanFleet" | "planFleetTopology" | "setPlanFleetTopology" | "planFleetDirectorDrive" | "setPlanFleetDirectorDrive" | "addPlanAgentStream" | "removePlanAgentStream" | "setPlanAgentStreamProfile" | "setPlanAgentStreamFlow" | "setPlanAgentStreamModel" | "setPlanAgentStreamStrategy" | "setPlanAgentStreamPersona" | "setPlanFleetMeta" | "setPlanDirector" | "setPlanDirectorDrive" | "clearPlanFleet" | "clearPlan"
>;

// User blueprints (not the code-owned built-ins) are mirrored to ~/.base-studio-code/blueprints/
// <id>.json so they survive a store reset and a download has a real home (#blueprints). Best-effort,
// fire-and-forget over the `bsc` bridge (`bsc blueprint set`/`remove`, #2143) — the store stays the
// in-memory source; the dir is the durable copy. Blueprints are GLOBAL (no project key) → `null`.
const syncBlueprintFile = (bp?: Blueprint) => {
  if (bp && bp.origin !== "built-in") {
    void bscWrite(null, ["blueprint", "set"], bp);
  }
};
const deleteBlueprintFile = (id: string) => {
  void bscRun(null, ["blueprint", "remove", id]);
};

export const createPlanSlice: StateCreator<AppStore, [], [], PlanSlice> = (set, get) => {
  // In-app fleet edits must reach plan.db (#1317), so the director / recovery / planning poll see
  // them and they survive a reload. `updater` gets the current fleet (or undefined) and returns the
  // new fleet — or null to no-op (no change, no persist). NOT used by the poll's READ path
  // (`setPlanFleet`), so there is no read→write loop. `bsc plan fleet set` does a full replace, so
  // persisting the whole post-edit fleet covers add/remove/edit.
  const mutateFleet = (
    projectId: string,
    updater: (cur: AppStore["planFleet"][string] | undefined) => AppStore["planFleet"][string] | null,
  ) => {
    const next = updater(get().planFleet[projectId]);
    if (next === null) return;
    set({ planFleet: setMapEntry(get().planFleet, projectId, next) });
    void bscWrite(projectId, ["plan", "fleet", "set"], next);
  };
  // Shallow-merge a patch into exactly one stream (by id), leaving the rest of the fleet untouched.
  // The shared body of every single-field stream setter (profile/model/strategy/persona) — a no-op
  // when the project has no fleet yet. NOT for add/remove (they mutate the stream list) or flow
  // (its value derives from the stream's own current flow, not a plain field patch).
  const patchStream = (
    projectId: string,
    streamId: string,
    patch: Partial<AppStore["planFleet"][string]["streams"][number]>,
  ) =>
    mutateFleet(projectId, (cur) => {
      if (!cur) return null;
      const streams = cur.streams.map((x) => (x.id === streamId ? { ...x, ...patch } : x));
      return { ...cur, streams };
    });
  return ({
      configProfiles: [],
      addConfigProfile: (profile) =>
        set((s) => ({
          configProfiles: [
            ...s.configProfiles,
            { ...profile, id: `cfg_${Math.random().toString(36).slice(2, 8)}` },
          ],
        })),
      updateConfigProfile: (id, patch) =>
        set((s) => ({
          configProfiles: s.configProfiles.map((p) =>
            p.id === id ? { ...p, ...patch } : p,
          ),
        })),
      removeConfigProfile: (id) =>
        set((s) => ({ configProfiles: s.configProfiles.filter((p) => p.id !== id) })),

      planStages: {},
      setPlanStage: (projectId, key, content) =>
        set((s) => ({
          planStages: setMapEntry(s.planStages, projectId, { ...(s.planStages[projectId] ?? {}), [key]: content }),
        })),
      planConfirmedStages: {},
      // Confirm a stage. Durable in plan.db (#2256): the app-state used to be the ONLY home for
      // confirmations, so a state reset/migration re-opened every gate on revisit — now we write
      // through to plan.db with a FINGERPRINT of the stage's content at confirm time (the poll
      // compares it to reset just this stage when its content later changes).
      confirmPlanStage: (projectId, key) =>
        set((s) => {
          const existing = s.planConfirmedStages[projectId] ?? [];
          if (!existing.includes(key)) {
            // Fire-and-forget durable write (the poll rehydrates from plan.db). Fingerprint the
            // stage's current content so a later edit to it resets exactly this stage.
            void bscRun(projectId, ["plan", "confirm", "add", key, hashString(s.planStages[projectId]?.[key] ?? "")]);
          }
          if (existing.includes(key)) return {};
          return { planConfirmedStages: setMapEntry(s.planConfirmedStages, projectId, [...existing, key]) };
        }),
      // Unconfirm (the per-stage reset). Drops it from plan.db too so it doesn't rehydrate.
      unconfirmPlanStage: (projectId, key) => {
        void bscRun(projectId, ["plan", "confirm", "remove", key]);
        set((s) => ({
          planConfirmedStages: setMapEntry(
            s.planConfirmedStages,
            projectId,
            (s.planConfirmedStages[projectId] ?? []).filter((k) => k !== key),
          ),
        }));
      },
      // Add a confirmation to the store ONLY (no plan.db write) — used by the poll to rehydrate the
      // durable confirmed set on revisit without echoing it straight back to plan.db.
      markStageConfirmedLocal: (projectId, key) =>
        set((s) => {
          const existing = s.planConfirmedStages[projectId] ?? [];
          if (existing.includes(key)) return {};
          return { planConfirmedStages: setMapEntry(s.planConfirmedStages, projectId, [...existing, key]) };
        }),
      planAuthoredBlueprint: {},
      setAuthoredBlueprint: (projectId, bp) =>
        set((s) => ({ planAuthoredBlueprint: setMapEntry(s.planAuthoredBlueprint, projectId, bp) })),
      planDeployConfig: {},
      setPlanDeployConfig: (projectId, cfg) =>
        set((s) => ({ planDeployConfig: setMapEntry(s.planDeployConfig, projectId, cfg) })),
      planMarketConfig: {},
      setPlanMarketConfig: (projectId, cfg) =>
        set((s) => ({ planMarketConfig: setMapEntry(s.planMarketConfig, projectId, cfg) })),
      planTransformations: {},
      setPlanTransformations: (projectId, rows) =>
        set((s) => ({ planTransformations: setMapEntry(s.planTransformations, projectId, rows) })),
      planSourceConfig: {},
      setPlanSourceConfig: (projectId, cfg) =>
        set((s) => ({ planSourceConfig: setMapEntry(s.planSourceConfig, projectId, cfg) })),
      reposPublic: {},
      setReposPublic: (projectId, isPublic) =>
        set((s) => ({ reposPublic: setMapEntry(s.reposPublic, projectId, isPublic) })),
      repoPublic: {},
      setRepoPublic: (projectKey, repoId, isPublic) =>
        set((s) => ({ repoPublic: setMapEntry(s.repoPublic, repoVisibilityKey(projectKey, repoId), isPublic) })),
      // #1107: the injection-finding signature the user acknowledged for a project (acknowledge-to-
      // clear). A signature mismatch (new findings) re-gates; the hard-gate setting ignores this.
      planInjectionAck: {},
      acknowledgePlanInjections: (projectId, signature) =>
        set((s) => ({ planInjectionAck: setMapEntry(s.planInjectionAck, projectId, signature) })),
      planSkippedStages: {},
      // Skip an optional stage. Durable in plan.db (#2267): like confirmations (#2256) a skip used to
      // live only in app-state, so a reset/migration re-stopped the flow on an already-decided stage.
      // A skip is a plain decision (not content-based), so — unlike a confirmation — there is no
      // fingerprint / reset-on-change; we just write the flag through and rehydrate it via the poll.
      skipPlanStage: (projectId, key) =>
        set((s) => {
          const existing = s.planSkippedStages[projectId] ?? [];
          if (!existing.includes(key)) void bscRun(projectId, ["plan", "skip", "add", key]);
          if (existing.includes(key)) return {};
          return { planSkippedStages: setMapEntry(s.planSkippedStages, projectId, [...existing, key]) };
        }),
      unskipPlanStage: (projectId, key) => {
        void bscRun(projectId, ["plan", "skip", "remove", key]);
        set((s) => ({
          planSkippedStages: setMapEntry(
            s.planSkippedStages,
            projectId,
            (s.planSkippedStages[projectId] ?? []).filter((k) => k !== key),
          ),
        }));
      },
      // Add a skip to the store ONLY (no plan.db write) — the poll uses this to rehydrate the durable
      // skipped set on revisit without echoing it straight back to plan.db.
      markStageSkippedLocal: (projectId, key) =>
        set((s) => {
          const existing = s.planSkippedStages[projectId] ?? [];
          if (existing.includes(key)) return {};
          return { planSkippedStages: setMapEntry(s.planSkippedStages, projectId, [...existing, key]) };
        }),
      canonicalizePlanStages: (projectId) =>
        set((s) => {
          const sections = s.planStages[projectId];
          if (!sections) return {};
          let changed = false;
          const nextSections: Record<string, string> = {};
          for (const [k, v] of Object.entries(sections)) {
            const ck = canonicalTopicKey(k);
            if (ck !== k) changed = true;
            // The canonical key's own content always wins; an alias only fills if absent.
            if (k === ck || nextSections[ck] === undefined) nextSections[ck] = v;
          }
          const confirmed = s.planConfirmedStages[projectId];
          let nextConfirmed = confirmed;
          if (confirmed) {
            const mapped = [...new Set(confirmed.map(canonicalTopicKey))];
            if (mapped.length !== confirmed.length || mapped.some((k, i) => k !== confirmed[i])) {
              nextConfirmed = mapped;
              changed = true;
            }
          }
          if (!changed) return {};
          return {
            planStages: setMapEntry(s.planStages, projectId, nextSections),
            ...(nextConfirmed !== confirmed
              ? { planConfirmedStages: setMapEntry(s.planConfirmedStages, projectId, nextConfirmed) }
              : {}),
          };
        }),
      planAutomations: {},
      setPlanAutomations: (projectId, list) =>
        set((s) => ({ planAutomations: setMapEntry(s.planAutomations, projectId, list) })),
      clearPlanAutomations: (projectId) =>
        set((s) => ({ planAutomations: setMapEntry(s.planAutomations, projectId, []) })),

      planStageConfig: {},
      setStageEnabled: (projectId, stageId, enabled) =>
        set((s) => {
          const cur = s.planStageConfig[projectId] ?? defaultStageConfig();
          return {
            planStageConfig: setMapEntry(s.planStageConfig, projectId, { ...cur, enabled: { ...cur.enabled, [stageId]: enabled } }),
          };
        }),
      reorderStages: (projectId, order) =>
        set((s) => {
          const cur = s.planStageConfig[projectId] ?? defaultStageConfig();
          return {
            planStageConfig: setMapEntry(s.planStageConfig, projectId, { ...cur, order }),
          };
        }),
      setProjectStageConfig: (projectId, config) =>
        set((s) => ({ planStageConfig: setMapEntry(s.planStageConfig, projectId, config) })),
      // #1395 phase 1: seed a NEW project with the dynamic-stages baseline (Discovery only).
      // Idempotent — a no-op once the project has a stage config, so it never clobbers a plan
      // (or a blueprint-seeded config) that already exists.
      seedDiscoveryOnlyStages: (projectId) =>
        set((s) =>
          s.planStageConfig[projectId]
            ? {}
            : { planStageConfig: setMapEntry(s.planStageConfig, projectId, discoveryOnlyStageConfig()) },
        ),

      blueprints: makeBlueprints(),
      activeBlueprintId: DEFAULT_BLUEPRINT_ID,
      setActiveBlueprint: (id) => {
        set({ activeBlueprintId: id });
        // Opening a pinned blueprint resolves its UI kit against the local store (#2465):
        // store hit ⇒ zero downloads; miss ⇒ fetch its typed gist, verified before storing.
        // Fire-and-forget; a blueprint without a pin is a no-op.
        resolveBlueprintUiKit(get().blueprints.find((b) => b.id === id), get().githubToken);
        // …and its SOUND kit the same way (#3372) — same store-hit/fetch-verify discipline, one
        // pillar over. Independent of the UI resolve: either pin can be absent or fail on its own.
        resolveBlueprintSoundKit(get().blueprints.find((b) => b.id === id), get().githubToken);
      },

      projectBlueprintId: {},
      setProjectBlueprintId: (projectId, blueprintId) => {
        set((s) => ({ projectBlueprintId: setMapEntry(s.projectBlueprintId, projectId, blueprintId) }));
        // Auto-record the consumer-index edge (#2277): a project seeded from a kit-bearing blueprint USES
        // that kit, so a later kit change fans out to it. Idempotent by (projectKey, kitId); no-op when unset.
        recordBlueprintKit(get, projectId, blueprintId);
      },
      addBlueprint: () => {
        const id = `bp-${Date.now().toString(36)}`;
        const bp: Blueprint = {
          id, name: "Untitled blueprint", desc: "New configuration",
          sections: [mkStage("discovery", { expanded: true })],
          // Default-pin the packaged UI kit (#2465): a NEW blueprint is always fully specified.
          // The pin resolves against the store's embedded fallback, so it costs zero downloads;
          // existing blueprints without a pin are untouched (this only runs at creation).
          uiKit: packagedUiKitPin(),
          // …and the packaged SOUND kit (#3372): a new blueprint is fully specified on BOTH library
          // pillars. Resolves against the store's embedded fallback, so it also costs zero downloads.
          soundKit: packagedSoundKitPin(),
        };
        set((s) => ({ blueprints: [...s.blueprints, bp] }));
        syncBlueprintFile(bp);
        return id;
      },
      // Promote a completed project's PLAN into a reusable blueprint (#3785) — the "Steam library"
      // contribution path. The blueprint captures the project's plan ROUTE (its enabled, ordered
      // stages → sections), named after the project. (Config carry-over — skills / mcp / kit — and the
      // curated FEATURE LIST are follow-up increments; `Blueprint.features` doesn't exist yet.) A user
      // blueprint (`origin: "local"`) so it persists + is share-eligible like any authored one.
      generateBlueprint: (projectKey) => {
        const st = get();
        const cfg = st.planStageConfig[projectKey] ?? defaultStageConfig();
        const sections = enabledOrderedStages(cfg).map((s) => mkStage(s.id));
        const title = st.planningTitle?.trim() || "Project";
        const id = `bp-${Date.now().toString(36)}`;
        // Capture the project's curated FEATURE LIST — the `features` section content (features.md) —
        // so the blueprint carries the features that route builds, not just the empty stage route.
        const features = st.planStages[projectKey]?.[FEATURES_KEY]?.trim();
        const bp: Blueprint = {
          id,
          name: `${title} blueprint`,
          desc: `Generated from the ${title} project's plan`,
          origin: "local",
          sections,
          ...(features ? { features } : {}),
          uiKit: packagedUiKitPin(),
          soundKit: packagedSoundKitPin(),
        };
        set((s) => ({ blueprints: [...s.blueprints, bp] }));
        syncBlueprintFile(bp);
        return id;
      },
      duplicateBlueprint: (id) => {
        const nid = `bp-${Date.now().toString(36)}`;
        set((s) => {
          const src = s.blueprints.find((b) => b.id === id);
          if (!src) return {};
          // Deep-copy the composed sub-models (sections; team #2450) so the duplicate never shares
          // mutable graph objects with its source — the same fork isolation as forkTeamFromOrg.
          const copy: Blueprint = {
            ...src, id: nid, name: `${src.name} copy`, sections: cloneStages(src.sections),
            ...(src.team ? { team: structuredClone(src.team) } : {}),
          };
          const i = s.blueprints.findIndex((b) => b.id === id);
          const blueprints = [...s.blueprints];
          blueprints.splice(i + 1, 0, copy);
          return { blueprints };
        });
        syncBlueprintFile(get().blueprints.find((b) => b.id === nid));
        return nid;
      },
      updateBlueprintMeta: (id, patch) => {
        set((s) => ({ blueprints: s.blueprints.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
        syncBlueprintFile(get().blueprints.find((b) => b.id === id));
      },
      setBlueprintStages: (id, sections) => {
        set((s) => ({ blueprints: s.blueprints.map((b) => (b.id === id ? { ...b, sections } : b)) }));
        syncBlueprintFile(get().blueprints.find((b) => b.id === id));
      },
      removeBlueprint: (id) => {
        set((s) => {
          const blueprints = s.blueprints.filter((b) => b.id !== id);
          const activeBlueprintId = s.activeBlueprintId === id
            ? (blueprints[0]?.id ?? DEFAULT_BLUEPRINT_ID)
            : s.activeBlueprintId;
          return { blueprints, activeBlueprintId };
        });
        deleteBlueprintFile(id);
      },
      importBlueprint: (bp) => {
        const id = `bp-${Date.now().toString(36)}`;
        // Deep-copy the team (#2450) so the imported/library copy never shares graph objects with
        // the caller's blueprint (e.g. the in-progress authored one it was published from).
        const created: Blueprint = {
          ...bp, id, sections: cloneStages(bp.sections),
          ...(bp.team ? { team: structuredClone(bp.team) } : {}),
        };
        set((s) => ({ blueprints: [...s.blueprints, created] }));
        syncBlueprintFile(created);
        // An imported blueprint's UI-kit pin resolves immediately (#2465): already-stored
        // id@version ⇒ no download; else fetch-verify-store from the pin's source gist.
        resolveBlueprintUiKit(created, get().githubToken);
        // Same for its sound-kit pin (#3372).
        resolveBlueprintSoundKit(created, get().githubToken);
        return id;
      },

      stageRuns: {},
      setStageRun: (projectKey, stageUid, state) =>
        set((s) => ({
          stageRuns: setMapEntry(s.stageRuns, projectKey, { ...(s.stageRuns[projectKey] ?? {}), [stageUid]: state }),
        })),
      stagePreview: {},
      setStagePreview: (projectKey, value) =>
        set((s) => ({ stagePreview: setMapEntry(s.stagePreview, projectKey, value) })),
      uiScreens: {},
      addUiScreen: (projectKey, screen) =>
        set((s) => {
          const cur = s.uiScreens[projectKey] ?? [];
          if (cur.includes(screen)) return {} as Partial<typeof s>;
          return { uiScreens: setMapEntry(s.uiScreens, projectKey, [...cur, screen]) };
        }),
      uiApproved: {},
      setUiScreenApproved: (projectKey, screen, approved) =>
        set((s) => {
          const cur = s.uiApproved[projectKey] ?? [];
          const next = approved ? (cur.includes(screen) ? cur : [...cur, screen]) : cur.filter((x) => x !== screen);
          return { uiApproved: setMapEntry(s.uiApproved, projectKey, next) };
        }),

      planFleet: {},
      pinnedContext: {},
      togglePinnedContext: (projectId, name) =>
        set((s) => {
          const cur = s.pinnedContext[projectId] ?? [];
          const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
          return { pinnedContext: setMapEntry(s.pinnedContext, projectId, next) };
        }),
      setPlanFleet: (projectId, fleet) =>
        set((s) => ({ planFleet: setMapEntry(s.planFleet, projectId, fleet) })),
      planFleetTopology: {},
      setPlanFleetTopology: (projectId, topology) =>
        set((s) => ({ planFleetTopology: setMapEntry(s.planFleetTopology, projectId, topology) })),
      planFleetDirectorDrive: {},
      setPlanFleetDirectorDrive: (projectId, drive) =>
        set((s) => ({ planFleetDirectorDrive: setMapEntry(s.planFleetDirectorDrive, projectId, drive) })),
      addPlanAgentStream: (projectId, stream) =>
        mutateFleet(projectId, (raw) => {
          const cur = raw ?? emptyFleet();
          // Merge by id so re-emitted tags refine an existing stream in place.
          const streams = cur.streams.some((x) => x.id === stream.id)
            ? cur.streams.map((x) => (x.id === stream.id ? stream : x))
            : [...cur.streams, stream];
          return { ...cur, streams };
        }),
      removePlanAgentStream: (projectId, id) =>
        mutateFleet(projectId, (cur) => {
          if (!cur) return null;
          return { ...cur, streams: cur.streams.filter((x) => x.id !== id) };
        }),
      setPlanAgentStreamProfile: (projectId, streamId, profileId) =>
        patchStream(projectId, streamId, { profile: profileId ?? undefined }),
      setPlanAgentStreamFlow: (projectId, streamId, patch) =>
        mutateFleet(projectId, (cur) => {
          if (!cur) return null;
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, flow: normalizeFlow({ ...resolveFlow(x.flow), ...patch }) } : x);
          return { ...cur, streams };
        }),
      setPlanAgentStreamModel: (projectId, streamId, model) =>
        patchStream(projectId, streamId, { model: model ?? undefined }),
      setPlanAgentStreamStrategy: (projectId, streamId, strategy) =>
        patchStream(projectId, streamId, { strategy }),
      // #2094: the persona a stream launches as — resolved at fleet launch to role/prompt/skills/model.
      setPlanAgentStreamPersona: (projectId, streamId, personaId) =>
        patchStream(projectId, streamId, { persona: personaId ?? undefined }),
      setPlanFleetMeta: (projectId, recommended, reasoning, strategy) =>
        mutateFleet(projectId, (raw) => {
          const cur = raw ?? emptyFleet();
          return { ...cur, recommended, reasoning, strategy: strategy ?? cur.strategy };
        }),
      setPlanDirector: (projectId, enabled, role) =>
        mutateFleet(projectId, (raw) => {
          const cur = raw ?? emptyFleet();
          return { ...cur, director: { enabled, role: role ?? cur.director.role, drive: cur.director.drive } };
        }),
      setPlanDirectorDrive: (projectId, drive) =>
        mutateFleet(projectId, (raw) => {
          const cur = raw ?? emptyFleet();
          return { ...cur, director: { ...cur.director, drive } };
        }),
      clearPlanFleet: (projectId) =>
        set((s) => ({ planFleet: setMapEntry(s.planFleet, projectId, emptyFleet()) })),
      // Drop the single `key` from every map in the `clearPlan` op set (projectScopedMaps.ts,
      // #2712): the plan section maps, plan-config, rendered artifacts + pipeline run states, pinned
      // context, and the project's repo links (clear means clear — the repos stage resets, #664).
      clearPlan: (key) =>
        set((s) => dropProjectScoped(s, "clearPlan", key)),

  });
};
