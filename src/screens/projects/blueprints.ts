// Blueprints (#513): named, reusable instances of the modular stage config (#512).
// The active blueprint seeds every new project's stage config; the library lets the
// user save/load/choose configurations. Pure — no React/Tauri — so it's testable
// and the store can seed from it directly.

import { defaultStageConfig, type StageConfig, type StageId } from "./planStages";

export interface Blueprint {
  id: string;
  name: string;
  description: string;
  /** The stage on/off + ordering this blueprint applies to new projects. */
  config: StageConfig;
  /** Built-in starter presets — editable but not deletable. */
  builtin?: boolean;
}

/** Deep-ish clone so a blueprint's config and a project's copy never alias. */
export function cloneStageConfig(c: StageConfig): StageConfig {
  return { enabled: { ...c.enabled }, order: [...c.order] };
}

/** Default config with a set of stages turned off. */
function configWith(off: StageId[]): StageConfig {
  const d = defaultStageConfig();
  return {
    enabled: { ...d.enabled, ...Object.fromEntries(off.map((id) => [id, false])) } as Record<StageId, boolean>,
    order: d.order,
  };
}

export const DEFAULT_BLUEPRINT_ID = "web-app";

/** Opinionated starter blueprints that also demonstrate the modularity. */
export function starterBlueprints(): Blueprint[] {
  return [
    { id: "web-app",     name: "Web app",     description: "React/Tauri web project — all stages on.", config: defaultStageConfig(), builtin: true },
    { id: "cli-tool",    name: "CLI tool",    description: "Command-line tool — no UI stage.",          config: configWith(["ui"]),  builtin: true },
    { id: "api-service", name: "API service", description: "Backend service — no UI stage.",            config: configWith(["ui"]),  builtin: true },
    { id: "3d-app",      name: "3D app",      description: "3D / graphics app — UI stage (3D mode).",   config: defaultStageConfig(), builtin: true },
  ];
}
