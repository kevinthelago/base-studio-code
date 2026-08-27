// Personas (#2094) — the CRUD-able BEHAVIORAL identity of an agent, split from the ROLE (its
// permission floor, `sessionRoles.ts`). A persona is the named composition the user authors: a start
// prompt + attached skills + a default model, running under a referenced role. Many personas → one
// role (e.g. Reviewer, Juror, Documentor all sit on a read-only floor with very different prompts +
// skills). Pure model (no React/Tauri) so it's unit-testable and the store seeds from it directly.
//
// This is view/CRUD-first (#2094 Part B, relocated to the Planner workspace): the persona is the
// user-facing agent template. Wiring personas into fleet-stream launch + console launch (so picking a
// persona resolves role + prompt + skills + model in one step) is the follow-up phase.
import type { AccessTier, SessionRole } from "@/shared/lib/session/sessionRoles";
import { overlayGlob, overlayRaw } from "@/shared/lib/core/configOverrides";
import { slugify } from "@/shared/lib/core/format";
import workerProtocolMd from "@data/fleet/worker-protocol.md?raw";
import directorProtocolMd from "@data/fleet/director-protocol.md?raw";
import architectProtocolMd from "@data/fleet/architect-protocol.md?raw";

/**
 * A persona's PERMISSION FLOOR — the capability it launches under (epic `the-persona-is-the-whole-agent`).
 *
 * This is the role capability row, folded onto the record that actually gets written. It used to live
 * in two other places: the five access tiers plus the write scope in
 * `@data/permissions/role-capabilities.json`, and the confined command surface as a TS const
 * (`RESTRICTED_ROLE_COMMANDS`). Neither was reachable from the persona store, so `bsc persona set` —
 * a generic verbatim JSON passthrough, on the always-allowed `bsc` tier — could rewrite a persona's
 * capability with nothing to stop it.
 *
 * The clamp lives in the STORE (`crates/bsc-persona/src/floor.rs`), not here: a floor write may only
 * ever NARROW the floor it derives from. This type is the shape both ends agree on.
 */
export interface PersonaFloor {
  github: AccessTier;
  git: AccessTier;
  code: AccessTier;
  net: AccessTier;
  ui: AccessTier;
  /** Path globs this persona may write. Absent ⇒ no write scope at all. */
  writeGlobs?: string[];
  /** SYMBOLIC read-only roots it may harvest from (`app-repo`, `projects`). Absent ⇒ its own root. */
  harvestRoots?: string[];
  /**
   * The confined store-CLI surface — the ONLY commands that auto-run, suppressing the baseline tiers.
   *
   * Its PRESENCE is what makes a persona confined at all, so absent and `[]` are NOT the same thing:
   * absent means unconfined (the broad baseline allow-list), which is the WIDEST value this field
   * takes. That inversion is why the store's clamp treats dropping this list as a widening.
   */
  allow?: string[];
}

/** One hook a persona carries. The wire shape `toSessionPayloads` already emits, minus the store
 *  bookkeeping (`id`/`enabled`/`projects`) that only existed to scope a SHARED hook to a project.
 *  Carried means enabled; not carried means absent. */
export interface PersonaHook {
  /** Display name. It is not decoration: `toHookPayload` wraps the command as
   *  `bsc-hook <name> <command>`, and that wrapper is what records the hook's outcome to the hook
   *  log. A nameless hook still runs; it is just harder to read in the telemetry. */
  name?: string;
  /** `PreToolUse` · `PostToolUse` · `Stop` · … */
  event: string;
  /** Optional tool matcher (regex). Empty/absent = every tool. */
  matcher?: string;
  /** The shell command to run. */
  command: string;
}

/** One scheduled job a persona carries, inline — the config only.
 *
 *  NO TARGET FIELD, and that is the change. An automation used to name a tab by NAME and a pane by
 *  INDEX, and the old model conceded in its own comment that the index does not survive reordering.
 *  The carrier IS the target now: the job fires into the pane running this persona, so moving a pane
 *  cannot silently point a schedule at someone else's terminal.
 *
 *  NO `runs` FIELD either. Run history moved to the `automation` log stream, because a persona is
 *  configuration and writing a run record into it on every fire would rewrite the agent's identity
 *  file on a timer. */
