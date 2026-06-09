// Pipeline command bus — the thin router between Claude's standardized commands and a
// pipeline's OWN behavior. A pipeline is a self-contained plugin: it owns its state,
// result keying/accumulation, navigation, and persistence (it calls writeProjectFile
// inside its own save/confirm). The framework owns nothing here but the routing.
//
// Claude drives pipelines only through the standardized command surface (the
// <pipeline cmd="…"> tags, phase c) — never a pipeline's internals. This module is what
// those tags dispatch into. Pure + framework-free so it's unit-testable in isolation.

export type PipelineCommand =
  | "run" | "save" | "confirm" | "restart" | "prev" | "next" | "goto" | "delete";

export const PIPELINE_COMMANDS: PipelineCommand[] =
  ["run", "save", "confirm", "restart", "prev", "next", "goto", "delete"];

export function isPipelineCommand(value: string): value is PipelineCommand {
  return (PIPELINE_COMMANDS as string[]).includes(value);
}

/** What a command handler receives: the project + free-form args parsed from the tag
 *  (e.g. `screen`, `mode`, `index`, `rid`). The pipeline interprets them. */
export interface PipelineCommandCtx {
  projectKey: string;
  args: Record<string, string>;
}

export type PipelineCommandHandler =
  (cmd: PipelineCommand, ctx: PipelineCommandCtx) => Promise<void> | void;

/** A pipeline's command surface. One registration per pipeline id; the handler is the
 *  pipeline's behavior for every command it supports (it may ignore ones it doesn't). */
export interface PipelineModule {
  id: string;
  command: PipelineCommandHandler;
}

const MODULES = new Map<string, PipelineModule>();

/** Register (or replace) a pipeline's command module. Idempotent — last wins. */
export function registerPipeline(module: PipelineModule): void {
  MODULES.set(module.id, module);
}
export function getPipelineModule(id: string): PipelineModule | undefined {
  return MODULES.get(id);
}
export function hasPipelineModule(id: string): boolean {
  return MODULES.has(id);
}

export interface PipelineDispatchResult {
  ok: boolean;
  error?: string;
}

/**
 * Route a command to its pipeline's module. Never throws: an unknown pipeline or a
 * handler that throws resolves to a structured failure, so the tag-dispatch layer (and
 * any loop over commands) is safe to await.
 */
export async function dispatchPipelineCommand(
  id: string, cmd: PipelineCommand, ctx: PipelineCommandCtx,
): Promise<PipelineDispatchResult> {
  const mod = MODULES.get(id);
  if (!mod) return { ok: false, error: `no pipeline module registered for "${id}"` };
  try {
    await mod.command(cmd, ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Test helper — reset the module registry between cases. */
export function _resetPipelineModules(): void {
  MODULES.clear();
}
