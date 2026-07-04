// Runtime-fault instrumentation adapters (#2262, epic #2258) — the per-environment registry + shim
// renderer the planner uses to bake fault instrumentation into every generated app at the Deployment
// stage. Each app ships ALREADY INSTRUMENTED for its target environment: `local` is implemented (the
// shim POSTs the fault/heartbeat envelope to the bsc localhost collector, #2261); `aws`/`vercel`/`fly`/
// `docker` are declared-but-PLANNED seams so the coverage gap is explicit, never silent.
//
// DATA is externalized to `@data/runtime-fault/*` (#2027 P1): the registry (`adapters.json`) + the
// per-stack shim TEMPLATES (`shims/*.tmpl`). This module keeps only the TYPES + the accessors + the
// pure renderer. Pure (no React/Tauri) — import from `@/features/planner/lib/runtimeFault`.

import adaptersEmbedded from "@data/runtime-fault/adapters.json";
import jsShim from "@data/runtime-fault/shims/js.tmpl?raw";
import pythonShim from "@data/runtime-fault/shims/python.tmpl?raw";
import rustShim from "@data/runtime-fault/shims/rust.tmpl?raw";
import goShim from "@data/runtime-fault/shims/go.tmpl?raw";
import { overlayFile, overlayRaw } from "@/shared/lib/core/configOverrides";

/** Whether an environment's instrumentation is built (`implemented`) or a declared future seam (`planned`). */
export type AdapterStatus = "implemented" | "planned";

/** One environment's runtime-fault instrumentation adapter. `shims` (lang → template key) is present
 *  only on an `implemented` adapter that ships shim templates (today: `local`). */
export interface RuntimeFaultAdapter {
  status: AdapterStatus;
  label: string;
  transport: string;
  description: string;
  shims?: Record<string, string>;
}

export interface RuntimeFaultRegistry {
  heartbeatSeconds: number;
  envelope: { endpoint: string; contentType: string; fields: Record<string, string> };
  adapters: Record<string, RuntimeFaultAdapter>;
}

// The config-dir copy (#2047) overlays the embedded default — editable without a rebuild.
const registry = overlayFile("runtime-fault/adapters.json", adaptersEmbedded) as unknown as RuntimeFaultRegistry;

// Shim templates by template KEY (the `shims` map's values), each overlaid so a config-dir edit takes
// effect without a rebuild (parity with the deploy taxonomy / role-caps overlays).
const SHIM_TEMPLATES: Record<string, string> = {
  js: overlayRaw("runtime-fault/shims/js.tmpl", jsShim),
  python: overlayRaw("runtime-fault/shims/python.tmpl", pythonShim),
  rust: overlayRaw("runtime-fault/shims/rust.tmpl", rustShim),
  go: overlayRaw("runtime-fault/shims/go.tmpl", goShim),
};

/** The whole registry (heartbeat cadence + envelope contract + adapters). */
export function runtimeFaultRegistry(): RuntimeFaultRegistry {
  return registry;
}

/** Every environment → adapter (implemented + planned), so the UI/directive can list them WITH their
 *  status — no silent omission of the not-yet-built ones (an acceptance requirement of #2262). */
export function runtimeFaultAdapters(): Record<string, RuntimeFaultAdapter> {
  return registry.adapters;
}

/** The adapter for an environment, or `undefined` if the environment isn't in the registry. */
export function selectAdapter(env: string): RuntimeFaultAdapter | undefined {
  return registry.adapters[env];
}

/** Whether an environment's instrumentation is actually built (vs a planned seam). */
export function isImplemented(env: string): boolean {
  return selectAdapter(env)?.status === "implemented";
}

/** The stack languages an environment ships shim templates for (`[]` for a planned/unknown env). */
export function shimLanguages(env: string): string[] {
  return Object.keys(selectAdapter(env)?.shims ?? {});
}

/** The per-project values baked into a shim at generation. */
export interface ShimVars {
  ingestPort: number | string;
  projectKey: string;
  ingestToken: string;
  release: string;
}

/**
 * Render the shim for an environment + stack language with the per-project values substituted, ready
 * to write into the generated app. Returns `null` when the environment/language has no IMPLEMENTED shim
 * (a planned env, an unknown env, or a language the adapter doesn't cover) so the caller can degrade
 * gracefully. Throws if any `{{PLACEHOLDER}}` is left unsubstituted — a hard guard so a generated app
 * never ships a literal `{{…}}` (a broken shim that silently reports nothing).
 */
export function renderShim(env: string, lang: string, vars: ShimVars): string | null {
  const adapter = selectAdapter(env);
  if (!adapter || adapter.status !== "implemented" || !adapter.shims) return null;
  const key = adapter.shims[lang];
  if (!key) return null;
  const template = SHIM_TEMPLATES[key];
  if (template === undefined) return null;

  const hb = registry.heartbeatSeconds;
  const subs: Record<string, string> = {
    INGEST_PORT: String(vars.ingestPort),
    PROJECT_KEY: vars.projectKey,
    INGEST_TOKEN: vars.ingestToken,
    RELEASE: vars.release,
    HEARTBEAT_SECONDS: String(hb),
    HEARTBEAT_MS: String(hb * 1000),
  };
  const out = template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(subs, name) ? subs[name] : whole,
  );
  const leftover = out.match(/\{\{\w+\}\}/);
  if (leftover) {
    throw new Error(`runtime-fault shim (${env}/${lang}) left an unsubstituted placeholder: ${leftover[0]}`);
  }
  return out;
}