export interface PersonaSchedule {
  /** Display name — what the run log records, so a fire is traceable to the job that caused it. */
  name: string;
  /** When it fires. `{ kind: "simple", every, at }` or `{ kind: "cron", expr }`. */
  when: unknown;
  /** The command written into the carrier's pane. */
  command: string;
  /** Disarmed jobs are kept but never fire — the pause a user wants without deleting the job. */
  armed?: boolean;
}

export interface Persona {
  /** Stable, opaque id (slug for built-ins, minted for user personas). */
  id: string;
  /** Display name — "Documentor". */
  name: string;
  /** One-line description of the job this persona does. */
  blurb: string;
  /** The permission floor this persona runs under — the ONLY link to the role gate (#219). Many
   *  personas may reference the same role; the role bounds capabilities, the persona shapes behavior.
   *
   *  BEING RETIRED: `floor` below now carries the capability directly. This field stays until
   *  `personas-are-the-launch-primitive` rewires every launch site off `SessionRole`. */
  role: SessionRole;
  /** This persona's own permission floor. Packaged personas ship one generated from their role row
   *  (`scripts/gen-persona-floors.mjs`), kept honest by `personaFloorParity.test.ts`. */
  floor?: PersonaFloor;
  /** The persona this one's floor NARROWS from. Read by the store's clamp: a persona with no
   *  ancestor may only be created with an all-`none` floor, so a new persona fails closed. */
  derivesFrom?: string;
  /** The start prompt / protocol injected at launch (prose). Empty is allowed (falls back to the
   *  role's own kickoff assembly downstream). */
  startPrompt: string;
  /** Attached skill ids (the Skills library, #636) written into the session's .claude/skills/. */
  skills: string[];
  /** Attached MCP server ids — THE ONLY reason a server reaches a session.
   *
   *  It replaced three mechanisms that each answered the same question: `McpServer.projects[]`
   *  (project scoping), `streamMcp` (per-stream assignment) and `paneMcpServers` (a per-pane
   *  override). A skill already worked this way and an MCP server is the same kind of thing —
   *  injectable capability an agent draws on — so it is stored and assigned the same way.
   *
   *  Authored with `bsc mcp server assign`, which writes THIS field rather than the server, so
   *  there is one owner of the assignment. Optional: a persona authored before this carries none,
   *  which reads as "no servers" rather than as an error.
   *
   *  The BUNDLED servers are not listed here — they ship with the app and reach every session
   *  ambiently, the same way packaged personas are seeded rather than authored. */
  mcp?: string[];
  /** The agent's own PreToolUse/PostToolUse hooks, INLINE.
   *
   *  Inline rather than ids into a store — which is deliberately unlike `mcp` above. An MCP server
   *  is a shared external thing many agents point at, so ids and a store earn their keep. A hook is
   *  one agent's own behaviour: a small command, cheap to repeat, and not worth an id indirection,
   *  a second store and a second CLI. Inline also means the command surface ALREADY EXISTS —
   *  `bsc persona set` writes the whole persona, so authoring a hook is authoring a persona.
   *
   *  These are the USER hooks only. The app's own security floor (bsc-deny / bsc-confine /
   *  bsc-scope / bsc-audit …) is separate machinery, always applied, and untouched by this.
   *
   *  Replaced `Hook.projects[]` scoping and the per-pane `paneHooks` map — the same three-into-one
   *  collapse the MCP move made. */
  hooks?: PersonaHook[];
  /** The agent's own scheduled jobs, INLINE — same reasoning as `hooks` above: a schedule is one
   *  agent's own job, and `bsc persona set` is already the surface that authors it. */
  schedules?: PersonaSchedule[];
  /** The position's charter — what it is accountable for (#2193). One facet of the org abstraction,
   *  orthogonal to skills (capability) and role (permission); optional, so pre-#2193 personas are
   *  unaffected. Feeds the generated start prompt + the Org designer's position inspector. */
  responsibilities?: string[];
  /** Default model id for this persona (empty = the session/global default). */
  model?: string;
  /** This identity is meant to run as a POOL of interchangeable instances (#2199) — a swarm of N agents
   *  doing the same job. In the Org designer, a set of positions on a pooled persona that share the same
   *  external relationships collapses into ONE stacked card (drill in to see the members). Purely a
   *  designer/consolidation hint today; the fleet still launches N real agents. Optional — unset = 1:1. */
  pooled?: boolean;
  /** A packaged persona: seeded from code, restored on refresh. Can be cloned + edited (edits persist
   *  as an overlay) but not deleted; user-authored personas have `builtin` unset. */
  builtin?: boolean;
  /** Per-field fingerprints of the PACKAGED prose this record was last seeded with — the mechanism
   *  that lets a built-in's prose change reach an already-seeded store. See {@link reconcilePersonas}.
   *  Written only by reconcile; absent on a user-authored persona, which is never re-seeded. */
  proseSeal?: Partial<Record<ProseField, string>>;
  /** Prose displaced by the one-time bootstrap re-seed, kept so nothing is destroyed by an upgrade the
   *  user did not ask for. Written once, never read by the app — it exists to be recoverable. */
  replacedProse?: Partial<Record<ProseField, string>>;
}

