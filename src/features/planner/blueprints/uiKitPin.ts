// UI-kit pins (#2465) — the blueprint↔kit-store link. A blueprint REFERENCES a UI kit as a
// lockfile entry (`Blueprint.uiKit = { id, version, hash, source? }`, exact pins only) against the
// GLOBAL versioned kit store (`~/.base-studio-code/kits/<id>/<version>/`, the Rust `bsc ui release`
// CLI), so one copy serves every blueprint that pins it and the same kit is never downloaded twice.
//
//  · PACKAGED_UI_KIT_PIN — the packaged `bsc/react-ui` kit's pin (id/version/hash read from the
//    generated `@data/ui/react-ui-kit.meta.json` sidecar). Default-pinned onto every NEW blueprint
//    (`addBlueprint`); it resolves against the store's embedded fallback, so it needs no fetch.
//  · resolveUiKitPin — the resolve flow on blueprint open/import: local store lookup → fetch the
//    typed gist ONLY when `id@version` is missing → verify sha256 BEFORE the store write (a
//    mismatch is rejected loudly and nothing is stored). Never re-fetches an existing id@version.
//  · importKitByGistUrl — the authoring picker's import path: fetch a `component-kit` gist, derive
//    its store identity, add it to the store (trust-on-first-import; the returned pin then locks
//    the exact bytes for everyone downstream).
//
// Pure of React; store access goes through the generic `bsc` bridge (#2114), the same surface a
// live session reaches with `bsc ui release …` from its own shell.

import packagedKitMeta from "@data/ui/react-ui-kit.meta.json";
import { bsc, bscJson } from "@/shared/lib/core/bsc";
import { sha256Hex } from "@/shared/lib/core/sha256";
import { log } from "@/shared/lib/core/log";
import { fetchGistManifestText } from "@/features/planner/lib/gist/gist";
import { parseManifest } from "@/features/planner/lib/gist/manifest";
import type { Blueprint, BlueprintUiKit } from "../stages/blueprints";

/** A kit-store entry's manifest, as `bsc ui release list|get|add` emit it. */
export interface KitStoreManifest {
  id: string;
  version: string;
  sha256: string;
  kind: "component-kit" | "design-files";
  /** The typed-gist URL it was fetched from, or `"packaged"` for the embedded default. */
  source?: string;
}

/** The packaged default kit's pin — a FRESH object per call (pins live inside blueprint JSON, so
 *  handing out one shared instance would alias state across blueprints). */
export function packagedUiKitPin(): BlueprintUiKit {
  return { id: packagedKitMeta.id, version: packagedKitMeta.version, hash: packagedKitMeta.sha256 };
}

/** `id@version` — the store ref a pin resolves as. */
export function kitRef(pin: Pick<BlueprintUiKit, "id" | "version">): string {
  return `${pin.id}@${pin.version}`;
}

/** Every kit in the local store (incl. the packaged default). Empty when the bridge is absent. */
export async function listStoreKits(): Promise<KitStoreManifest[]> {
  return bscJson<KitStoreManifest[]>(null, ["ui", "release", "list"], []);
}

/** One store entry's manifest, or null when `id@version` isn't in the store. */
export async function getStoreKit(pin: Pick<BlueprintUiKit, "id" | "version">): Promise<KitStoreManifest | null> {
  return bscJson<KitStoreManifest | null>(null, ["ui", "release", "get", kitRef(pin)], null);
}

export type UiKitResolution =
  /** `cached` — the id@version was already in the store (zero downloads). */
  | { ok: true; cached: boolean }
  | { ok: false; error: string };

/**
 * Resolve a blueprint's UI-kit pin against the local store (#2465): store hit ⇒ done (an existing
 * `id@version` is NEVER re-fetched — immutable versions make the local copy valid forever); miss ⇒
 * fetch the typed gist at `pin.source`, verify its sha256 against `pin.hash` BEFORE anything is
 * written, and only then add it to the store. A hash mismatch (or a missing source) is a loud
 * `{ ok: false }` and the store is untouched. The `--sha256` handed to `bsc ui release add` makes the
 * Rust store re-verify, so the no-write-on-mismatch guarantee holds even if this caller is wrong.
 */
