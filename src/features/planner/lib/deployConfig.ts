// Deployment & infrastructure config (#919; per-repo rework #1421) — the data model behind the
// planner's Deployment stage (right after Repos). Pure (no React/Tauri) so the readiness checks that
// drive the stage gate are unit-testable.
//
// Split into focused modules (#1639); this barrel re-exports the full public surface so importers
// don't churn:
//   - deployPlatforms.ts — the deploy-target catalog (platforms, workloads, git hosts, orchestrators)
//   - deployEnv.ts       — per-service building blocks (envs, pipeline, config/secrets, release,
//                          health, local-mode option lists) + the default builders
//   - deployServices.ts  — the DeployService/DeployConfig model + readiness checks + gate + issues
//   - deployCoerce.ts    — the planner channel (coerceDeployConfig + parseDeployConfigTag)

export * from "./deployPlatforms";
export * from "./deployEnv";
export * from "./deployServices";
export * from "./deployCoerce";
