// Pipeline-extension payload + validation (#598 M3). A `kind:"pipeline"` manifest's
// payload says how the pipeline runs and (for code runtimes) which bundle to load.
// This module validates the *contract* — that a code pipeline ships an entry bundle,
// pins its integrity, and requests only known capabilities — before anything executes.
// Pure; the sandbox runtime (M3b) consumes a validated descriptor.

import { type ExtensionManifest } from "./manifest";
import { partitionCapabilities } from "./capabilities";

/** How a pipeline's behavior runs. M3 implements the two CODE runtimes; the rest are
 *  reserved (declarative = in-app config, mcp/webhook = external process). */
export type PipelineRuntime = "declarative" | "iframe" | "worker" | "mcp" | "webhook" | "wasm";
export const PIPELINE_RUNTIMES: PipelineRuntime[] = ["declarative", "iframe", "worker", "mcp", "webhook", "wasm"];
/** Runtimes that ship executable code → require a sandbox + integrity pin + consent. */
export const CODE_RUNTIMES: PipelineRuntime[] = ["iframe", "worker"];

export interface PipelineExtensionPayload {
  runtime: PipelineRuntime;
  /** Stage keys this pipeline suits ("*" = any stage). */
  suits: string[];
  /** When it fires (mirrors the blueprint pipeline triggers). */
  trigger: string;
  /** Whether it gates its stage. */
  gate?: boolean;
  /** Code runtimes: the bundle file (published alongside the manifest in the gist). */
  entry?: string;
  /** declarative / mcp / webhook configuration. */
  spec?: unknown;
}

export function isCodeRuntime(r: string): boolean {
  return (CODE_RUNTIMES as string[]).includes(r);
}

export interface PipelineExtensionValidation {
  ok: boolean;
  errors: string[];
  /** True when the runtime ships executable code (sandbox + integrity + consent apply). */
  isCode: boolean;
}

/**
 * Validate a pipeline-extension manifest's contract. Does NOT run anything — it ensures
 * a code pipeline declares an entry bundle, pins integrity (so a later gist edit is
 * caught), and requests only known capabilities. An unknown runtime or capability means
 * the manifest targets a newer app, so it's refused rather than partially honored.
 */
export function validatePipelineExtension(m: ExtensionManifest): PipelineExtensionValidation {
  const errors: string[] = [];
  if (m.kind !== "pipeline") errors.push(`expected a pipeline, got '${m.kind}'`);

  const p = m.payload as Partial<PipelineExtensionPayload> | undefined;
  const runtime = p?.runtime;
  const known = !!runtime && (PIPELINE_RUNTIMES as string[]).includes(runtime);
  if (!known) errors.push(`unknown pipeline runtime '${String(runtime)}'`);
  const isCode = !!runtime && isCodeRuntime(runtime);

  if (!Array.isArray(p?.suits) || p!.suits.length === 0) errors.push("pipeline must declare at least one 'suits' stage");
  if (typeof p?.trigger !== "string" || !p.trigger) errors.push("pipeline is missing a 'trigger'");

  const { unknown } = partitionCapabilities(m.capabilities ?? []);
  if (unknown.length) errors.push(`unknown capabilities: ${unknown.join(", ")}`);

  if (isCode) {
    if (!p?.entry) errors.push("a code pipeline must declare an 'entry' bundle file");
    if (!m.integrity) errors.push("a code pipeline must pin its bundle integrity (sha256)");
  }

  return { ok: errors.length === 0, errors, isCode };
}
