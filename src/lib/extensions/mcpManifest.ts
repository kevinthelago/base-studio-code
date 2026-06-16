// bsc-extension.json — distributable MCP server / hook install manifest.
//
// Authors publish this file in a GitHub repo (or at any static URL). Users install
// by pasting a GitHub repo slug, a raw URL, or via a bsc://install-extension deep
// link. The app fetches, validates, and presents a consent prompt BEFORE writing
// anything to the store — the caller is responsible for showing the manifest to the
// user and asking for confirmation.
//
// Security rules (non-negotiable):
//   • env values are ALWAYS blank strings — secrets are never stored here
//   • install is disabled-by-default via defFromBscManifest
//   • callers MUST show the manifest and ask for explicit confirmation before install

import type { ExtensionDef } from "../extensions";
import type { CatalogItem } from "../../data/extensions";

export const BSC_EXTENSION_VERSION = 1;

/** Matches ExtensionDef transport choices. */
export type BscTransport = "stdio" | "http";

/**
 * Shape of a `bsc-extension.json` file. Published by extension authors; fetched at
 * install time. The env array carries env var NAMES with empty-string values — secret
 * values must never appear here.
 */
export interface BscExtensionManifest {
  /** Discriminator — always 1 for the current format. */
  bscExtension: number;
  /** "mcp" for an MCP server, "hook" for a lifecycle hook. */
  kind: "mcp" | "hook";
  name: string;
  by?: string;
  /** One- or two-letter icon shown in catalog tile. */
  icon?: string;
  desc?: string;
  // ── MCP server ───────────────────────────────────────
  transport?: BscTransport;
  command?: string;
  args?: string;
  url?: string;
  // ── Hook ─────────────────────────────────────────────
  event?: string;
  matcher?: string;
  hookCommand?: string;
  // ── Shared ───────────────────────────────────────────
  /** Env var keys; values must be empty strings — user fills secrets later. */
  env?: Array<[string, string]>;
}

export type BscManifestResult =
  | { ok: true; manifest: BscExtensionManifest }
  | { ok: false; error: string };

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_KINDS = ["mcp", "hook"] as const;
const VALID_TRANSPORTS = ["stdio", "http"] as const;

/** Validate an unknown value as a BscExtensionManifest. */
export function parseBscExtension(raw: unknown): BscManifestResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "not an object" };
  const o = raw as Record<string, unknown>;

  if (typeof o.bscExtension !== "number") {
    return { ok: false, error: "missing or invalid bscExtension version field" };
  }
  if (o.bscExtension > BSC_EXTENSION_VERSION) {
    return { ok: false, error: `bsc-extension.json v${o.bscExtension} is newer than this app supports — update to install` };
  }
  if (!VALID_KINDS.includes(o.kind as (typeof VALID_KINDS)[number])) {
    return { ok: false, error: `unknown kind '${String(o.kind)}' — expected 'mcp' or 'hook'` };
  }
  if (typeof o.name !== "string" || !o.name.trim()) {
    return { ok: false, error: "name is required" };
  }
  if (o.transport !== undefined && !VALID_TRANSPORTS.includes(o.transport as (typeof VALID_TRANSPORTS)[number])) {
    return { ok: false, error: `unknown transport '${String(o.transport)}'` };
  }
  if (o.env !== undefined) {
    if (!Array.isArray(o.env)) return { ok: false, error: "env must be an array" };
    for (const pair of o.env) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") {
        return { ok: false, error: "each env entry must be [key, value] — env var keys only, values must be empty strings" };
      }
    }
  }

  return { ok: true, manifest: raw as BscExtensionManifest };
}

// ── ExtensionDef factory ──────────────────────────────────────────────────────

/**
 * Build an ExtensionDef from a validated BscExtensionManifest. Always:
 *   - disabled (enabled: false) — user opts in explicitly
 *   - global scope (projects: []) — user narrows if desired
 *   - blank env values — secrets are never carried in the manifest
 */
export function defFromBscManifest(m: BscExtensionManifest): Omit<ExtensionDef, "id"> {
  // Zero out any non-empty env values — secrets must not be pre-filled from a remote source.
  const env = (m.env ?? []).map(([k]) => [k, ""] as [string, string]);

  return {
    kind: m.kind,
    name: m.name,
    enabled: false,
    projects: [],
    transport: m.transport,
    command: m.command,
    args: m.args,
    url: m.url,
    event: m.event,
    matcher: m.matcher,
    hookCommand: m.hookCommand,
    env: env.length ? env : undefined,
  };
}

