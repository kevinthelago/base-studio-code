// Role-scoped session capabilities (#219) — the TYPES + role→capability data + core accessors.
// This is the foundation layer of the role gate: the `SessionRole` union, the `RoleCapability`
// shape, the externalized role→capability TABLE, and the derivations that read that table
// (`roleCapability`, `hasScopedWriteCarveOut`). Command classification, write-path scoping, and
// the launch-wiring rules build on top of these (see `commandGate.ts`, `writeScope.ts`,
// `launchRules.ts`); the public surface is re-exported from `sessionRoles.ts`.
//
// The role→capability TABLE + the write-glob / db-owned / dep-manifest lists are externalized to
// `@data/permissions/role-capabilities.json` (#2027 P1) — the single source (Rust does NOT duplicate
// it: TS computes each session's permissions here and passes them to `ensure_session_settings`).
// This module keeps the TYPES + the exported const NAMES over that data.

import roleCapsEmbedded from "@data/permissions/role-capabilities.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

// The config-dir copy (#2047) overlays the embedded default — editable without a rebuild.
const roleCaps = overlayFile("permissions/role-capabilities.json", roleCapsEmbedded);

// Floor-merge on the EMBEDDED sets (#2325). `overlayFile` FULLY REPLACES the file with the config-dir
// copy, so a STALE override — seeded on a first run BEFORE the shipped default gained a role/list — would
// silently drop it. When code then reads that role at module load (e.g. `DOC_GLOBS =
// ROLE_DEFAULTS.documentor.writeGlobs`, #1555), the missing role is `undefined` and it throws
// `TypeError reading writeGlobs`, taking down the WHOLE UI. Basing every field on the embedded default
// guarantees each `SessionRole` (and each list) the code knows about is always present; the overlay
// still customizes/adds entries on top.
const roleDefaultsMerged = mergeRoleDefaults(roleCapsEmbedded.roleDefaults, roleCaps.roleDefaults);

/** Floor-merge role-default tables (#2325): `embedded` is the base (every shipped role), `overlaid` (the
 *  config-dir copy) customizes/adds on top. Exported so the regression test can prove a stale override
 *  MISSING a role still yields that role from the embedded floor (rather than `undefined` → the
 *  module-load `TypeError reading writeGlobs` that took down the UI). */
export function mergeRoleDefaults<T>(embedded: Record<string, T>, overlaid: Record<string, T>): Record<string, T> {
  return { ...embedded, ...overlaid };
}

export type SessionRole =
  | "planner" | "worker" | "director" | "triage"
  // Pipeline-stage roles (#220): tester runs build/tests, reviewer reads + reviews.
  // All are least-privilege (read-only, no code writes).
  | "tester" | "reviewer"
  // Issuer (#376): intake-only — shapes user requests into issues and may open GitHub
  // issues, but never touches code or git; routing is the director's job.
  | "issuer"
  // Juror (#394): a scoped reviewer that independently judges a landing against an
  // anchor (acceptance criteria / lens / subsystem slice). Read-only, like reviewer.
  | "juror"
  // Documentor (#1555): a post-refactor lifecycle actor that reconciles the project's PROSE
  // documentation (the CLAUDE.md structure tree, architecture docs, README) after a change lands.
  // It reads for context and writes ONLY prose docs — `code: "none"` with a DOC_GLOBS write
  // carve-out (like the director's commons, #851), so it can never touch feature code.
  | "documentor"
  // Designer (#2471): the Design Studio's heavily-restricted UI-kit session. Its ENTIRE surface is
  // the `bsc ui` CLI (kits live in the store, not files) — `none` on every axis: no git, no
  // GitHub, no file writes, no web. Launched with `restrictedAllow`, so the baseline command
  // tiers are suppressed and only `bsc ui` (+ the deprecated `bsc component` alias) auto-runs.
  | "designer";

/** Access to a capability: none < read < write. */
export type AccessTier = "none" | "read" | "write";

export interface RoleCapability {
  role: SessionRole;
  /** GitHub: `gh` writes / API mutations. */
  github: AccessTier;
  /** Local git: commit/push/merge are writes; status/log are reads. */
  git: AccessTier;
  /** Editing files on disk (outside any dedicated plan channel). */
  code: AccessTier;
  /** Network/web tools (`WebFetch`, `WebSearch`) — a live prompt-injection vector (#1107). `none`
   *  denies them outright at launch; `read` permits fetching, whose RESULTS the session must treat
   *  as untrusted data (the planner template frames this). This is the gate the per-agent `net`
   *  profile (#289) ties into; `write` is unused (there's no "network write" tool to grant). */
  net: AccessTier;
  /** Path globs this role/assignment may write. Empty ⇒ no code writes. */
  writeGlobs: string[];
}

