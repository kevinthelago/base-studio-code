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
  const out: Record<string, T> = { ...embedded };
  for (const [role, over] of Object.entries(overlaid)) {
    const base = embedded[role];
    if (!base || typeof base !== "object" || typeof over !== "object" || !over) {
      out[role] = over;              // a role the shipped app doesn't know — the overlay owns it whole
      continue;
    }
    // FIELD-level floor, not role-level (#4108). The role-level `{...embedded, ...overlaid}` above meant
    // a mirror that HAS the role replaced its entry wholesale — so a mirror written before a field
    // existed silently dropped it.
    out[role] = { ...base, ...over, ...floorLists(base, over), ...clampTiers(base, over) } as T;
  }
  return out;
}

/**
 * CEILING on the access tiers: a config-dir mirror may NARROW a tier but never exceed the tier the
 * shipped app grants. The precise inverse of {@link floorLists}, and it exists for the same reason —
 * `config/` is seeded ONCE and never refreshed, so every existing install is frozen at whatever
 * shipped the day it first ran.
 *
 * The consequence without this clamp is not cosmetic. When the director's shipped tiers were narrowed
 * to `git: read` / `github: read`, every install carrying a mirror written before that change kept
 * `write` on both — so the narrowing shipped, passed its tests, and applied to nobody. A security
 * default that a stale file can silently revert is not a default.
 *
 * Narrowing is deliberately still allowed: the documented contract is that a user may tighten a role,
 * and tightening is safe by construction. Only the widening direction is clamped.
 *
 * `writeGlobs` is handled here too, in the one direction that matters: an EMPTY overlay list falls
 * back to the shipped globs. An empty list is indistinguishable from a mirror written before the role
 * had a boundary at all, and that is exactly the case that bites — the director gained `code: "write"`
 * plus its plan-file globs in the same change, so a mirror supplying `[]` would leave it able to write
 * with no boundary defined. A NON-empty overlay list still wins, so a user's real narrowing survives.
 */
function clampTiers(base: object, over: object): Record<string, unknown> {
  // Declared INSIDE the function on purpose. `mergeRoleDefaults` is called at module load (the
  // `roleDefaultsMerged` const above), which is before any module-scope `const` below it has
  // initialized — hoisting the two tables out would reintroduce a `ReferenceError: Cannot access
  // 'TIER_FIELDS' before initialization` that takes the whole role table (and so the UI) down at boot.
  // `floorLists` escapes this only because it has no const dependencies. Do not "tidy" these upward.
  const TIER_RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
  const TIER_FIELDS = ["github", "git", "code", "net", "ui"] as const;
  const b = base as Record<string, unknown>;
  const o = over as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of TIER_FIELDS) {
    const bv = b[f], ov = o[f];
    if (typeof bv !== "string" || typeof ov !== "string") continue;
    if ((TIER_RANK[ov] ?? 0) > (TIER_RANK[bv] ?? 0)) out[f] = bv;
  }
  const bg = b.writeGlobs, og = o.writeGlobs;
  if (Array.isArray(bg) && bg.length > 0 && Array.isArray(og) && og.length === 0) out.writeGlobs = bg;
  return out;
}

/** Fields where the SHIPPED value is a floor a stale mirror must not be able to revoke (#4108).
 *
 *  `config/` is seeded ONCE — `ensure_seeded` writes "only files that are ABSENT so a user edit is never
 *  clobbered" — and never refreshed. So on every existing install the mirror is frozen at whatever the
 *  app shipped the day it was first run, and a later capability grant is invisible forever. That is not
 *  hypothetical: the librarian's `projects` harvest root (#4108) landed in the packaged default and was
 *  dropped by a mirror still carrying `['app-repo']`, which is the whole reason the Algorithms studio
 *  could not see `mobile-studio-code`.
 *
 *  UNION rather than replace, and ONLY for `harvestRoots`: a harvest root widens READ-only scan reach
 *  that the shipped app decides (there is no UI to edit it), so a mirror can ADD one but never revoke
 *  one. Write-bearing fields — `writeGlobs`, the access tiers — are deliberately NOT floored here: those
 *  a user may legitimately narrow, and silently widening them would be the opposite mistake. */
