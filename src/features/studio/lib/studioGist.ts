// Studio gist transport (#2891, slice 2 of the Studio epic #2889) — export/import a saved STUDIO (the
// app-library snapshot bundle from slice #2890) as a typed GitHub gist, reusing the SAME
// extension-manifest envelope + gist transport blueprints and component-kits already ship in
// (#598/#2305). A studio is already a self-contained JSON bundle, so distribution is one file: wrap it
// in the `studio` envelope, publish it as a gist (or read one back by URL/id). Pure envelope helpers
// (unit-testable) + Tauri-backed transport, mirroring `designs/lib/kitGist.ts`. Imports the manifest +
// gist helpers via the planner's PUBLIC barrel (`@/features/planner`), respecting the #1545 boundary.
import { wrapExtension, installFromGist, publishGist, type ExtensionManifest } from "@/features/planner";

/** The manifest kind a studio ships as. */
export const STUDIO_KIND = "studio" as const;

/**
 * A **Studio** — a self-contained, shareable snapshot of the app's library state. Mirrors the Rust
 * `bsc-studio` bundle: identity (`id` = a slug of `name`) + the extensible `snapshot` map, keyed by
 * system name (teams · personas · components · variants · themes · blueprints) → that store's records.
 */
export interface Studio {
  id: string;
  name: string;
  description?: string;
  version?: string;
  /** The captured library state, keyed by system → its records. Extensible; never trusted on import. */
  snapshot: Record<string, unknown[]>;
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** Coerce an untrusted payload's `snapshot` into a plain object of arrays. A non-object (or an array —
 *  which JSON.parse yields for `[]`) ⇒ `{}`; each key keeps only the entries whose value is an array,
 *  and every element stays an opaque `unknown` (the snapshot is never structurally trusted). */
function coerceSnapshot(v: unknown): Record<string, unknown[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, unknown[]> = {};
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(val)) out[key] = val;
  }
  return out;
}

/** Wrap a studio in the typed extension envelope for publishing/sharing. */
export function studioToManifest(studio: Studio): ExtensionManifest<Studio> {
  return wrapExtension(STUDIO_KIND, studio.id, studio.name, studio.version ?? "1.0.0", studio, {
    description: studio.description,
  });
}

/** Reconstruct a sanitized Studio from a validated manifest, or an error when it's not a studio. Never
 *  trusts the payload shape: requires a non-empty `id` + `name`; a missing/malformed `snapshot` becomes
 *  `{}`. `description`/`version` ride when present. Mirrors blueprintShare's `manifestToBlueprint`. */
export function manifestToStudio(
  m: ExtensionManifest,
): { ok: true; studio: Studio } | { ok: false; error: string } {
  if (m.kind !== STUDIO_KIND) return { ok: false, error: `expected a studio, got '${m.kind}'` };
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const id = str(p.id) || str(m.id);
  const name = str(p.name) || str(m.name);
  if (!id || !name) return { ok: false, error: "studio payload is malformed (need id and name)" };
  const studio: Studio = { id, name, snapshot: coerceSnapshot(p.snapshot) };
  const description = str(p.description) || str(m.description);
  if (description) studio.description = description;
  const version = str(p.version) || str(m.version);
  if (version) studio.version = version;
  return { ok: true, studio };
}

/**
 * Export a studio as a GitHub gist (needs a token with the `gist` scope). `public` makes it a shareable
 * public gist; the default is a secret gist. Returns the gist's web URL + id. Rejects are surfaced as
 * `{ ok: false, error }` so the caller never has to try/catch.
 */
export async function exportStudioToGist(
  studio: Studio,
  token: string,
  opts: { public?: boolean } = {},
): Promise<{ ok: true; url: string; id: string } | { ok: false; error: string }> {
  try {
    const res = await publishGist(token, studioToManifest(studio), { public: opts.public });
    return { ok: true, url: res.htmlUrl, id: res.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Import a studio from a gist URL/id (public/secret gists need no auth; `token` raises the rate limit /
 * reads a private gist). `installFromGist` fetches AND validates the envelope (it returns a
 * `ValidateResult`); a valid envelope is then coerced into the studio payload.
 */
export async function importStudioFromGist(
  urlOrCode: string,
  token = "",
): Promise<{ ok: true; studio: Studio } | { ok: false; error: string }> {
  const res = await installFromGist(urlOrCode, token);
  return res.ok ? manifestToStudio(res.manifest) : res;
}
