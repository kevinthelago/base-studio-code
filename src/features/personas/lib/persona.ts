// Personas (#2094) — the CRUD-able BEHAVIORAL identity of an agent, split from the ROLE (its
// permission floor, `sessionRoles.ts`). A persona is the named composition the user authors: a start
// prompt + attached skills + a default model, running under a referenced role. Many personas → one
// role (e.g. Reviewer, Juror, Documentor all sit on a read-only floor with very different prompts +
// skills). Pure model (no React/Tauri) so it's unit-testable and the store seeds from it directly.
//
// This is view/CRUD-first (#2094 Part B, relocated to the Planner workspace): the persona is the
// user-facing agent template. Wiring personas into fleet-stream launch + console launch (so picking a
// persona resolves role + prompt + skills + model in one step) is the follow-up phase.
import type { SessionRole } from "@/shared/lib/session/sessionRoles";
import { overlayGlob, overlayRaw } from "@/shared/lib/core/configOverrides";
import workerProtocolMd from "@data/fleet/worker-protocol.md?raw";
import directorProtocolMd from "@data/fleet/director-protocol.md?raw";

export interface Persona {
  /** Stable, opaque id (slug for built-ins, minted for user personas). */
  id: string;
  /** Display name — "Documentor". */
  name: string;
  /** One-line description of the job this persona does. */
  blurb: string;
  /** The permission floor this persona runs under — the ONLY link to the role gate (#219). Many
   *  personas may reference the same role; the role bounds capabilities, the persona shapes behavior. */
  role: SessionRole;
  /** The start prompt / protocol injected at launch (prose). Empty is allowed (falls back to the
   *  role's own kickoff assembly downstream). */
  startPrompt: string;
  /** Attached skill ids (the Skills library, #636) written into the session's .claude/skills/. */
  skills: string[];
  /** Default model id for this persona (empty = the session/global default). */
  model?: string;
  /** A packaged persona: seeded from code, restored on refresh. Can be cloned + edited (edits persist
   *  as an overlay) but not deleted; user-authored personas have `builtin` unset. */
  builtin?: boolean;
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

/** The packaged personas — one per current role (+ documentor), so the tab is populated + honest on
 *  day one. `documentor` introduces a NEW behavioral identity WITHOUT a new role: it sits on the same
 *  read-only floor as `reviewer` but writes docs via its prompt + skills. The worker/director carry the
 *  real fleet protocol prose (resolved from `@data/fleet/*-protocol.md`); the rest are short seeds. */
export const BUILTIN_PERSONAS: Persona[] = makeBuiltinPersonas();

/** Slugify a persona name into an id fragment (user personas mint `persona-<slug>-<n>` in the store). */
export function personaSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "persona";
}

/** A blank user persona seeded onto a role — the "new persona" template. */
export function blankPersona(id: string, role: SessionRole = "reviewer"): Persona {
  return { id, name: "New persona", blurb: "", role, startPrompt: "", skills: [] };
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
    if (!saved) return base;
    // Keep user edits (name/blurb/prompt/skills/model) but force builtin identity + role-reference.
    // An EMPTY saved `startPrompt` inherits the packaged prose rather than clobbering it — this is the
    // upgrade path: a built-in seeded empty by an older app (worker/director) picks up its newly-wired
    // protocol prose, and since an empty prompt already falls back to the role kickoff downstream,
    // "clearing" a built-in's prompt was never meaningful anyway.
    return {
      ...base, ...saved, id: base.id, builtin: true,
      startPrompt: saved.startPrompt?.trim() ? saved.startPrompt : base.startPrompt,
    };
  });
  // Whatever remains is user-authored (never builtin).
  for (const p of byId.values()) out.push({ ...p, builtin: false });
  return out;
}