function floorLists(base: object, over: object): Record<string, unknown> {
  const b = (base as { harvestRoots?: string[] }).harvestRoots;
  const o = (over as { harvestRoots?: string[] }).harvestRoots;
  if (!b?.length) return {};
  return { harvestRoots: [...b, ...(o ?? []).filter((r) => !b.includes(r))] };
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
  | "designer"
  // Architect (#2755, retasked as the funnel's front door): tier 1 — the ONLY session that talks to
  // the user. It runs DISCOVERY (goal, users, scope, stack, … one topic at a time) and captures the
  // AUTHORITY the tiers below cite when they decide unattended, then hands both down to a director.
  // Its capability row is UNCHANGED by that retasking, which is why this role was reused rather than a
  // new one minted: `none` on every axis (no git, no GitHub, no file writes, no web) with `ui: none`,
  // launched `restrictedAllow` so the baseline command tiers stay suppressed. That is not merely
  // convenient — the front door ingests raw user prose, so it is the highest prompt-injection surface
  // in the system, and being the LEAST capable session is a property worth keeping deliberately.
  // Its auto-runnable surface is exactly its grant list below: `bsc plan requirement` (the one thing it
  // writes), `bsc plan brief` (its one outbound channel, director-only), plus the transitional
  // `bsc teams`/`bsc persona` it still holds until team design moves to the director.
  | "architect"
  // Librarian (#2787): the Algorithms tab's heavily-restricted knowledge-store session. Like the
  // designer/architect it is `none` on every axis (no git, no GitHub, no file writes, no web) and
  // `ui: none`. Launched with `restrictedAllow`, so the baseline command tiers are suppressed and only
  // `bsc graph` auto-runs. The Algorithms graph stays the read-only viewer; the librarian stores +
  // curates the knowledge graph (nodes, relationships, the reality lens) via that one CLI.
  | "librarian"
  // Sound-designer (#3369, epic #3071 phase 4): the Sounds tab's heavily-restricted sound-kit
  // authoring session. Like the designer/architect/librarian it is `none` on every axis (no git, no
  // GitHub, no file writes, no web) and `ui: none` — a sound is a synthesis DESCRIPTOR in the store,
  // not a file, and not a UI kit. Launched with `restrictedAllow`, so the baseline command tiers are
  // suppressed and only `bsc sound` auto-runs. The Sounds graph stays the read-only viewer; the
  // sound-designer authors primitives, voices, cues and kits through that one CLI.
  // NOTE the name shares a word with `designer` but is a DISTINCT role — nothing may treat the two
  // as interchangeable (a `startsWith`/`includes` check on the role would silently conflate them).
  | "sound-designer"
  // Debugger (#3322): the app's OWN full-capability maintenance session — fixes the `bsc ui` tooling the
  // designer reports via `bsc request` (#3298). Broad app-maintenance caps (git+github+code+ui write); the
  // session actually launches full-cap/bypass on TerminalHost via `DebugSessionMount` (the always-bypass
  // `isFullCapabilitySession` carve-out, role-less — #3326), so this table entry backs its graph identity +
  // any generic role→profile surface, not the live session's gate.
  | "debugger"
  // Marketer (#2431): the opt-in marketing persona's role — takes the market-research stage's
  // artifacts and drafts in-repo collateral (landing/README copy, launch posts, SEO content,
  // release announcements). Least-privilege like `documentor`: `code: "none"` with a marketing-content
  // write carve-out (markdown/mdx under `marketing/`/`content/` + README/CHANGELOG), so it can never
  // touch feature code; outward (third-party) publishing is out of v1.
  | "marketer"
  // Curator (#3092, epic #3087): the reusable-library lifecycle actor — the library analog of the
  // `documentor`. After a change lands it HARVESTS the reusable components/algorithms the fleet built
  // into the GLOBAL stores (not already present), then OPTIMIZES the graph via the command
  // (`bsc ui doctor --fix`). Scoped write to the STORES only — `ui: "write"` (the component/kit store)
  // + `bsc graph` via the restricted allow-list — with `code: "none"` and `git: "read"` (to read the
  // landed repo it harvests from). It never touches project files or GitHub. Distinct from the
  // `librarian` (the standing Algorithms-Studio session): the curator is a FLEET post-landing actor.
  | "curator"
  // Integrator (#4023): the Integration Studio's session — builds and MAINTAINS an integration with an
  // existing application or API. Its store surface is `bsc data connector` (the runtime REST connector
  // presets), so like its studio siblings it is `none` on git/GitHub/code/ui with a `scratch/**` carve-out
  // and launches `restrictedAllow`. THE ONE DIFFERENCE: `net: "read"`. Every other studio is `net: "none"`,
  // but this role's work STARTS at the vendor's documentation — it cannot author a manifest for an API it
  // is not allowed to read about. That widening is deliberate and is the only one: it reads docs and probes
  // endpoints read-only, and still cannot write a repo file, reach git, or touch GitHub.
  | "integrator";

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
  /** The `bsc ui` component/kit store (#2470): `read` lets a session use the kit it builds against
   *  but never redefine it (the mutating verbs — `bsc ui set`/`remove`/`kit set`/`kit remove` and
   *  the deprecated `bsc component` alias — are denied at launch, {@link roleDeniedCommands});
   *  `none` denies `bsc ui` outright; `write` is the designer's tier. Same philosophy as the
   *  dep-manifest lock (#1111): nobody but the designated role mutates the shared contract. */
  ui: AccessTier;
  /** Path globs this role/assignment may write. Empty ⇒ no code writes. */
  writeGlobs: string[];
  /** SYMBOLIC roots this role may HARVEST from (#3509) — read-only, and deliberately NOT paths: a role
   *  is machine-independent, so it declares INTENT (`app-repo`) and the launch resolves it. Widens only
   *  what `bsc ui harvest` / `bsc graph harvest` may SCAN; it grants no write anywhere, which is the
   *  whole point — a kit-only session can mine a repo it may not write to. Empty ⇒ harvest stays bound
   *  to the session's own confinement root, exactly as before. */
  harvestRoots?: string[];
}

