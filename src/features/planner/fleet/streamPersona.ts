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
import personaKickoffEmbedded from "@data/fleet/persona-kickoff.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";
import { fillTemplate } from "@/shared/lib/core/template";

// The kickoff PROSE (the role-agnostic scope paragraph, the read-only closing, and the owns/issues
// fallbacks) is externalized to `@data/fleet/persona-kickoff.json` (#2416) — editable without touching
// code + part of the exportable config bundle; the config-dir copy (#2047) overlays the embedded
// default via `overlayFile`. This module keeps only the interpolation (`{{STREAM_NAME}}`/`{{BRANCH}}`/
// `{{ISSUES}}`/`{{OWNS}}`/`{{CLOSING}}`) and the role/flow resolution that computes the closing.
const KICKOFF_PROSE = overlayFile("fleet/persona-kickoff.json", personaKickoffEmbedded);

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
  const owns   = stream.owns.length   ? stream.owns.join(", ")   : KICKOFF_PROSE.ownsFallback;
  const issues = stream.issues.length ? stream.issues.join(", ") : KICKOFF_PROSE.issuesFallback;
  const intro = persona.startPrompt.trim();
  const strat = strategy ?? DEFAULT_STRATEGY;
  const closing = roleWrites(persona.role)
    ? (() => {
        const effFlow = { ...resolveFlow(stream.flow), push: stream.flow?.push ?? strategySettings(strat).integrate };
        const kick = flowKickoffText(effFlow, stream.id);
        return `${kick.autonomy} ${kick.push}`;
      })()
    : KICKOFF_PROSE.readOnlyClosing;
  return (
    (intro ? `${intro}\n\n` : "") +
    fillTemplate(KICKOFF_PROSE.scope, {
      STREAM_NAME: stream.name,
      BRANCH: stream.id,
      ISSUES: issues,
      OWNS: owns,
      CLOSING: closing,
    })
  );
}