export async function resolveUiKitPin(pin: BlueprintUiKit, token = ""): Promise<UiKitResolution> {
  if (await getStoreKit(pin)) return { ok: true, cached: true };
  if (!pin.source) {
    return { ok: false, error: `UI kit ${kitRef(pin)} is not in the local kit store and the pin has no source to fetch it from` };
  }
  const raw = await fetchGistManifestText(pin.source, token);
  if (!raw.ok) return raw;
  const hash = await sha256Hex(raw.text);
  if (hash !== pin.hash.toLowerCase()) {
    return {
      ok: false,
      error: `UI kit ${kitRef(pin)} REJECTED: fetched content hashes to ${hash} but the pin expects ${pin.hash} — refusing to store it`,
    };
  }
  try {
    await bsc(
      null,
      ["ui", "release", "add", pin.id, pin.version, "--kind", "component-kit", "--sha256", pin.hash, "--source", pin.source],
      raw.text,
    );
  } catch (e) {
    return { ok: false, error: `UI kit ${kitRef(pin)} could not be stored: ${String(e)}` };
  }
  return { ok: true, cached: false };
}

/**
 * Fire-and-forget resolve for a blueprint being OPENED or IMPORTED — the store-slice wire point.
 * No pin ⇒ no-op (blueprints without one are unaffected); a failure is logged loudly (the
 * authoring picker additionally surfaces it inline).
 */
export function resolveBlueprintUiKit(bp: Pick<Blueprint, "name" | "uiKit"> | undefined, token = ""): void {
  const pin = bp?.uiKit;
  if (!pin) return;
  void resolveUiKitPin(pin, token).then(
    (res) => {
      if (!res.ok) log.error(`blueprint "${bp?.name ?? "?"}": ${res.error}`);
    },
    // Fire-and-forget: an unexpected throw must land in the log, never as an unhandled rejection (#2515).
    (e) => log.error(`blueprint "${bp?.name ?? "?"}": UI-kit resolve failed: ${String(e)}`),
  );
}

/** The store-identity block a published kit gist carries in its payload (`payload.store`). */
export interface KitStoreIdentity {
  id: string;
  version: string;
}

const STORE_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "kit";

/** Derive a fetched kit gist's store identity: the stamped `payload.store` when present + valid
 *  (what `publishKitToGist` writes since #2465), else `<gist-owner>/<manifest-id>` slugs with the
 *  envelope's own version — so pre-#2465 kit gists stay importable. Exported for tests. */
export function deriveKitIdentity(
  manifest: { id?: unknown; version?: unknown; payload?: unknown },
  owner?: string,
): KitStoreIdentity {
  const store = (manifest.payload as { store?: { id?: unknown; version?: unknown } } | undefined)?.store;
  const stamped = typeof store?.id === "string" ? store.id : "";
  const id = STORE_ID_RE.test(stamped)
    ? stamped
    : `${slug(owner ?? "gist")}/${slug(typeof manifest.id === "string" ? manifest.id : "kit")}`;
  const version =
    (typeof store?.version === "string" && store.version) ||
    (typeof manifest.version === "string" && manifest.version) ||
    "1.0.0";
  return { id, version };
}

export type KitImportResult =
  | { ok: true; pin: BlueprintUiKit }
  | { ok: false; error: string };

/**
 * Import a kit by gist URL into the global store, returning the pin to record on the blueprint
 * (#2465, the authoring picker's import path). Fetch → validate it IS a `component-kit` manifest →
 * derive the store identity → add to the store (the store enforces id@version immutability — a
 * conflict with different content is surfaced, not overwritten) → pin `{ id, version, hash, source }`.
 */
export async function importKitByGistUrl(url: string, token = ""): Promise<KitImportResult> {
  const raw = await fetchGistManifestText(url, token);
  if (!raw.ok) return raw;
  const parsed = parseManifest(raw.text);
  if (!parsed.ok) return parsed;
  if (parsed.manifest.kind !== "component-kit") {
    return { ok: false, error: `that gist holds a '${parsed.manifest.kind}', not a component kit` };
  }
  const { id, version } = deriveKitIdentity(parsed.manifest, raw.owner);
  const hash = await sha256Hex(raw.text);
  try {
    await bsc(null, ["ui", "release", "add", id, version, "--kind", "component-kit", "--source", url], raw.text);
  } catch (e) {
    return { ok: false, error: `could not add ${id}@${version} to the kit store: ${String(e)}` };
  }
  return { ok: true, pin: { id, version, hash, source: url } };
}