/** The symbolic harvest root meaning "the base-studio-code source tree this app was built from". The
 *  only token today; resolution is the launch's job ({@link buildAgentEnv}), since a role cannot know
 *  a machine's paths. */
export const HARVEST_ROOT_APP_REPO = "app-repo";

/** The symbolic harvest root meaning "the `~/.base-studio-code/projects/` tree — every downloaded
 *  project repo". Resolved by the launch to `<bscBaseDir>/projects` (#3664), so a UI/logic session can
 *  mine components from the OTHER repos, not just the app's own source. Read-only like every harvest
 *  root — the whole `projects/` tree is readable, but writes stay confined to the session's workspace. */
export const HARVEST_ROOT_PROJECTS = "projects";

// The role→capability table + the write-glob / db-owned / dep-manifest lists load from
// `@data/permissions/role-capabilities.json` (#2027 P1) — see the file's `_comment` for the policy.
// The exported names below keep the SAME semantics they always had:
//
// - ROLE_DEFAULTS — default capability per role. `writeGlobs` are filled per assignment (a worker
//   owns its stream's globs); the defaults are empty so a session with no assigned boundary can't
//   write code. The **planner is plan-only** — read-only git/GitHub; its code writes are scoped to
//   plan-section files ({@link PLAN_WRITE_GLOBS}) so it never needs a prompt to write goal.md /
//   phases.json / fleet.json / prompts/*. `net: "read"` across the board preserves today's behavior
//   (WebFetch allowed via the broad Bash grant); a per-agent `net` profile (#289) or a planner
//   "no web" toggle (#1107) can set `none` to deny WebFetch/WebSearch at launch.
// - PLAN_WRITE_GLOBS (#509) — the section files the planner writes directly (md sections, JSON
//   manifests, prompts/ + discovery/ #807). Derived from the planner role so the glob list lives once.
// - DB_OWNED_PLAN_FILES (#1070) — structured plan state that lives in plan.db, written ONLY via the
//   `bsc plan` CLI. {@link roleWriteRules} denies their FILE forms for the planner (deny > allow) so
//   its `*.md`/`*.json` glob can't auto-approve them; section files (goal.md, …) stay writable.
// - DEP_MANIFEST_FILES (#1111) — dependency manifests + lockfiles a WORKER must not hand-edit (a new
//   dep routes through the director). {@link roleWriteRules} denies the Edit/Write TOOLS on these
//   even inside the worker's owned globs; `npm install` / `cargo build` via Bash still regenerate them.
export const ROLE_DEFAULTS: Record<SessionRole, RoleCapability> = roleDefaultsMerged as Record<SessionRole, RoleCapability>;