// The role→capability table + the write-glob / db-owned / dep-manifest lists load from
// `@data/permissions/role-capabilities.json` (#2027 P1) — see the file's `_comment` for the policy.
// The exported names below keep the SAME semantics they always had:
//
// - ROLE_DEFAULTS — default capability per role. `writeGlobs` are filled per assignment (a worker
//   owns its stream's globs); the defaults are empty so a session with no assigned boundary can't
//   write code. The **planner is plan-only** — read-only git/GitHub; its code writes are scoped to
//   plan-section files ({@link PLANNER_WRITE_GLOBS}) so it never needs a prompt to write goal.md /
//   phases.json / fleet.json / prompts/*. `net: "read"` across the board preserves today's behavior
//   (WebFetch allowed via the broad Bash grant); a per-agent `net` profile (#289) or a planner
//   "no web" toggle (#1107) can set `none` to deny WebFetch/WebSearch at launch.
// - PLANNER_WRITE_GLOBS (#509) — the section files the planner writes directly (md sections, JSON
//   manifests, prompts/ + discovery/ #807). Derived from the planner role so the glob list lives once.
// - DB_OWNED_PLAN_FILES (#1070) — structured plan state that lives in plan.db, written ONLY via the
//   `bsc plan` CLI. {@link roleWriteRules} denies their FILE forms for the planner (deny > allow) so
//   its `*.md`/`*.json` glob can't auto-approve them; section files (goal.md, …) stay writable.
// - DEP_MANIFEST_FILES (#1111) — dependency manifests + lockfiles a WORKER must not hand-edit (a new
//   dep routes through the director). {@link roleWriteRules} denies the Edit/Write TOOLS on these
//   even inside the worker's owned globs; `npm install` / `cargo build` via Bash still regenerate them.
export const ROLE_DEFAULTS: Record<SessionRole, RoleCapability> = roleDefaultsMerged as Record<SessionRole, RoleCapability>;
export const PLANNER_WRITE_GLOBS: string[] = ROLE_DEFAULTS.planner?.writeGlobs ?? [];
export const DB_OWNED_PLAN_FILES: string[] = roleCaps.dbOwnedPlanFiles ?? roleCapsEmbedded.dbOwnedPlanFiles;
export const DEP_MANIFEST_FILES: string[] = roleCaps.depManifestFiles ?? roleCapsEmbedded.depManifestFiles;
// DOC_GLOBS (#1555) — the prose-documentation paths the DOCUMENTOR may write: top-level and nested
// markdown, the `docs/` tree, and README/CHANGELOG variants (incl. extension-less / .rst). Derived
// from the documentor role so the list lives once. Path-granular by design (see the boundary note in
// {@link hasScopedWriteCarveOut}): it grants markdown + docs and NOTHING with a code extension, so a
// documentor can reconcile structural/architectural docs but never edit `src/*.ts` / `*.rs` source.
export const DOC_GLOBS: string[] = ROLE_DEFAULTS.documentor?.writeGlobs ?? [];

/** A role capability, optionally narrowed/widened per assignment (e.g. writeGlobs). */
export function roleCapability(role: SessionRole, override: Partial<RoleCapability> = {}): RoleCapability {
  return { ...ROLE_DEFAULTS[role], ...override };
}

/** The `code: "none"` roles that carry an explicit, scoped write carve-out (a narrow allow layered
 *  onto an otherwise write-denied capability): the **director** (its commons globs, #851) and the
 *  **documentor** (its DOC_GLOBS prose docs, #1555). Every OTHER `code: "none"` role (triage, tester,
 *  reviewer, juror, issuer) stays fully write-denied even if handed globs — the stewardship can't be
 *  accidentally granted to a non-carve-out role. */
const CARVE_OUT_ROLES: ReadonlySet<SessionRole> = new Set<SessionRole>(["director", "documentor"]);

/**
 * Whether a capability has an explicit, scoped write carve-out (#851 / #1555): a `code: "none"` role
 * (no feature-code writes) that is nonetheless allowed to write EXACTLY the globs it owns and nothing
 * else — the **director** writes the commons globs (`.gitignore`, manifests, CI config, …) assigned to
 * it, the **documentor** writes its DOC_GLOBS prose docs. This mirrors the #304 precedent of a scoped
 * role-gate carve-out. Scoped to {@link CARVE_OUT_ROLES} on purpose: every OTHER `code: "none"` role
 * stays fully write-denied even if handed globs. An empty `writeGlobs` ⇒ no carve-out, full deny stands
 * (so a director without assigned commons keeps the full deny; the documentor ships DOC_GLOBS by
 * default, so its carve-out is active as launched).
 */
export function hasScopedWriteCarveOut(cap: RoleCapability): boolean {
  return CARVE_OUT_ROLES.has(cap.role) && cap.code === "none" && cap.writeGlobs.length > 0;
}
