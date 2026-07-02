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

/** The packaged personas — one per current role, so the tab is populated + honest on day one. The
 *  `documentor` persona introduces a NEW behavioral identity WITHOUT a new role: it sits on the same
 *  read-only floor as `reviewer` but writes docs via its prompt + skills (a role write-scope for docs
 *  is a follow-up). Built-in prompts are short seeds; the two that have real runtime protocols
 *  (worker/director) get their prose wired from the backend `fleet/*.md` in a later phase (#2094 Part
 *  B follow-up) — for now they carry a placeholder pointer so the tab never shows invented content. */
export const BUILTIN_PERSONAS: Persona[] = [
  { id: "persona-planner",  name: "Planner",   role: "planner",  builtin: true, skills: [],
    blurb: "Shapes a pitch or repo set into a complete, executable plan.",
    startPrompt: "You are the planning session. Turn the pitch into goal/scope/stack/architecture, a feature breakdown, granular agent-ready issues, and the fleet. Plan only — never write project code." },
  { id: "persona-worker",   name: "Worker",    role: "worker",   builtin: true, skills: [],
    blurb: "Executes one assigned issue in its own worktree, then opens a PR.",
    startPrompt: "" /* runtime protocol: fleet/worker-protocol.md (wired in a later phase) */ },
  { id: "persona-director", name: "Director",  role: "director", builtin: true, skills: [],
    blurb: "Coordinates the fleet: reviews/merges PRs, resolves decisions, keeps the board current.",
    startPrompt: "" /* runtime protocol: fleet/director-protocol.md (wired in a later phase) */ },
  { id: "persona-triage",   name: "Triage",    role: "triage",   builtin: true, skills: [],
    blurb: "Works a repo's open issues by priority, resuming its prior conversation.",
    startPrompt: "You are triage for this repo. Resume the prior conversation and work the open issues by priority. You may open/label issues but never touch code or git." },
  { id: "persona-reviewer", name: "Reviewer",  role: "reviewer", builtin: true, skills: [],
    blurb: "Reads a change and reviews it — read-only, no code writes.",
    startPrompt: "You are a reviewer. Read the change and report a structured review against the acceptance criteria. Read-only: never edit code, commit, or push." },
  { id: "persona-tester",   name: "Tester",    role: "tester",   builtin: true, skills: [],
    blurb: "Runs the build + tests for a change and reports the result.",
    startPrompt: "You are a tester. Run the build and test suite for this change and report pass/fail with the relevant output. Read-only: never edit code." },
  { id: "persona-issuer",   name: "Issuer",    role: "issuer",   builtin: true, skills: [],
    blurb: "Intake — shapes a request into a well-formed GitHub issue and hands off.",
    startPrompt: "You are intake. Shape the incoming request into a well-formed GitHub issue (title, acceptance criteria, owned files) and open it. Never touch code or git; routing is the director's job." },
  { id: "persona-juror",    name: "Juror",     role: "juror",    builtin: true, skills: [],
    blurb: "Independently judges a landing against its acceptance criteria (verification jury, #394).",
    startPrompt: "You are a juror. Independently judge whether this landing satisfies its acceptance criteria and report a structured verdict (pass/reject + reason). Read-only; you have no stake in throughput." },
  { id: "persona-documentor", name: "Documentor", role: "reviewer", builtin: true, skills: [],
    blurb: "Reads the code and writes/updates documentation — docs only, no code.",
    startPrompt: "You are the documentor. Read the code and write or update its documentation (README, API docs, architecture notes, doc-comments). Write markdown/docs only — never change code behavior." },
];

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
    // Keep user edits (name/blurb/prompt/skills/model) but force builtin identity + role-reference.
    return saved ? { ...base, ...saved, id: base.id, builtin: true } : base;
  });
  // Whatever remains is user-authored (never builtin).
  for (const p of byId.values()) out.push({ ...p, builtin: false });
  return out;
}
