// PlanSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AppStore } from "../types";
import { makeBlueprints, mkSection, cloneSections, blueprintToStageConfig, canSwitchBlueprint, DEFAULT_BLUEPRINT_ID, type Blueprint } from "@/features/planner/stages/blueprints";
import { canonicalSectionKey, emptyFleet } from "@/features/planner/stages/planSections";
import { defaultStageConfig } from "@/features/planner/stages/planStages";
import { seedDataModels, emptyDataModel } from "@/features/planner/data/dataModel";
import { generateAgentProfile } from "@/shared/lib/session/profileGen";
import { normalizeFlow, resolveFlow } from "@/features/planner/fleet/agentFlow";
import { repoPromptKey } from "@/shared/lib/session/startupPrompt";
import { resolveAllowedCommands } from "@/shared/lib/session/allowedCommands";

/** The `repoPublic` key for one repo within a project (#1227): `<projectKey>::<repoFullName>`,
 *  the repo-scoped convention used elsewhere (e.g. repoAllowedCommands). */
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

/** Drop every per-repo entry for `projectKey` from a `<projectKey>::<repoId>`-keyed map (#1227). */
function dropRepoScoped<T>(m: Record<string, T>, projectKey: string): Record<string, T> {
  const prefix = `${projectKey}::`;
  return Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(prefix)));
}

type PlanSlice = Pick<AppStore,
  "configProfiles" | "addConfigProfile" | "updateConfigProfile" | "removeConfigProfile" | "planSections" | "setPlanSection" | "planConfirmedSections" | "confirmPlanSection" | "unconfirmPlanSection" | "planAuthoredBlueprint" | "setAuthoredBlueprint" | "planDeployConfig" | "setPlanDeployConfig" | "planSourceConfig" | "setPlanSourceConfig" | "planIntegrationConfig" | "setPlanIntegrationConfig" | "reposPublic" | "setReposPublic" | "repoPublic" | "setRepoPublic" | "planInjectionAck" | "acknowledgePlanInjections" | "planSkippedSections" | "skipPlanSection" | "unskipPlanSection" | "canonicalizePlanSections" | "planKbAssignments" | "addPlanKbAssignment" | "removePlanKbAssignment" | "planAutomations" | "addPlanAutomation" | "clearPlanAutomations" | "planStageConfig" | "setStageEnabled" | "reorderStages" | "setProjectStageConfig" | "blueprints" | "activeBlueprintId" | "setActiveBlueprint" | "dataModels" | "activeDataModelId" | "setActiveDataModel" | "addDataModel" | "setDataModel" | "removeDataModel" | "loadVerified" | "setLoadVerified" | "projectBlueprintId" | "setProjectBlueprintId" | "applyBlueprintToProject" | "addBlueprint" | "duplicateBlueprint" | "updateBlueprintMeta" | "setBlueprintSections" | "removeBlueprint" | "importBlueprint" | "stagePipelineRuns" | "setStagePipelineRun" | "stagePreview" | "setStagePreview" | "sectionGrades" | "setSectionGrade" | "uiScreens" | "addUiScreen" | "uiApproved" | "setUiScreenApproved" | "planFleet" | "pinnedContext" | "togglePinnedContext" | "setPlanFleet" | "planFleetTopology" | "setPlanFleetTopology" | "planFleetDirectorDrive" | "setPlanFleetDirectorDrive" | "addPlanAgentStream" | "removePlanAgentStream" | "setPlanAgentStreamProfile" | "setPlanAgentStreamFlow" | "setPlanAgentStreamModel" | "setPlanAgentStreamStrategy" | "setPlanAgentStreamPerm" | "setPlanAgentStreamPreset" | "generateFleetProfiles" | "setPlanFleetMeta" | "setPlanDirector" | "setPlanDirectorDrive" | "clearPlanFleet" | "clearPlan"
>;