// ── URL resolution ─────────────────────────────────────────────────────────────

const GH_REPO_RE = /^(?:https?:\/\/)?github\.com\/([^/\s]+\/[^/\s]+?)\/?$/;

/**
 * Given a raw user input — a GitHub repo slug (`owner/repo`), a GitHub URL, or an
 * arbitrary HTTPS URL — return the canonical fetch URL for its bsc-extension.json.
 */
export function resolveBscUrl(input: string): string {
  const trimmed = input.trim();

  // `owner/repo` slug (no protocol, no dots in the expected position)
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://raw.githubusercontent.com/${trimmed}/HEAD/bsc-extension.json`;
  }

  // github.com/owner/repo[/anything] → raw
  const ghMatch = trimmed.match(GH_REPO_RE);
  if (ghMatch) {
    return `https://raw.githubusercontent.com/${ghMatch[1]}/HEAD/bsc-extension.json`;
  }

  // Raw githubusercontent URL — pass through
  if (trimmed.startsWith("https://raw.githubusercontent.com/")) return trimmed;

  // Fall through — caller's direct URL (must be HTTPS)
  return trimmed;
}

/**
 * Fetch and parse a `bsc-extension.json` from a URL, GitHub repo slug, or GitHub URL.
 *
 * IMPORTANT: This function fetches an arbitrary remote URL. The caller MUST present
 * the returned manifest to the user for explicit confirmation before installing.
 */
export async function fetchBscExtension(urlOrRepo: string): Promise<BscManifestResult> {
  const url = resolveBscUrl(urlOrRepo);

  if (!url.startsWith("https://")) {
    return { ok: false, error: "only HTTPS URLs are supported for extension install" };
  }

  let text: string;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      return { ok: false, error: `fetch failed: HTTP ${resp.status} for ${url}` };
    }
    text = await resp.text();
  } catch (e) {
    return { ok: false, error: `network error: ${String(e)}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `invalid JSON at ${url}: ${String(e)}` };
  }

  return parseBscExtension(raw);
}

// ── Deep link ─────────────────────────────────────────────────────────────────

/**
 * Parse a `bsc://install-extension` deep link. Returns the URL to fetch, or null
 * if the href is not a valid install deep link.
 *
 * Supported forms:
 *   bsc://install-extension?url=https%3A%2F%2F...
 *   bsc://install-extension?repo=owner%2Frepo
 */
export function parseInstallDeepLink(href: string): { fetchUrl: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }

  if (parsed.protocol !== "bsc:" || parsed.hostname !== "install-extension") return null;

  const urlParam = parsed.searchParams.get("url");
  if (urlParam) return { fetchUrl: resolveBscUrl(urlParam) };

  const repoParam = parsed.searchParams.get("repo");
  if (repoParam) return { fetchUrl: resolveBscUrl(repoParam) };

  return null;
}

// ── Remote catalog ─────────────────────────────────────────────────────────────

/**
 * Fetch a remote `catalog.json` — a JSON array of CatalogItem — from a URL.
 * Returns the valid items; silently drops malformed entries.
 */
export async function fetchRemoteCatalog(url: string): Promise<CatalogItem[]> {
  if (!url.startsWith("https://")) return [];

  let raw: unknown;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    raw = await resp.json();
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) return [];

  return (raw as unknown[]).filter(
    (item): item is CatalogItem =>
      !!item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).name === "string" &&
      typeof (item as Record<string, unknown>).by === "string" &&
      typeof (item as Record<string, unknown>).icon === "string" &&
      typeof (item as Record<string, unknown>).desc === "string",
  );
}

/**
 * Merge a remote catalog into the local (bundled) catalog. Remote entries whose
 * name already appears in local are silently skipped — the bundled entry wins.
 */
export function mergeRemoteCatalog(remote: CatalogItem[], local: CatalogItem[]): CatalogItem[] {
  const localNames = new Set(local.map((c) => c.name));
  const fresh = remote.filter((c) => !localNames.has(c.name));
  return [...local, ...fresh];
}
