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
  description?: string | null;
  updated_at?: string;
  owner?: { login?: string } | null;
  files?: Record<string, { content?: string; raw_url?: string; filename?: string }>;
  history?: GistHistoryItem[];
}

/** One blueprint gist from a source user's gists (#923). */
export interface BlueprintGistItem {
  id: string;
  /** Blueprint name, parsed from the gist description (`blueprint: <name>`, set by publishGist). */
  name: string;
  description: string;
  owner: string;
  htmlUrl: string;
  updatedAt: string;
}

/** List a GitHub user's BLUEPRINT gists (#923). A gist is a blueprint when its description carries
 *  the `blueprint:` prefix publishGist writes (`${kind}: ${name}`) — the list endpoint omits file
 *  content, so the description is the reliable signal. No auth needed for public gists; `token`
 *  raises the rate limit + surfaces the user's secret gists. Empty on error. */
export async function listBlueprintGists(user: string, token = ""): Promise<BlueprintGistItem[]> {
  if (!user.trim()) return [];
  let gists: GistApiResponse[];
  try {
    gists = (await invoke("github_request", { token, path: `users/${user}/gists?per_page=100`, maxAgeSecs: 60, force: false })) as GistApiResponse[];
  } catch {
    return [];
  }
  if (!Array.isArray(gists)) return [];
  return gists
    .filter((g) => !!g.id && (g.description ?? "").trim().toLowerCase().startsWith("blueprint:"))
    .map((g) => {
      const description = (g.description ?? "").trim();
      return {
        id: g.id!,
        name: description.replace(/^blueprint:\s*/i, "").trim() || "(untitled blueprint)",
        description,
        owner: g.owner?.login ?? user,
        htmlUrl: g.html_url ?? "",
        updatedAt: g.updated_at ?? "",
      };
    });
}

interface GistHistoryItem {
  version?: string;
  committed_at?: string;
  change_status?: { total?: number; additions?: number; deletions?: number };
  user?: { login?: string } | null;
}

/** One published revision of a gist (newest first). */
export interface GistRevision {
  /** Full commit sha of this revision (use with installFromGistRevision). */
  version: string;
  committedAt: string;
  additions: number;
  deletions: number;
  login: string;
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

/** Map a gist's API `history` into our GistRevision list (newest first). Pure. */
export function toRevisions(history: GistHistoryItem[] | undefined): GistRevision[] {
  return (history ?? [])
    .filter((h): h is GistHistoryItem & { version: string } => typeof h.version === "string")
    .map((h) => ({
      version: h.version,
      committedAt: h.committed_at ?? "",
      additions: h.change_status?.additions ?? 0,
      deletions: h.change_status?.deletions ?? 0,
      login: h.user?.login ?? "unknown",
    }));
}

/** Fetch a gist's revision history (newest first). Empty on error. */
export async function gistRevisions(id: string, token = ""): Promise<GistRevision[]> {
  try {
    const gist = (await invoke("github_request", { token, path: `gists/${id}`, maxAgeSecs: 0, force: true })) as GistApiResponse;
    return toRevisions(gist.history);
  } catch {
    return [];
  }
}

/** Install the manifest as it existed at a specific gist revision (sha). */
export async function installFromGistRevision(id: string, sha: string, token = ""): Promise<ValidateResult> {
  let gist: GistApiResponse;
  try {
    gist = (await invoke("github_request", { token, path: `gists/${id}/${sha}`, maxAgeSecs: 0, force: true })) as GistApiResponse;
  } catch (e) {
    return { ok: false, error: `couldn't fetch that revision: ${String(e)}` };
  }
  const content = pickManifestContent(gist.files);
  if (!content) return { ok: false, error: "no extension manifest at that revision" };
  return parseManifest(content);
}
