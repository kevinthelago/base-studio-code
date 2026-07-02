// The dependency manifest (#1111/#1127): the authoritative, planner-owned list of the libraries every
// repo depends on, defined ONCE during planning so the fleet doesn't each add/redefine deps in
// parallel worktrees and collide at integration. The planner records it via `bsc-plan deps set` into
// plan.db (#1191 — was a raw `dependencies.json`); the poll reflects the stored manifest into the
// DEPENDENCIES section, the Dependencies gate reads its count, publish pre-populates each repo's real
// `package.json` / `Cargo.toml` from it, and each worker's CLAUDE.local.md inlines the locked set with
// a "don't touch the manifests" guardrail. This module stays a pure + tolerant manifest model (it
// parses the same shape whether it arrives from plan.db or a legacy file) — no React/Tauri.

/** The dependency-manifest section key. The stored manifest (`{ dependencies, registries }`) is
 *  DB-owned (#1191): the poll mirrors `plan_get_deps` here. Surfaced by the poll like `features.json`;
 *  not rendered as a plan section. The legacy `dependencies.json` file shares this key during the
 *  one-time import. */
export const DEPENDENCIES_KEY = "dependencies";

/** A package-manager ecosystem the manifest can target. */
export type DependencyEcosystem = "npm" | "cargo";

/** One locked dependency: which repo + ecosystem it belongs to, its name + version, and why. */
export interface PlanDependency {
  /** `owner/repo` this applies to. Absent ⇒ applies to every repo of its ecosystem. */
  repo?: string;
  /** The package manager this dependency installs through. */
  ecosystem: DependencyEcosystem;
  /** Package / crate name. */
  name: string;
  /** Version range (npm: `^1.2.0`) or version (cargo: `1.2`). Absent ⇒ `*` / latest. */
  version?: string;
  /** A development-only dependency (devDependencies / [dev-dependencies]). */
  dev?: boolean;
  /** One-line rationale — surfaced in the worker manifest so the choice is legible. */
  why?: string;
  /** The registry this is fetched from (#1127) — a KEY into the manifest's `registries` map. Absent
   *  ⇒ the ecosystem's public default (npm registry / crates.io). A non-public source generates the
   *  registry config (`.npmrc` / `.cargo/config.toml`) at publish. */
  source?: string;
  /** The fleet STREAM that declared this dep (#1429). When 2+ streams build the same repo, deps are
   *  declared per stream and reconciled into the repo's single lock; the Streams pane surfaces them
   *  per stream and flags version-locked overlaps. Absent ⇒ a repo-level (unattributed) dep. */
  stream?: string;
}

/** A non-default registry a dependency is fetched from (#1127). The `auth` token's VALUE lives in the
 *  host vault — only its secret NAME is recorded here (and as a deploy secret). */
export interface DependencyRegistry {
  /** Registry base URL (npm) / index URL (cargo). */
  url: string;
  /** npm scope this registry serves (e.g. `@acme`). Absent ⇒ the npm default registry. Ignored by cargo. */
  scope?: string;
  /** Name of the auth-token secret (value lives in the host vault; recorded as a deploy secret). */
  auth?: string;
}

/** The full dependency manifest (#1127): the locked libraries plus the non-default registries they
 *  come from, keyed by the `source` each dependency references. */
export interface DependencyManifest {
  dependencies: PlanDependency[];
  registries: Record<string, DependencyRegistry>;
}