/** The plan-section files the PLANNING session writes directly (md sections, JSON manifests,
 *  `prompts/`, `discovery/`). Derived from the **director** row, which now carries the planning
 *  surface: planning and directing were the same actor at different phases of one project, so the
 *  capability moved rather than being duplicated. Renamed from `PLANNER_WRITE_GLOBS` because the
 *  globs are no longer the planner role's. */
export const PLAN_WRITE_GLOBS: string[] = ROLE_DEFAULTS.director?.writeGlobs ?? [];
export const DB_OWNED_PLAN_FILES: string[] = roleCaps.dbOwnedPlanFiles ?? roleCapsEmbedded.dbOwnedPlanFiles;
export const DEP_MANIFEST_FILES: string[] = roleCaps.depManifestFiles ?? roleCapsEmbedded.depManifestFiles;
// DOC_GLOBS (#1555) — the prose-documentation paths the DOCUMENTOR may write: top-level and nested
// markdown, the `docs/` tree, and README/CHANGELOG variants (incl. extension-less / .rst). Derived
// from the documentor role so the list lives once. Path-granular by design (see the boundary note in
// {@link hasScopedWriteCarveOut}): it grants markdown + docs and NOTHING with a code extension, so a
// documentor can reconcile structural/architectural docs but never edit `src/*.ts` / `*.rs` source.
export const DOC_GLOBS: string[] = ROLE_DEFAULTS.documentor?.writeGlobs ?? [];

/** A role capability, optionally narrowed/widened per assignment (e.g. writeGlobs).
 *
 *  Field-level floor (#2470, the per-FIELD companion to the per-ROLE floor-merge #2325):
 *  `mergeRoleDefaults` floors missing ROLES, but an overlaid role OBJECT fully replaces the embedded
 *  one — so a STALE config-dir override seeded before a field shipped (e.g. `ui`) leaves that field
 *  `undefined` on the merged entry. Defaults are prepended here so every capability handed to the
 *  launch wiring carries a value; the table (and any explicit `override`) still wins when present. */
export function roleCapability(role: SessionRole, override: Partial<RoleCapability> = {}): RoleCapability {
  const merged = { ...ROLE_DEFAULTS[role], ...override };
  return { ...merged, ui: merged.ui ?? "read" };
}

/** The `code: "none"` roles that carry an explicit, scoped write carve-out (a narrow allow layered
 *  onto an otherwise write-denied capability): the **director** (its commons globs, #851), the
 *  **documentor** (its DOC_GLOBS prose docs, #1555), and the **marketer** (its marketing-content globs,
 *  #2431). Every OTHER `code: "none"` role (triage, tester, reviewer, juror, issuer, designer) stays
 *  fully write-denied even if handed globs — the stewardship can't be accidentally granted to a
 *  non-carve-out role. */
const CARVE_OUT_ROLES: ReadonlySet<SessionRole> = new Set<SessionRole>([
  // The DIRECTOR was removed here (#funnel-planning-moves-to-director). Its commons carve-out existed
  // only because the director was the one non-worker session holding a project hub, so the repo-root
  // commons had nowhere else to live. The commons are now a worker STREAM with an owner, a branch and
  // a worktree — and the director itself is `code: "write"` scoped to plan files, so it no longer
  // qualifies for a `code: "none"` carve-out at all.
  "documentor", "marketer",
  // The RESTRICTED studio sessions (#3373). Their carve-out is not project content at all — it is a
  // single sealed SCRATCH dir inside their own workspace (`scratch/**`), the staging area for a payload
  // they then apply with `bsc <store> set --file <name>`. They need it because a heredoc cannot be
  // allow-listed (newlines are command separators), which left them unable to author anything.
  //
  // This is a NARROWER grant than it looks: `bsc-confine` already pins their file tools to the session
  // cwd (their own workspace), `bsc-scope` then pins writes to `scratch/**` within it, `--file` reads
  // only bare names from that same dir, and the dir is wiped at every launch. They still cannot touch
  // project code, their own `CLAUDE.md`, or `.claude/**` (denied on every pane).
  "designer", "architect", "librarian", "sound-designer",
]);

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

