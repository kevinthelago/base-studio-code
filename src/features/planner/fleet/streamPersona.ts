// Stream ⇄ persona resolution (#2094) — a fleet stream may reference a PERSONA (its behavioral
// identity); at launch the persona resolves the stream's role (overriding the default `worker`),
// start prompt, skills, and model. This module is the pure resolution: look up the persona and build
// its role-aware kickoff. `buildStreamPrompt` (the historical worker kickoff) stays for persona-less
// streams; a persona stream gets THIS kickoff instead, so a read-only reviewer/documentor stream isn't
// handed the worker's "own your globs, open a PR" prose.
import type { Persona } from "@/features/personas";
import { roleCapability, hasScopedWriteCarveOut } from "@/shared/lib/session/sessionRoles";
import { resolveFlow } from "./agentFlow";
import { flowKickoffText } from "./flowKickoff";
import { strategySettings, DEFAULT_STRATEGY, type IntegrationStrategy } from "@/features/planner/lib/integrationStrategy";
import type { AgentStream } from "./planFleet";

/** The persona a stream references, or `undefined` (no reference, or an unknown/stale id). */
export function resolveStreamPersona(personas: Persona[], stream: AgentStream): Persona | undefined {
  return stream.persona ? personas.find((p) => p.id === stream.persona) : undefined;
}

/** Whether a role may write files or push — drives whether the kickoff carries the worker autonomy/push
 *  prose or the read-only "report, don't commit" instruction. Includes the scoped-write carve-out
 *  (#851/#1555) so a documentor (code:"none" + DOC_GLOBS) is briefed to WRITE its docs and open a
 *  flow-governed docs PR, not treated as a read-only reviewer. */
function roleWrites(role: Persona["role"]): boolean {
  const cap = roleCapability(role);
  return cap.code === "write" || cap.git === "write" || hasScopedWriteCarveOut(cap);
}

/**
 * The kickoff for a persona stream: the persona's own start prompt (its identity/behavior) followed by
 * the role-AGNOSTIC scope facts every stream needs (its worktree branch, assigned issues, owned paths,
 * contracts + checkpoint discipline), then either the worker autonomy/push paragraph (writing roles) or
 * the read-only reporting instruction (reviewer/juror/…). So a documentor/reviewer stream is briefed as
 * itself, not as a code-writing worker.
 */
export function personaStreamPrompt(
  persona: Persona, stream: AgentStream, strategy?: IntegrationStrategy,
): string {
  const owns   = stream.owns.length   ? stream.owns.join(", ")   : "the files for your area";
  const issues = stream.issues.length ? stream.issues.join(", ") : "the issues assigned to your area";
  const intro = persona.startPrompt.trim();
  const strat = strategy ?? DEFAULT_STRATEGY;
  const closing = roleWrites(persona.role)
    ? (() => {
        const effFlow = { ...resolveFlow(stream.flow), push: stream.flow?.push ?? strategySettings(strat).integrate };
        const kick = flowKickoffText(effFlow, stream.id);
        return `${kick.autonomy} ${kick.push}`;
      })()
    : "This is a read-only role: report what you find by piping notes into bsc-note on stdin; do not commit, push, or open PRs.";
  return (
    (intro ? `${intro}\n\n` : "") +
    `You are the "${stream.name}" stream in a parallel fleet, working in your own git worktree on branch ${stream.id} — ` +
    `do not switch branches or touch other worktrees. Your assigned issues: ${issues}. Your scope: you own ${owns}; ` +
    `stay within it and coordinate anything cross-cutting through the director. Integration interfaces between features ` +
    `live in the contracts directory — read them as the source of truth, and ask the director if one is unclear or must change. ` +
    `When you pause or finish a work session, pipe a short note of where you left off and the next step into bsc-checkpoint on stdin. ` +
    `${closing} ` +
    `Verify your work against the repo tests and CI rather than asking whether it is correct.`
  );
}
