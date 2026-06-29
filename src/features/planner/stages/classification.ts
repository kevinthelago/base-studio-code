// Discovery classification signal types (#1395).
//
// The Discovery phase characterizes a project into a small set of SIGNALS. These types describe the
// shape of that signal set; `blueprints.ts` carries a `ClassificationSignals` on a blueprint. Pure
// (no React / store / Tauri).

export type Lifecycle = "greenfield" | "transform" | "harden" | "maintain";
export type Workspace = "ui" | "cli" | "api" | "service" | "library" | "data";
export type ServiceTopology = "none" | "split" | "combine";
export type DeployKind = "none" | "static" | "serverless" | "container" | "service";

/** Discovery's classification output (#1395) — the project's lifecycle, surfaces, and a few counts.
 *  Planner-set as it learns, plus counts derived from plan state. Carried on a blueprint. */
export interface ClassificationSignals {
  lifecycle: Lifecycle;
  /** ⊆ {ui, cli, api, service, library, data} — what the project exposes. */
  surfaces: Workspace[];
  provenance: "new" | "existing";
  migration: boolean;
  dataModel: boolean;
  serviceTopology: ServiceTopology;
  deploy: DeployKind;
  compliance: boolean;
  // derived from plan state:
  featureCount: number;
  repoCount: number;
  streamCount: number;
}