/** Roles whose launch grants a FIXED store-CLI auto-run surface on top of the profile — the bundled
 *  `bsc` subcommands they drive, regardless of the project (#3095, epic #3087). A non-empty entry ALSO
 *  drives `restrictedAllow` (#3098): the wrapped commands become the session's ONLY auto-run Bash
 *  surface (the baseline git/build/read-only tiers are suppressed).
 *
 *  THE ROLE IS THE SOURCE OF TRUTH for a restricted session's confinement. The standing-tab studio
 *  sessions (designer / librarian / architect) used to pin their surface inside their own launch hooks,
 *  which meant the SAME role produced a different (much wider) gate on any other launch path — moving
 *  them here makes the confinement travel with the role wherever the session is launched from (the
 *  bespoke hook, a fleet launch, or the shared TerminalHost).
 *   • designer   — the `bsc ui` component surface (+ the deprecated `bsc component` alias), the
 *                  preview-only screenshot, the design loop, and the designer→debug request channel.
 *   • librarian  — the algorithms graph store, plus READ-ONLY lookup into the component store (#4090).
 *   • sound-designer — the sound-kit store (synthesis descriptors: primitives, voices, cues, kits).
 *   • architect  — the teams + persona (agent-identity) stores.
 *   • curator    — the post-landing harvest + graph-optimize actor (fleet-launched). */
/**
 * The loop verbs a studio surface may run as a PARTICIPANT in a `bsc loop` (#3262) — every studio can
 * open a loop and converse in it.
 *
 * `bsc loop stop` is deliberately ABSENT. It is the only way to halt an `--until false` (infinite) loop,
 * and the CLI withholds it from participants on purpose — a separate verb from `say` precisely so a
 * participant cannot reach it. Granting the bare `"bsc loop"` prefix would expand to `Bash(bsc loop *)`
 * and match `bsc loop stop`, handing the session the halt verb and letting it end the very loop it is
 * supposed to run forever. Enumerating the participant verbs keeps the CLI's invariant intact through
 * the permission layer; halting stays with the user and the debug session.
 */
const LOOP_PARTICIPANT_COMMANDS = [
  "bsc loop new",
  "bsc loop say",
  "bsc loop watch",
  "bsc loop show",
  "bsc loop list",
] as const;

