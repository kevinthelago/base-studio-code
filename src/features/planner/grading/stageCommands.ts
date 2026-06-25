// Stage command bus — the thin router between Claude's standardized commands and a stage
// module's OWN behavior. A stage module is a self-contained plugin: it owns its state,
// result keying/accumulation, navigation, and persistence (it calls writeProjectFile
// inside its own save/confirm). The framework owns nothing here but the routing.
//
// Claude drives stage modules only through the standardized command surface (the
// <pipeline cmd="…"> wire tags, phase c) — never a module's internals. This module is what
// those tags dispatch into. Pure + framework-free so it's unit-testable in isolation.
//
// Naming (#917): the in-app system was renamed "pipeline*" → "stage*". The on-the-wire DSL
// keyword stays `<pipeline cmd="…">` (a cross-repo contract with mobile-studio-code, parsed
// in stageTag.ts) — only the desktop-side identifiers changed.

export type StageCommand =
  | "run" | "save" | "confirm" | "restart" | "prev" | "next" | "goto" | "delete";

export const STAGE_COMMANDS: StageCommand[] =
  ["run", "save", "confirm", "restart", "prev", "next", "goto", "delete"];

export function isStageCommand(value: string): value is StageCommand {
  return (STAGE_COMMANDS as string[]).includes(value);
}

/** What a command handler receives: the project + free-form args parsed from the tag
 *  (e.g. `screen`, `mode`, `index`, `rid`). The pipeline interprets them. */
export interface StageCommandCtx {
  projectKey: string;
  args: Record<string, string>;
}

export type StageCommandHandler =
  (cmd: StageCommand, ctx: StageCommandCtx) => Promise<void> | void;

/** A stage module's command surface. One registration per stage id; the handler is the
 *  stage module's behavior for every command it supports (it may ignore ones it doesn't). */
export interface StageModule {
  id: string;
  command: StageCommandHandler;
}

const MODULES = new Map<string, StageModule>();

/** Register (or replace) a stage module's command module. Idempotent — last wins. */
export function registerStageModule(module: StageModule): void {
  MODULES.set(module.id, module);
}
export function getStageModule(id: string): StageModule | undefined {
  return MODULES.get(id);
}
export function hasStageModule(id: string): boolean {
  return MODULES.has(id);
}

export interface StageDispatchResult {
  ok: boolean;
  error?: string;
}

/**
 * Route a command to its stage module's module. Never throws: an unknown stage module or a
 * handler that throws resolves to a structured failure, so the tag-dispatch layer (and
 * any loop over commands) is safe to await.
 */
export async function dispatchStageCommand(
  id: string, cmd: StageCommand, ctx: StageCommandCtx,
): Promise<StageDispatchResult> {
  const mod = MODULES.get(id);
  if (!mod) return { ok: false, error: `no stage module registered for "${id}"` };
  try {
    await mod.command(cmd, ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Test helper — reset the module registry between cases. */
export function _resetStageModules(): void {
  MODULES.clear();
}