// User blueprints (not the code-owned built-ins) are mirrored to ~/.base-studio-code/blueprints/
// <id>.json so they survive a store reset and a download has a real home (#blueprints). Best-effort,
// fire-and-forget — the store stays the in-memory source; the dir is the durable copy.
const syncBlueprintFile = (bp?: Blueprint) => {
  if (bp && bp.origin !== "built-in") {
    void invoke("write_blueprint", { id: bp.id, json: JSON.stringify(bp) }).catch(() => {});
  }
};
const deleteBlueprintFile = (id: string) => {
  void invoke("delete_blueprint", { id }).catch(() => {});
};

export const createPlanSlice: StateCreator<AppStore, [], [], PlanSlice> = (set, get) => ({
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

      planSections: {},
      setPlanSection: (projectId, key, content) =>
        set((s) => ({
          planSections: {
            ...s.planSections,
            [projectId]: { ...(s.planSections[projectId] ?? {}), [key]: content },
          },
        })),
      planConfirmedSections: {},
      confirmPlanSection: (projectId, key) =>
        set((s) => {
          const existing = s.planConfirmedSections[projectId] ?? [];
          if (existing.includes(key)) return {};
          return { planConfirmedSections: { ...s.planConfirmedSections, [projectId]: [...existing, key] } };
        }),
      unconfirmPlanSection: (projectId, key) =>
        set((s) => ({
          planConfirmedSections: {
            ...s.planConfirmedSections,
            [projectId]: (s.planConfirmedSections[projectId] ?? []).filter((k) => k !== key),
          },
        })),
      planAuthoredBlueprint: {},
      setAuthoredBlueprint: (projectId, bp) =>
        set((s) => ({ planAuthoredBlueprint: { ...s.planAuthoredBlueprint, [projectId]: bp } })),
      planDeployConfig: {},
      setPlanDeployConfig: (projectId, cfg) =>
        set((s) => ({ planDeployConfig: { ...s.planDeployConfig, [projectId]: cfg } })),
      planSourceConfig: {},
      setPlanSourceConfig: (projectId, cfg) =>
        set((s) => ({ planSourceConfig: { ...s.planSourceConfig, [projectId]: cfg } })),
      planIntegrationConfig: {},
      setPlanIntegrationConfig: (projectId, cfg) =>
        set((s) => ({ planIntegrationConfig: { ...s.planIntegrationConfig, [projectId]: cfg } })),
      reposPublic: {},
      setReposPublic: (projectId, isPublic) =>
        set((s) => ({ reposPublic: { ...s.reposPublic, [projectId]: isPublic } })),
      repoPublic: {},
      setRepoPublic: (projectKey, repoId, isPublic) =>
        set((s) => ({ repoPublic: { ...s.repoPublic, [repoVisibilityKey(projectKey, repoId)]: isPublic } })),
      // #1107: the injection-finding signature the user acknowledged for a project (acknowledge-to-
      // clear). A signature mismatch (new findings) re-gates; the hard-gate setting ignores this.
      planInjectionAck: {},
      acknowledgePlanInjections: (projectId, signature) =>
        set((s) => ({ planInjectionAck: { ...s.planInjectionAck, [projectId]: signature } })),
      planSkippedSections: {},
      skipPlanSection: (projectId, key) =>
        set((s) => {
          const existing = s.planSkippedSections[projectId] ?? [];
          if (existing.includes(key)) return {};
          return { planSkippedSections: { ...s.planSkippedSections, [projectId]: [...existing, key] } };
        }),
      unskipPlanSection: (projectId, key) =>
        set((s) => ({
          planSkippedSections: {
            ...s.planSkippedSections,
            [projectId]: (s.planSkippedSections[projectId] ?? []).filter((k) => k !== key),
          },
        })),
      canonicalizePlanSections: (projectId) =>
        set((s) => {
          const sections = s.planSections[projectId];
          if (!sections) return {};
          let changed = false;
          const nextSections: Record<string, string> = {};
          for (const [k, v] of Object.entries(sections)) {
            const ck = canonicalSectionKey(k);
            if (ck !== k) changed = true;
            // The canonical key's own content always wins; an alias only fills if absent.
            if (k === ck || nextSections[ck] === undefined) nextSections[ck] = v;
          }
          const confirmed = s.planConfirmedSections[projectId];
          let nextConfirmed = confirmed;
          if (confirmed) {
            const mapped = [...new Set(confirmed.map(canonicalSectionKey))];
            if (mapped.length !== confirmed.length || mapped.some((k, i) => k !== confirmed[i])) {
              nextConfirmed = mapped;
              changed = true;
            }
          }
          if (!changed) return {};
          return {
            planSections: { ...s.planSections, [projectId]: nextSections },
            ...(nextConfirmed !== confirmed
              ? { planConfirmedSections: { ...s.planConfirmedSections, [projectId]: nextConfirmed } }
              : {}),
          };
        }),
      planKbAssignments: {},
      addPlanKbAssignment: (projectId, blockId) =>
        set((s) => {
          const existing = s.planKbAssignments[projectId] ?? [];
          if (existing.includes(blockId)) return {};
          return { planKbAssignments: { ...s.planKbAssignments, [projectId]: [...existing, blockId] } };
        }),
      removePlanKbAssignment: (projectId, blockId) =>
        set((s) => ({
          planKbAssignments: {
            ...s.planKbAssignments,
            [projectId]: (s.planKbAssignments[projectId] ?? []).filter((id) => id !== blockId),
          },
        })),
      planAutomations: {},
      addPlanAutomation: (projectId, a) =>
        set((s) => {
          const existing = s.planAutomations[projectId] ?? [];
          if (existing.some((x) => x.name === a.name && x.command === a.command)) return {};
          return { planAutomations: { ...s.planAutomations, [projectId]: [...existing, a] } };
        }),
      clearPlanAutomations: (projectId) =>
        set((s) => ({ planAutomations: { ...s.planAutomations, [projectId]: [] } })),

      planStageConfig: {},
      setStageEnabled: (projectId, stageId, enabled) =>
        set((s) => {
          const cur = s.planStageConfig[projectId] ?? defaultStageConfig();
          return {
            planStageConfig: {
              ...s.planStageConfig,
              [projectId]: { ...cur, enabled: { ...cur.enabled, [stageId]: enabled } },
            },
          };
        }),
      reorderStages: (projectId, order) =>
        set((s) => {
          const cur = s.planStageConfig[projectId] ?? defaultStageConfig();
          return {
            planStageConfig: { ...s.planStageConfig, [projectId]: { ...cur, order } },
          };
        }),
      setProjectStageConfig: (projectId, config) =>
        set((s) => ({ planStageConfig: { ...s.planStageConfig, [projectId]: config } })),

      blueprints: makeBlueprints(),
      activeBlueprintId: DEFAULT_BLUEPRINT_ID,
      setActiveBlueprint: (id) => set({ activeBlueprintId: id }),

      dataModels: seedDataModels(),
      activeDataModelId: "dm-crm",
      setActiveDataModel: (id) => set({ activeDataModelId: id }),
      addDataModel: () => {
        const id = `dm-${Date.now().toString(36)}`;
        set((s) => ({ dataModels: [...s.dataModels, emptyDataModel(id)], activeDataModelId: id }));
        return id;
      },
      setDataModel: (id, model) =>
        set((s) => ({ dataModels: s.dataModels.map((m) => (m.id === id ? { ...model, id } : m)) })),
      removeDataModel: (id) =>
        set((s) => {
          const dataModels = s.dataModels.filter((m) => m.id !== id);
          const activeDataModelId = s.activeDataModelId === id ? (dataModels[0]?.id ?? "") : s.activeDataModelId;
          return { dataModels, activeDataModelId };
        }),
      loadVerified: {},
      setLoadVerified: (projectKey, entity, verified) =>
        set((s) => ({
          loadVerified: {
            ...s.loadVerified,
            [projectKey]: { ...(s.loadVerified[projectKey] ?? {}), [entity]: verified },
          },
        })),
      projectBlueprintId: {},
      setProjectBlueprintId: (projectId, blueprintId) =>
        set((s) => ({ projectBlueprintId: { ...s.projectBlueprintId, [projectId]: blueprintId } })),
      applyBlueprintToProject: (projectId, blueprintId) =>
        set((s) => {
          const bp = s.blueprints.find((b) => b.id === blueprintId);
          if (!bp) return {};
          // Only a greenfield project may switch, and only to a transform/harden lifecycle (#923);
          // every other origin/target (incl. the locked blueprint-author) is refused.
          const current = s.blueprints.find((b) => b.id === s.projectBlueprintId[projectId]);
          if (!canSwitchBlueprint(current, bp)) return {};
          const drop = <T,>(m: Record<string, T>): Record<string, T> => {
            const n = { ...m }; delete n[projectId]; return n;
          };
          // Full reset: wipe ALL of the project's planning state (everything clearPlan
          // drops) so no section reads as completed afterwards, then re-seed the stage
          // config from the new blueprint + record it (#664).
          return {
            planSections:          drop(s.planSections),
            planConfirmedSections: drop(s.planConfirmedSections),
            planAuthoredBlueprint: drop(s.planAuthoredBlueprint),
            planDeployConfig:      drop(s.planDeployConfig),
            planSourceConfig:      drop(s.planSourceConfig),
            planIntegrationConfig: drop(s.planIntegrationConfig),
            reposPublic:           drop(s.reposPublic),
            repoPublic:            dropRepoScoped(s.repoPublic, projectId),
            planInjectionAck:      drop(s.planInjectionAck),
            planSkippedSections:   drop(s.planSkippedSections),
            planKbAssignments:     drop(s.planKbAssignments),
            planAutomations:       drop(s.planAutomations),
            planFleet:             drop(s.planFleet),
            issueLinks:            drop(s.issueLinks),
            sectionGrades:         drop(s.sectionGrades),
            uiScreens:             drop(s.uiScreens),
            uiApproved:            drop(s.uiApproved),
            stagePreview:          drop(s.stagePreview),
            stagePipelineRuns:     drop(s.stagePipelineRuns),
            pinnedContext:         drop(s.pinnedContext),
            projectLocalRepos:     drop(s.projectLocalRepos),
            planStageConfig:    { ...s.planStageConfig, [projectId]: blueprintToStageConfig(bp) },
            projectBlueprintId: { ...s.projectBlueprintId, [projectId]: blueprintId },
          };
        }),
      addBlueprint: () => {
        const id = `bp-${Date.now().toString(36)}`;
        const bp: Blueprint = {
          id, name: "Untitled blueprint", desc: "New configuration",
          sections: [mkSection("context", { expanded: true })],
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
          const copy: Blueprint = { ...src, id: nid, name: `${src.name} copy`, sections: cloneSections(src.sections) };
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
      setBlueprintSections: (id, sections) => {
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
        const created: Blueprint = { ...bp, id, sections: cloneSections(bp.sections) };
        set((s) => ({ blueprints: [...s.blueprints, created] }));
        syncBlueprintFile(created);
        return id;
      },

      stagePipelineRuns: {},
      setStagePipelineRun: (projectKey, pipelineUid, state) =>
        set((s) => ({
          stagePipelineRuns: {
            ...s.stagePipelineRuns,
            [projectKey]: { ...(s.stagePipelineRuns[projectKey] ?? {}), [pipelineUid]: state },
          },
        })),
      stagePreview: {},
      setStagePreview: (projectKey, value) =>
        set((s) => ({ stagePreview: { ...s.stagePreview, [projectKey]: value } })),
      sectionGrades: {},
      setSectionGrade: (projectKey, sectionKey, result) =>
        set((s) => {
          const proj = s.sectionGrades[projectKey] ?? {};
          const prior = proj[sectionKey] ?? [];
          const next = [...prior.filter((g) => g.graderId !== result.graderId), result];
          return { sectionGrades: { ...s.sectionGrades, [projectKey]: { ...proj, [sectionKey]: next } } };
        }),
      uiScreens: {},
      addUiScreen: (projectKey, screen) =>
        set((s) => {
          const cur = s.uiScreens[projectKey] ?? [];
          if (cur.includes(screen)) return {} as Partial<typeof s>;
          return { uiScreens: { ...s.uiScreens, [projectKey]: [...cur, screen] } };
        }),
      uiApproved: {},
      setUiScreenApproved: (projectKey, screen, approved) =>
        set((s) => {
          const cur = s.uiApproved[projectKey] ?? [];
          const next = approved ? (cur.includes(screen) ? cur : [...cur, screen]) : cur.filter((x) => x !== screen);
          return { uiApproved: { ...s.uiApproved, [projectKey]: next } };
        }),

      planFleet: {},
      pinnedContext: {},
      togglePinnedContext: (projectId, name) =>
        set((s) => {
          const cur = s.pinnedContext[projectId] ?? [];
          const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
          return { pinnedContext: { ...s.pinnedContext, [projectId]: next } };
        }),
      setPlanFleet: (projectId, fleet) =>
        set((s) => ({ planFleet: { ...s.planFleet, [projectId]: fleet } })),
      planFleetTopology: {},
      setPlanFleetTopology: (projectId, topology) =>
        set((s) => ({ planFleetTopology: { ...s.planFleetTopology, [projectId]: topology } })),
      planFleetDirectorDrive: {},
      setPlanFleetDirectorDrive: (projectId, drive) =>
        set((s) => ({ planFleetDirectorDrive: { ...s.planFleetDirectorDrive, [projectId]: drive } })),
      addPlanAgentStream: (projectId, stream) =>
        set((s) => {
          const cur = s.planFleet[projectId] ?? emptyFleet();
          // Merge by id so re-emitted tags refine an existing stream in place.
          const streams = cur.streams.some((x) => x.id === stream.id)
            ? cur.streams.map((x) => (x.id === stream.id ? stream : x))
            : [...cur.streams, stream];
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      removePlanAgentStream: (projectId, id) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams: cur.streams.filter((x) => x.id !== id) } } };
        }),
      setPlanAgentStreamProfile: (projectId, streamId, profileId) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) => (x.id === streamId ? { ...x, profile: profileId ?? undefined } : x));
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      setPlanAgentStreamFlow: (projectId, streamId, patch) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, flow: normalizeFlow({ ...resolveFlow(x.flow), ...patch }) } : x);
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      setPlanAgentStreamModel: (projectId, streamId, model) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, model: model ?? undefined } : x);
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      setPlanAgentStreamStrategy: (projectId, streamId, strategy) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, strategy } : x);
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      setPlanAgentStreamPerm: (projectId, streamId, perm) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, perm: { ...perm }, preset: "custom" } : x);
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      setPlanAgentStreamPreset: (projectId, streamId, preset, perm) =>
        set((s) => {
          const cur = s.planFleet[projectId];
          if (!cur) return {};
          const streams = cur.streams.map((x) =>
            x.id === streamId ? { ...x, preset, perm: { ...perm } } : x);
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, streams } } };
        }),
      generateFleetProfiles: (projectId) =>
        set((s) => {
          const fleet = s.planFleet[projectId];
          if (!fleet) return {};
          const profiles = [...s.agentProfiles];
          const byId = new Set(profiles.map((pr) => pr.id));
          const streams = fleet.streams.map((stream) => {
            // Skip only if the stream already points at a profile that EXISTS. A
            // dangling reference (the planner assigned an id we never created) is
            // materialized here, keeping the assigned id so the reference stays stable.
            if (stream.profile && byId.has(stream.profile)) return stream;
            const commands = resolveAllowedCommands(
              s.allowedCommands,
              s.projectAllowedCommands[projectId],
              s.repoAllowedCommands[repoPromptKey(projectId, stream.repo)],
            );
            const gen = generateAgentProfile(stream, "worker", commands);
            const id = stream.profile || gen.id;
            if (!byId.has(id)) { profiles.push({ ...gen, id }); byId.add(id); }
            return { ...stream, profile: id };
          });
          return { agentProfiles: profiles, planFleet: { ...s.planFleet, [projectId]: { ...fleet, streams } } };
        }),
      setPlanFleetMeta: (projectId, recommended, reasoning, strategy) =>
        set((s) => {
          const cur = s.planFleet[projectId] ?? emptyFleet();
          return { planFleet: { ...s.planFleet, [projectId]: { ...cur, recommended, reasoning, strategy: strategy ?? cur.strategy } } };
        }),
      setPlanDirector: (projectId, enabled, role) =>
        set((s) => {
          const cur = s.planFleet[projectId] ?? emptyFleet();
          return {
            planFleet: {
              ...s.planFleet,
              [projectId]: { ...cur, director: { enabled, role: role ?? cur.director.role, drive: cur.director.drive } },
            },
          };
        }),
      setPlanDirectorDrive: (projectId, drive) =>
        set((s) => {
          const cur = s.planFleet[projectId] ?? emptyFleet();
          return {
            planFleet: {
              ...s.planFleet,
              [projectId]: { ...cur, director: { ...cur.director, drive } },
            },
          };
        }),
      clearPlanFleet: (projectId) =>
        set((s) => ({ planFleet: { ...s.planFleet, [projectId]: emptyFleet() } })),
      clearPlan: (key) =>
        set((s) => {
          const omitKey = <T,>(m: Record<string, T>): Record<string, T> => {
            const n = { ...m }; delete n[key]; return n;
          };
          return {
          planSections:          omitKey(s.planSections),
          planConfirmedSections: omitKey(s.planConfirmedSections),
          planAuthoredBlueprint: omitKey(s.planAuthoredBlueprint),
          planDeployConfig:      omitKey(s.planDeployConfig),
          planSourceConfig:      omitKey(s.planSourceConfig),
          planIntegrationConfig: omitKey(s.planIntegrationConfig),
          reposPublic:           omitKey(s.reposPublic),
          repoPublic:            dropRepoScoped(s.repoPublic, key),
          planInjectionAck:      omitKey(s.planInjectionAck),
          planSkippedSections:   omitKey(s.planSkippedSections),
          planKbAssignments:     omitKey(s.planKbAssignments),
          planAutomations:       omitKey(s.planAutomations),
          planStageConfig:       omitKey(s.planStageConfig),
          projectBlueprintId:    omitKey(s.projectBlueprintId),
          uiScreens:             omitKey(s.uiScreens),
          uiApproved:            omitKey(s.uiApproved),
          planFleet:             omitKey(s.planFleet),
          issueLinks:            omitKey(s.issueLinks),
          sectionGrades:         omitKey(s.sectionGrades),
          // rendered artifacts + planning context — the UI preview is "the ui" that must
          // also clear, plus pipeline run states and pinned context (#651).
          stagePreview:          omitKey(s.stagePreview),
          stagePipelineRuns:     omitKey(s.stagePipelineRuns),
          pinnedContext:         omitKey(s.pinnedContext),
          // clear means clear: unlink the project's repos so the repos stage resets (#664).
          projectLocalRepos:     omitKey(s.projectLocalRepos),
          };
        }),

});
