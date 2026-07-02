// The dependency manifest (#1111/#1127): the authoritative, planner-owned list of the libraries every
// repo depends on, defined ONCE during planning so the fleet doesn't each add/redefine deps in
// parallel worktrees and collide at integration. The planner records it via `bsc-plan deps set` into
// plan.db (#1191 — was a raw `dependencies.json`); the poll reflects the stored manifest into the
// DEPENDENCIES section, the Dependencies gate reads its count, publish pre-populates each repo's real
// `package.json` / `Cargo.toml` from it, and each worker's CLAUDE.local.md inlines the locked set with
// a "don't touch the manifests" guardrail. This module stays a pure + tolerant manifest model (it
// parses the same shape whether it arrives from plan.db or a legacy file) — no React/Tauri.
//
// BARREL (#2148): the model was decomposed into colocated sibling modules; this file preserves the
// original public API so every importer keeps working unchanged. Each concern lives in its own module:
//   · dependencyTypes           — the manifest types + section key
//   · dependencyParse           — parsing + the per-repo / per-ecosystem selectors
//   · dependencySources         — grouping deps by their source registry (Deploy pane, #1127)
//   · dependencyStreams         — the per-stream shared-dependencies view (Streams pane, #1429)
//   · dependencyManifests       — the publish-time package.json / Cargo.toml writers
//   · dependencyRegistryConfig  — the .npmrc / .cargo/config.toml writers
//   · dependencyWorkerBlock     — the CLAUDE.local.md locked-deps block

export {
  DEPENDENCIES_KEY,
  type DependencyEcosystem,
  type PlanDependency,
  type DependencyRegistry,
  type DependencyManifest,
} from "@/features/planner/issues/dependencyTypes";

export {
  parseDependencyManifest,
  parseDependenciesFile,
  depsForRepo,
  bucketByEcosystem,
} from "@/features/planner/issues/dependencyParse";

export {
  type DependencySourceGroup,
  groupDependenciesBySource,
} from "@/features/planner/issues/dependencySources";

export {
  type StreamDependency,
  type StreamDepGroup,
  type SharedRepoDeps,
  sharedRepoDependencies,
  unlockedSharedRepos,
} from "@/features/planner/issues/dependencyStreams";

export {
  mergeIntoPackageJson,
  mergeIntoCargoToml,
} from "@/features/planner/issues/dependencyManifests";

export {
  buildNpmrc,
  buildCargoConfig,
} from "@/features/planner/issues/dependencyRegistryConfig";

export {
  buildWorkerDependencyBlock,
} from "@/features/planner/issues/dependencyWorkerBlock";