const RESTRICTED_ROLE_COMMANDS: Partial<Record<SessionRole, readonly string[]>> = {
  curator: ["bsc ui", "bsc graph", ...LOOP_PARTICIPANT_COMMANDS],
  designer: [
    "bsc ui",
    "bsc component",
    "bsc shot preview",
    ...LOOP_PARTICIPANT_COMMANDS,
    "bsc request new",
    "bsc request list",
  ],
  // #4090: the two READ verbs of the component store, never the `bsc ui` prefix — that would also carry
  // `set`/`remove`. The librarian curates the ALGORITHMS library and needs one question answered about
  // the other graph — "is this candidate already a component?" — so the two harvests partition the tree
  // instead of both claiming it (`bsc graph harvest` sweeps in React components today). Writes stay
  // denied by `ui: "read"` (→ UI_WRITE_DENY), which is the half that makes read-only true: the grant
  // table governs AUTO-RUN, not reachability.
  librarian: [
    "bsc graph",
    "bsc ui list",
    "bsc ui get",
    ...LOOP_PARTICIPANT_COMMANDS,
    "bsc request new",
    "bsc request list",
  ],
  // #4023: the connector store IS the integration library — `probe`/`validate`/`try`/`map` are the
  // authoring dev-loop and `add`/`remove`/`list`/`get` the store, all under the one prefix.
  integrator: ["bsc data connector", ...LOOP_PARTICIPANT_COMMANDS, "bsc request new", "bsc request list"],
  "sound-designer": ["bsc sound", ...LOOP_PARTICIPANT_COMMANDS, "bsc request new", "bsc request list"],
  architect: [
    "bsc teams",
    "bsc persona",
    // #funnel-generalize-brief-channel — the architect's ONE outbound channel. The architect is
    // `restrictedAllow`, so this list IS its auto-runnable surface: without this it could not reach a
    // director at all. It is the bsc VERB, not the `bsc-brief` shell helper, because every entry on a
    // restricted surface must be a `bsc ` store verb — a shell function here would break the invariant
    // sessionRoles.test.ts pins. Where a brief may LAND is constrained separately in briefRouting: the
    // grant says what it can RUN, the routing says who may RECEIVE.
    "bsc plan brief",
    // #requirement-and-authority-store — the architect's handoff: the user's statement, the discovery
    // it ran, and the AUTHORITY clauses the tiers below cite. Scoped to the one noun, so the architect
    // still cannot reach issues, features, the fleet or any other plan state.
    "bsc plan requirement",
    // The architect's window onto the tier below it, AND its one create into that tier.
    //
    // #architect-sees-director-state gave the READ (`bsc fleet directors`) and framed it as read-only:
    // "seeing is not reaching". #architect-creates-a-director-with-discovery SUPERSEDES that framing —
    // the architect does create directors. What survives is the read, which gets more useful rather
    // than less: an architect that can create one needs to see which already run first.
    //
    // The singular verb covers BOTH (`directors` shares its prefix), and still stops short of
    // `bsc fleet wake` — waking a WORKER is the director's lever, not the architect's, and an
    // architect reaching past its director is back in the middle of a fleet it does not run.
    //
    // Creation is ADDITIVE, which is exactly why it is allowed while stopping is not: `bsc fleet
    // director` has no `stop`, and the CLI refuses one by name rather than by omission.
    "bsc fleet director",
    // #architect-starts-and-stops-system-sessions — the architect's lever over the app's OWN studios:
    // start · stop · list the designer, librarian, sound-designer and integrator.
    //
    // WHY THIS IS SAFE TO GRANT A SESSION THAT READS RAW USER PROSE. The architect is `none` on every
    // axis precisely because it is the highest prompt-injection surface in the system, and being the
    // least capable session used to be the whole mitigation. The replacement is one property — THE
    // ARCHITECT CAN ONLY CAUSE WHAT A USER CLICKING IN THE APP CAN ALREADY CAUSE — held up by three
    // things, all of which have to stay true if this grant is ever widened:
    //   a. The argument is an ENUM, not a string: `bsc session` resolves its id against a closed
    //      app-owned registry (and the APP re-resolves it, since the channel dir is writable by
    //      anything). No verb here takes a command, a path, or prose that becomes execution.
    //   b. No escalation through what it starts: a started session keeps its OWN role gate, so
    //      starting the designer yields a designer confined to `bsc ui`. The reachable capability set
    //      is the union of the fixed personas' gates — every one already one click away.
    //   c. The lever list IS the grant list: the full verb, never a prefix.
    // Consequence worth stating plainly: this reaches SYSTEM sessions only. A director is not
    // expressible in the verb's argument space, so `stop` can never end one — a director coordinates a
    // running fleet whose workers, under the no-app-injection model, have no route back except the
    // user's click.
    "bsc session",
    // #architect-starts-a-new-project — creation begins where the conversation is, instead of the
    // architect having to hand the user back to the UI to start what they just agreed on.
    //
    // THE FULL VERB, never the `bsc project` prefix: that would also carry `published`, `triaged` and
    // `db` — read/write access to every project's lifecycle markers, which is a much larger surface
    // than "make a new one".
    //
    // Its argument is free text rather than an id from a closed registry, so the containment is the
    // SLUG: `projectSlug(name)` is `[a-z0-9-]`, capped at 60 and never empty, and the hub is always
    // `projects/<slug>/`. Prose cannot reach outside that directory — `../../etc/passwd` becomes
    // `etc-passwd`. `projectSlug.fixtures.json` pins the rule across both implementations of it.
    "bsc project new",
    // #architect-wires-project-relationships — the inter-app CONTRACTS between those projects
    // (#2253/#3786): `link list` / `add` / `set` / `remove`. The architect creates the projects, and
    // the relationships BETWEEN them are the same act one level up. Nothing else could perform it
    // either: the Glance right pane that used to draw them was retired, so before this grant the only
    // way to edit a contract was to hand-edit `project-links.json`.
    //
    // THE FULL VERB, never the `bsc project` prefix, for exactly the reason stated above it.
    //
    // ITS CONTAINMENT IS A DIFFERENT ARGUMENT FROM `new`'s, so it is made rather than inherited.
    // `new`'s free text is contained by the slug because it names a DIRECTORY. These arguments name
    // nothing on disk: `from` / `to` / `--name` / `--url` become JSON string VALUES inside one fixed
    // global file whose path comes from the base dir and never from an argument, while `kind` and
    // `--target-type` are closed enums the CLI rejects outside of. The worst an injected string can do
    // is record a contract that is not true — visible in Glance, undone by one `link remove`, and
    // reaching no filesystem, process or network.
    "bsc project link",
    // #architects-own-projects — which architect OWNS a project. An architect holds a SET of projects
    // (the networking one takes the LAN/WAN apps), and this verb is the ONLY way that is ever set:
    // there is deliberately no picker in the UI, so if this grant is absent the feature has no surface
    // at all rather than a slower one.
    //
    // Reaching other architects is the point, not a leak — naming and assignment are both things one
    // architect does on behalf of the set. The blast radius is bounded by what the verb can express:
    // it moves a project between EXISTING architect personas and cannot create, delete or re-role one.
    // `set` refuses a persona that is not an architect, so the reachable states are exactly the
    // assignments a user could already have asked for.
    "bsc project architect",
    // Discovery for the verbs above, and the reason it is granted rather than assumed: the
    // architect's own spec tells it to discover before it changes and never to guess an id, and it
    // cannot follow that rule against a store it cannot read — wiring `a → b` blind would invent
    // contracts between projects that do not exist. Read-only and the FULL verb; `bsc project list`
    // prints key + published + path and mutates nothing.
    "bsc project list",
    ...LOOP_PARTICIPANT_COMMANDS,
    "bsc request new",
    "bsc request list",
  ],
};

