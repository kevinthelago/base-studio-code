// Extension manifest envelope (#598) — the single wrapper every distributable thing
// ships in: blueprints today, MCP / skills / app-state later. One envelope means one
// install / validate / store path regardless of kind. Pure (no React/Tauri) so it's
// shared by the importer, the share-code path, and (later) the gist layer.

/** Bump only on a breaking envelope change; an app refuses a NEWER manifest it can't read. */
export const MANIFEST_VERSION = 1;

/** Distributable kinds. `blueprint` (shared today), `app-state` (#2272 — the app-wide demo/state
 *  snapshot), `component-kit` (#2305) and `studio` (#2891 — the app-library snapshot bundle) are live;
 *  `mcp`/`skill` are reserved. (The legacy code-bearing `pipeline` kind was removed in #2271 — a dead
 *  concept.) NOTE: the type union and the `KINDS` array MUST stay in sync (validateManifest checks
 *  membership against `KINDS`). */
export type ExtensionKind = "blueprint" | "mcp" | "skill" | "app-state" | "component-kit" | "studio";
const KINDS: ExtensionKind[] = ["blueprint", "mcp", "skill", "app-state", "component-kit", "studio"];

/** Capabilities a code-bearing extension may request (declared + user-approved at
 *  install, enforced by the sandbox). Reserved for future code-bearing kinds; the
 *  current data-only kinds (blueprint/mcp/skill) declare none. */
export type Capability = "read-signals" | "write-files" | "render" | "network";

/** The wire/file/share-code envelope. `payload` is the kind-specific object. */
export interface ExtensionManifest<P = unknown> {
  /** Envelope version (see MANIFEST_VERSION). */
  manifest: number;
  kind: ExtensionKind;
  /** Stable extension id (slug). */
  id: string;
  name: string;
  /** Author-set version string (semver-ish); used for update prompts + integrity. */
  version: string;
  author?: string;
  description?: string;
  /** Minimum app version that can run this (string compare is the caller's job). */
  minAppVersion?: string;
  /** Requested capabilities — empty/absent for data-only kinds. */
  capabilities?: Capability[];
  /** Optional content hash (e.g. sha256), recorded at install so silent gist edits can't slip in.
   *  Absent unless the producer sets it. */
  integrity?: string;
  payload: P;
}

export interface WrapMeta {
  author?: string;
  description?: string;
  minAppVersion?: string;
  capabilities?: Capability[];
  integrity?: string;
}

/** Build an envelope around a kind-specific payload. */
export function wrapExtension<P>(
  kind: ExtensionKind, id: string, name: string, version: string, payload: P, meta: WrapMeta = {},
): ExtensionManifest<P> {
  const m: ExtensionManifest<P> = { manifest: MANIFEST_VERSION, kind, id, name, version, payload };
  if (meta.author) m.author = meta.author;
  if (meta.description) m.description = meta.description;
  if (meta.minAppVersion) m.minAppVersion = meta.minAppVersion;
  if (meta.capabilities && meta.capabilities.length) m.capabilities = meta.capabilities;
  if (meta.integrity) m.integrity = meta.integrity;
  return m;
}

export type ValidateResult =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; error: string };

/**
 * Validate an unknown value as an ExtensionManifest. Checks the envelope only (not the
 * kind-specific payload — kind handlers do that). Refuses a manifest version newer than
 * this app understands so a future format can't be half-applied.
 */
export function validateManifest(value: unknown): ValidateResult {
  if (!value || typeof value !== "object") return { ok: false, error: "not an object" };
  const o = value as Record<string, unknown>;
  if (typeof o.manifest !== "number") return { ok: false, error: "missing manifest version" };
  if (o.manifest > MANIFEST_VERSION) {
    return { ok: false, error: `manifest v${o.manifest} is newer than this app supports (v${MANIFEST_VERSION}) — update to install` };
  }
  if (typeof o.kind !== "string" || !KINDS.includes(o.kind as ExtensionKind)) {
    return { ok: false, error: `unknown kind '${String(o.kind)}'` };
  }
  if (typeof o.id !== "string" || !o.id.trim()) return { ok: false, error: "missing id" };
  if (typeof o.name !== "string" || !o.name.trim()) return { ok: false, error: "missing name" };
  if (typeof o.version !== "string" || !o.version.trim()) return { ok: false, error: "missing version" };
  if (!("payload" in o)) return { ok: false, error: "missing payload" };
  return { ok: true, manifest: o as unknown as ExtensionManifest };
}

/** Parse a JSON string into a validated manifest (tolerant of bad JSON). */
export function parseManifest(text: string): ValidateResult {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return { ok: false, error: `invalid JSON: ${String(e)}` }; }
  return validateManifest(v);
}

// ── Share code (copy-paste transport) ─────────────────────────────────────────
// A single opaque string carrying the whole manifest — the no-account, no-network
// path. Unicode-safe base64url of the JSON (no compression; manifests are small).

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Encode a manifest as a shareable code string. */
export function encodeShareCode(m: ExtensionManifest): string {
  return toBase64Url(JSON.stringify(m));
}

/** Decode + validate a share-code string back into a manifest. */
export function decodeShareCode(code: string): ValidateResult {
  let json: string;
  try { json = fromBase64Url(code.trim()); } catch (e) { return { ok: false, error: `bad share code: ${String(e)}` }; }
  return parseManifest(json);
}