/** The prose fields a packaged built-in owns and reconcile may re-seed. NOT `name` or `model`: those
 *  are identity + cost knobs a user sets deliberately and a packaged bump has no business moving. */
export type ProseField = "startPrompt" | "blurb" | "responsibilities";
export const PROSE_FIELDS: readonly ProseField[] = ["startPrompt", "blurb", "responsibilities"];

/** A stable, dependency-free fingerprint of one prose value (FNV-1a, 32-bit, hex).
 *
 *  This is a CHANGE DETECTOR, not a security primitive — collisions cost a missed re-seed, which is
 *  the same outcome as the behaviour that existed before this fingerprint did.
 *
 *  `responsibilities` is an array, so it is joined with ` ` — a separator that cannot occur in
 *  the prose, so `["a\nb"]` and `["a", "b"]` do not fingerprint alike. */
export function proseFingerprint(value: string | string[] | undefined): string {
  const s = Array.isArray(value) ? value.join(" ") : (value ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A packaged persona definition, as authored under `src-tauri/data/personas/*.json` (#2185). It is a
 *  {@link Persona} plus two load-time-only fields: `order` (display order in the library) and
 *  `protocolFile` (a config-relative markdown path whose prose supplies the start prompt for the two
 *  personas that have a real runtime protocol — worker/director). Both are stripped during assembly. */
interface PersonaDef extends Omit<Persona, "builtin"> {
  /** Display order in the library (ascending); absent sorts as 0. */
  order?: number;
  /** Config-relative markdown file (e.g. "fleet/worker-protocol.md") whose text fills an empty
   *  `startPrompt` — the single source of truth for the worker/director protocol prose. */
  protocolFile?: string;
}

// The built-in personas live as one JSON file per persona under src-tauri/data/personas/ (#2185) —
// the same externalized-config pattern as blueprints/skills/roles (#2027/#2047), so the packaged set
// is editable without a rebuild (config-dir overlay) and rides the export/import config bundle.
const personaModules = import.meta.glob<{ default: PersonaDef }>("@data/personas/*.json", { eager: true });

/** The runtime protocol prose for the personas that reference a `protocolFile`, keyed by that path.
 *  Resolved ONCE from the shared `@data/fleet/*-protocol.md` (imported `?raw`) with the config-dir
 *  overlay applied — so the worker/director personas and the fleet's CLAUDE.local.md draw the exact
 *  same prose from one source, no duplication (the #2027 drift-killer). */
const PROTOCOL_PROSE: Record<string, string> = {
  "fleet/worker-protocol.md": overlayRaw("fleet/worker-protocol.md", workerProtocolMd).trim(),
  "fleet/director-protocol.md": overlayRaw("fleet/director-protocol.md", directorProtocolMd).trim(),
  // #funnel-architect-front-door — tier 1's protocol, resolved the same way so the persona's prompt and
  // any other consumer of the architect prose stay ONE source (the #2027 drift-killer).
  "fleet/architect-protocol.md": overlayRaw("fleet/architect-protocol.md", architectProtocolMd).trim(),
};

/** Assemble the packaged persona library from the per-persona JSON defs: overlay the config-dir copies,
 *  order them, resolve any `protocolFile` prose into an empty start prompt, and stamp `builtin`. */
export function makeBuiltinPersonas(): Persona[] {
  return overlayGlob<PersonaDef>("personas", personaModules)
    .map(([, def]) => def)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(({ order: _order, protocolFile, ...p }) => ({
      ...p,
      skills: p.skills ?? [],
      startPrompt: p.startPrompt || (protocolFile ? PROTOCOL_PROSE[protocolFile] ?? "" : ""),
      builtin: true,
    }));
}

/** The packaged personas — one per role, so the tab is populated + honest on day one. `documentor`
 *  (#1555) is the identity for the `documentor` role: read-only on git/GitHub with a DOC_GLOBS write
 *  carve-out, so it reconciles prose docs after a change lands but can never touch code. The
 *  worker/director carry the real fleet protocol prose (resolved from `@data/fleet/*-protocol.md`);
 *  the rest are short seeds. */
export const BUILTIN_PERSONAS: Persona[] = makeBuiltinPersonas();

/** Slugify a persona name into an id fragment (user personas mint `persona-<slug>-<n>` in the store). */
export function personaSlug(name: string): string {
  return slugify(name) || "persona";
}

/** A blank user persona seeded onto a role — the "new persona" template. */
export function blankPersona(id: string, role: SessionRole = "reviewer"): Persona {
  return { id, name: "New persona", blurb: "", role, startPrompt: "", skills: [] };
}

/** Keep only the keys of a persisted persona that carry a real value — so a copy seeded by an OLDER app
 *  (which never wrote a newly-packaged field like `pooled`) doesn't MASK the built-in's value for it. An
 *  absent field comes across as `undefined`; without this, `{...base, ...saved}` would overwrite
 *  `base.pooled` with that `undefined`. Real values (incl. `false`/`""`) are kept, so genuine user edits
 *  still win. */
function definedFields(p: Persona): Partial<Persona> {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Partial<Persona>;
}

/**
 * Reconcile ONE built-in's prose against the packaged copy — the rule that lets a packaged prose
 * change reach a store that was seeded before it, without ever overwriting the user's own words.
 *
 * ## Why this exists
 *
 * A packaged persona's prose used to be unreachable once seeded. The merge preferred the persisted
 * value for every field, with a single exception — an EMPTY `startPrompt` inherited the packaged one —
 * so a built-in whose packaged prose CHANGED was never picked up. The architect is what that cost:
 * discovery was moved onto it and its packaged protocol was rewritten to say so, while every existing
 * store kept serving the teams-only prompt that tells it to refuse planning outright. The powers moved
 * (they are computed from the packaged JSON) and the prose did not, so the session was left holding
 * the funnel's capabilities and the previous job's instructions.
 *
 * ## The rule
 *
 * Each prose field carries a fingerprint of the PACKAGED value it was seeded from. On reconcile:
 *
 *   the field still fingerprints as what we seeded  →  it is ours, re-seed it
 *   it does not                                     →  the user edited it, keep theirs
 *
 * So a packaged bump propagates, and a genuine edit is permanent. Deriving the version from the
 * CONTENT rather than a hand-maintained revision number is deliberate: a number has to be remembered
 * at the moment someone edits a markdown file, and the one that is forgotten is indistinguishable
 * from no change at all.
 *
 * ## The bootstrap, and its one cost
 *
 * A record written before the seal has no fingerprint to compare, so provenance is genuinely unknown.
 * It is treated as packaged-seeded and re-seeded once, because that is overwhelmingly what it is —
 * built-in prompts are read far more often than they are rewritten — and because the alternative
 * leaves every existing store permanently stuck on the prose this whole mechanism exists to replace.
 *
 * The cost lands only on someone who edited a built-in's prose BEFORE this shipped, and it is not
 * destruction: the displaced text is kept on the record as `replacedProse`. One upgrade pays it; from
 * then on every edit is sealed and safe.
 */
function reseededProse(base: Persona, saved: Persona): Partial<Persona> {
  const out: Partial<Persona> = {};
  const seal: Partial<Record<ProseField, string>> = {};
  const replaced: Partial<Record<ProseField, string>> = { ...saved.replacedProse };
  let displaced = false;

  for (const field of PROSE_FIELDS) {
    const packaged = base[field];
    seal[field] = proseFingerprint(packaged);
    const previousSeal = saved.proseSeal?.[field];
    // Unsealed ⇒ the bootstrap: unknown provenance, treated as ours (see above).
    const ours = previousSeal === undefined || previousSeal === proseFingerprint(saved[field]);
    if (!ours) continue;                       // a real user edit — never touched
    if (proseFingerprint(saved[field]) === seal[field]) continue;  // already current
    // Only the bootstrap can displace text the app did not write, so only it records a replacement.
    if (previousSeal === undefined && (saved[field] ?? "") !== "") {
      replaced[field] = Array.isArray(saved[field]) ? saved[field].join("\n") : String(saved[field]);
      displaced = true;
    }
    (out as Record<string, unknown>)[field] = packaged;
  }
  out.proseSeal = seal;
  if (displaced) out.replacedProse = replaced;
  return out;
}

/** Merge the packaged built-ins with the persisted set: every built-in is present (re-seeded if the
 *  persisted copy dropped it), user edits to a built-in are preserved, and user-authored personas are
 *  kept. Keyed by id; built-in identity is restored so a stale persisted `builtin:false` can't turn a
 *  packaged persona into a deletable one. */
export function reconcilePersonas(persisted: Persona[]): Persona[] {
  const byId = new Map(persisted.map((p) => [p.id, p]));
  const out: Persona[] = BUILTIN_PERSONAS.map((base) => {
    const saved = byId.get(base.id);
    byId.delete(base.id);
    if (!saved) return { ...base, proseSeal: sealOf(base) };
    // Keep user edits (name/prompt/skills/model) but force builtin identity + role-reference.
    // `definedFields` means a field the persisted copy never had (a newly-packaged facet like `pooled`)
    // inherits the built-in rather than being masked by an absent-value `undefined`.
    // An EMPTY saved `startPrompt` also inherits the packaged prose rather than clobbering it — the
    // upgrade path: a built-in seeded empty by an older app (worker/director) picks up its newly-wired
    // protocol prose, and since an empty prompt already falls back to the role kickoff downstream,
    // "clearing" a built-in's prompt was never meaningful anyway.
    //
    // `reseededProse` runs LAST so it wins over `definedFields`: it is the only thing here that has
    // decided, per field, whether the persisted value is the user's or ours.
    return {
      ...base, ...definedFields(saved), id: base.id, builtin: true,
      startPrompt: saved.startPrompt?.trim() ? saved.startPrompt : base.startPrompt,
      ...reseededProse(base, saved),
    };
  });
  // Whatever remains is user-authored (never builtin).
  for (const p of byId.values()) out.push({ ...p, builtin: false });
  return out;
}

/** The full prose seal for a packaged persona — what a freshly-seeded record carries, so its very
 *  first edit is already distinguishable from the packaged prose it replaced. */
function sealOf(base: Persona): Partial<Record<ProseField, string>> {
  return Object.fromEntries(PROSE_FIELDS.map((f) => [f, proseFingerprint(base[f])]));
}
