// Gist transport for extensions (#598 M2). Publish an extension manifest as a gist
// (one shareable URL, free hosting) and install it back by URL. Reading a public/secret
// gist needs no auth; publishing needs a token with the `gist` scope. Pure helpers
// (id parsing, file selection) are split out so they're unit-testable without Tauri.

import { invoke } from "@tauri-apps/api/core";
import { parseManifest, type ExtensionManifest, type ValidateResult } from "./manifest";

/** The file name an extension's manifest is published under inside a gist. */
export const MANIFEST_FILENAME = "extension.json";

/**
 * Extract a gist id from anything the user might paste: a gist web URL
 * (`gist.github.com/<user>/<id>` or `/<id>`), an API URL (`api.github.com/gists/<id>`),
 * or a bare id. Returns null when no plausible id is present.
 */
export function gistIdFromUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // Bare id (hex, ≥ 8 chars) — accept as-is.
  if (/^[0-9a-f]{8,}$/i.test(s)) return s;
  // Last path segment that looks like a gist id.
  const m = s.match(/gist(?:\.github\.com|s)[/:]([^/\s?#]+\/)?([0-9a-f]{8,})/i);
  if (m) return m[2];
  // Fallback: the final path-ish chunk if it's id-shaped.
  const tail = s.split(/[/?#]/).filter(Boolean).pop() ?? "";
  return /^[0-9a-f]{8,}$/i.test(tail) ? tail : null;
}

/** Shape of the relevant bits of the GitHub gist API response. */
interface GistApiResponse {
  id?: string;
  html_url?: string;
  files?: Record<string, { content?: string; raw_url?: string; filename?: string }>;
}

/** Pick the manifest file's content from a gist's files: prefer {@link MANIFEST_FILENAME},
 *  else the first `.json` file. Returns null when none is present. */
export function pickManifestContent(files: GistApiResponse["files"]): string | null {
  if (!files) return null;
  const named = files[MANIFEST_FILENAME];
  if (named?.content) return named.content;
  const firstJson = Object.values(files).find((f) => f.filename?.toLowerCase().endsWith(".json") && f.content);
  return firstJson?.content ?? null;
}

export interface PublishResult { id: string; htmlUrl: string }

/**
 * Publish a manifest as a gist (secret by default). Returns the gist id + web URL to
 * share. Throws on failure (no token / `gist` scope missing / network).
 */
export async function publishGist(
  token: string, manifest: ExtensionManifest, opts: { public?: boolean; description?: string } = {},
): Promise<PublishResult> {
  const files = { [MANIFEST_FILENAME]: JSON.stringify(manifest, null, 2) };
  const description = opts.description ?? `${manifest.kind}: ${manifest.name}`;
  const res = (await invoke("gist_create", { token, files, description, public: opts.public ?? false })) as GistApiResponse;
  if (!res.id || !res.html_url) throw new Error("gist_create returned no id/url");
  return { id: res.id, htmlUrl: res.html_url };
}

/**
 * Install from a gist URL/id: fetch the gist (no auth needed for public/secret), pull
 * its manifest file, and validate it. `token` is optional (used only to raise rate
 * limits / read a private gist).
 */
export async function installFromGist(ref: string, token = ""): Promise<ValidateResult> {
  const id = gistIdFromUrl(ref);
  if (!id) return { ok: false, error: "that doesn't look like a gist URL or id" };
  let gist: GistApiResponse;
  try {
    gist = (await invoke("github_request", { token, path: `gists/${id}`, maxAgeSecs: 0, force: true })) as GistApiResponse;
  } catch (e) {
    return { ok: false, error: `couldn't fetch the gist: ${String(e)}` };
  }
  const content = pickManifestContent(gist.files);
  if (!content) return { ok: false, error: "no extension manifest found in that gist" };
  return parseManifest(content);
}