/** The global tooling-request queue (`crates/bsc-request`, #3295) — the designer->debug channel,
 *  drained by a FULL-CAPABILITY session that edits base-studio-code itself. */
export const TOOLING_REQUEST_COMMAND = "bsc request";

/**
 * May this role reach the global tooling-request queue (#4000)?
 *
 * DERIVED from the grant table above rather than listed separately, so the allow and the deny cannot
 * drift apart: a role that is granted `bsc request …` is allowed it, everything else is denied it.
 * Adding the grant to a new role therefore lifts its deny automatically, and removing the grant
 * re-denies it — there is no second list to remember.
 *
 * `debugger` is the one addition: it is the queue's CONSUMER (it reads, claims and resolves), and it
 * has no `RESTRICTED_ROLE_COMMANDS` entry because it launches full-capability rather than confined.
 *
 * Everything else — `worker`, `director`, `triage`, `planner`, … — is a PROJECT role. Its lane is
 * `bsc plan request`, which is scoped to its own project's plan.db. Escalation from there to the
 * tooling queue is the director's move, made explicitly, not a side effect of any agent being able to
 * run `bsc`.
 */
export function mayFileToolingRequest(role: SessionRole | null | undefined): boolean {
  // The two roles named explicitly, because neither has a `RESTRICTED_ROLE_COMMANDS` entry to derive
  // from — they are not confined roles:
  //   · `debugger` is the queue's CONSUMER (reads, claims, resolves); it launches full-capability.
  //   · `director` is the sanctioned ESCALATION point (#4001). A worker files a PROJECT request
  //     (`bsc plan request`); when the director judges one to be a genuine tooling gap rather than
  //     something it can fix, it forwards it here. That promotion is the whole reason the project lane
  //     can stay closed to workers — and it is safe because the director is `code: none`, so it can
  //     ASK for an app change but never make one. #4000 denied it as well; this is the deliberate
  //     refinement that makes the two-lane design actually work end to end.
  if (role === "debugger" || role === "director") return true;
  return restrictedRoleCommands(role).some((c) => c.startsWith(TOOLING_REQUEST_COMMAND));
}

/**
 * The fixed store-CLI command prefixes a role auto-runs at launch, in ADDITION to its profile's
 * `allowedCommands` (#3095). Empty for a role with no fixed store surface. Returns a fresh array so
 * callers can spread/mutate freely.
 */
export function restrictedRoleCommands(role: SessionRole | null | undefined): string[] {
  return role ? [...(RESTRICTED_ROLE_COMMANDS[role] ?? [])] : [];
}

/**
 * Whether a role is CONFINED to a fixed store-CLI surface — i.e. it has a {@link restrictedRoleCommands}
 * entry, so `restrictedAllow` suppresses the Bash baselines and those commands are its whole auto-run
 * surface.
 *
 * Such a role must NEVER be flipped to the bypass posture: bypass makes Claude auto-run everything and
 * ignores `permissions.deny`, which would hand a deliberately-confined session (the designer is limited
 * to `bsc ui`) a general shell. So the global `bypassPermissions` toggle is overridden to `false` for
 * these roles — the inverse of the full-capability carve-out (`isFullCapabilitySession`, the debug
 * session, which is always bypass). Derived from the role, so the guarantee travels with it.
 */
export function isRestrictedRole(role: SessionRole | null | undefined): boolean {
  return restrictedRoleCommands(role).length > 0;
}
