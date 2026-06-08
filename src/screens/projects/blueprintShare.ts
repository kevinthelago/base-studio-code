// Blueprint ⇄ extension-manifest bridge (#598). Wraps a blueprint in the generic
// envelope for export/share, and tolerantly reconstructs a blueprint from an imported
// manifest (fresh uids, defensive field coercion — never trusts the payload shape).
// Pure; pairs with lib/extensions/manifest.ts.

import { type Blueprint, type BlueprintSection, type Pipeline, uid } from "./blueprints";
import { wrapExtension, type ExtensionManifest } from "../../lib/extensions/manifest";

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const PIPE_KINDS = ["builtin", "external", "custom"] as const;
const PIPE_TRIGGERS = ["on section enter", "on artifact change", "on completion", "manual"] as const;

function coercePipeline(v: unknown): Pipeline | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name);
  if (!id || !name) return null;
  return {
    uid: uid("pl"), id, name,
    desc: str(o.desc),
    suits: strArr(o.suits),
    kind: (PIPE_KINDS as readonly string[]).includes(str(o.kind)) ? (str(o.kind) as Pipeline["kind"]) : "custom",
    trigger: (PIPE_TRIGGERS as readonly string[]).includes(str(o.trigger)) ? (str(o.trigger) as Pipeline["trigger"]) : "on completion",
    enabled: o.enabled !== false,
    gate: o.gate === true,
  };
}

function coerceSection(v: unknown): BlueprintSection | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const key = str(o.key);
  const name = str(o.name);
  if (!key || !name) return null;
  return {
    uid: uid("sec"), key, name,
    glyph: str(o.glyph, "✚"),
    gate: str(o.gate, "stage complete"),
    deps: strArr(o.deps),
    blurb: str(o.blurb),
    prompt: str(o.prompt),
    enabled: o.enabled !== false,
    expanded: false,
    pipelines: Array.isArray(o.pipelines)
      ? (o.pipelines.map(coercePipeline).filter(Boolean) as Pipeline[])
      : [],
  };
}

/** Reconstruct a Blueprint from an untrusted payload, or null if it's not one.
 *  Requires an id, a name, and at least one valid section. Assigns fresh uids. */
export function coerceBlueprint(payload: unknown): Blueprint | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name);
  if (!id || !name) return null;
  const sections = Array.isArray(o.sections)
    ? (o.sections.map(coerceSection).filter(Boolean) as BlueprintSection[])
    : [];
  if (sections.length === 0) return null;
  return { id, name, desc: str(o.desc), sections };
}

/** Wrap a blueprint in the extension envelope for export / share / publish. */
export function blueprintToManifest(bp: Blueprint): ExtensionManifest<Blueprint> {
  return wrapExtension("blueprint", bp.id, bp.name, "1.0.0", bp, { description: bp.desc });
}

/** Reconstruct a blueprint from a validated manifest. The store assigns a fresh
 *  blueprint id on import, so a same-id collision can never overwrite an existing one. */
export function manifestToBlueprint(
  m: ExtensionManifest,
): { ok: true; blueprint: Blueprint } | { ok: false; error: string } {
  if (m.kind !== "blueprint") return { ok: false, error: `expected a blueprint, got '${m.kind}'` };
  const blueprint = coerceBlueprint(m.payload);
  if (!blueprint) return { ok: false, error: "blueprint payload is malformed (need id, name, and ≥1 valid section)" };
  return { ok: true, blueprint };
}
