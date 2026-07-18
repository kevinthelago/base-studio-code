// Sound-kit pins (#3372, epic #3071 phase 4) — the blueprint↔sound-kit-store link, the sounds twin of
// `uiKitPin.ts` (#2465). A blueprint REFERENCES a sound kit as a lockfile entry
// (`Blueprint.soundKit = { id, version, hash, source? }`, exact pins only) against the GLOBAL versioned
// release store (`~/.base-studio-code/sound-kits/<id>/<version>/`, the Rust `bsc sound release` CLI,
// #3371), so one copy serves every blueprint that pins it and the same kit is never downloaded twice.
//
//  · packagedSoundKitPin — the packaged `bsc/signal` kit's pin (id/version/hash read from the generated
//    `@data/sound/signal-kit.meta.json` sidecar). Default-pinned onto every NEW blueprint
//    (`addBlueprint`); it resolves against the store's embedded fallback, so it needs no fetch.
//  · resolveSoundKitPin — the resolve flow on blueprint open/import: local store lookup → fetch the
//    typed gist ONLY when `id@version` is missing → verify sha256 BEFORE the store write (a mismatch is
//    rejected loudly and nothing is stored). Never re-fetches an existing id@version.
//  · importSoundKitByGistUrl — the authoring picker's import path: fetch a `sound-kit` gist, derive its
//    store identity, add it to the store (trust-on-first-import; the returned pin then locks the exact
//    bytes for everyone downstream).
//
// ONE DELIBERATE DIVERGENCE FROM THE UI TWIN — the artifact is UNWRAPPED. The UI store keeps whatever
// bytes it was handed (`resolveUiKitPin` stores the fetched envelope verbatim), because a UI kit's
// artifact is a `{ id, version, kit, components }` wrapper either way. A SOUND kit is SELF-CONTAINED —
// the artifact IS the `{ id, name, primitives, voices, cues }` object — and the Rust store ENFORCES it
// (`validate_artifact` refuses anything without a non-empty top-level `cues`, so an envelope would be
// rejected outright). So the share envelope carries the kit as its `payload`, and what lands in the
// store is that payload alone, re-serialized through {@link canonicalSoundArtifact} — matching the
// Rust `assemble_artifact` byte form, so a `--from-store` release and a gist import of the same kit
// agree. The pin's `hash` is therefore the hash of the ARTIFACT, never of the fetched envelope, and a
// consumer parses a pinned artifact directly as a SoundKit with NO unwrap step.
//
// SCOPE — this is the pin as CONFIG. Making the pin the RESOLUTION target for `@bsc/sounds/<id>`
// imports (today they resolve against the first packaged built-in, `libraryModules.ts`) is the
// explicit follow-up #3412, not an oversight: that resolver is a module-level const over packaged
// seeds while a pin resolves asynchronously through the bridge, and the Rust twin must move with it.
//
// Pure of React; store access goes through the generic `bsc` bridge (#2114), the same surface a live
// session reaches with `bsc sound release …` from its own shell.

import packagedKitMeta from "@data/sound/signal-kit.meta.json";
import { bsc, bscJson } from "@/shared/lib/core/bsc";
import { sha256Hex } from "@/shared/lib/core/sha256";
import { log } from "@/shared/lib/core/log";
import { fetchGistManifestText } from "@/features/planner/lib/gist/gist";
import { parseManifest } from "@/features/planner/lib/gist/manifest";
import type { Blueprint, BlueprintSoundKit } from "../stages/blueprints";

/** A sound-kit-store entry's manifest, as `bsc sound release list|get|add` emit it. */
export interface SoundKitStoreManifest {
  id: string;
  version: string;
  sha256: string;
  kind: "sound-kit";
  /** The typed-gist URL it was fetched from, or `"packaged"` for the embedded default. */
  source?: string;
}

/** The packaged default kit's pin — a FRESH object per call (pins live inside blueprint JSON, so
 *  handing out one shared instance would alias state across blueprints). */
export function packagedSoundKitPin(): BlueprintSoundKit {
  return { id: packagedKitMeta.id, version: packagedKitMeta.version, hash: packagedKitMeta.sha256 };
}

/** `id@version` — the store ref a pin resolves as. */
export function soundKitRef(pin: Pick<BlueprintSoundKit, "id" | "version">): string {
  return `${pin.id}@${pin.version}`;
}

/**
 * The canonical release-artifact bytes for a sound kit — the Rust `assemble_artifact` twin
 * (`crates/bsc-sound/src/release.rs`): pretty JSON, 2-space indent, one trailing newline. The hash a
 * pin records is the hash of THESE bytes, so the artifact's identity depends on the kit's CONTENT
 * rather than on however a publisher happened to format its gist.
 */
export function canonicalSoundArtifact(kit: unknown): string {
  return `${JSON.stringify(kit, null, 2)}\n`;
}

/** Every sound kit in the local release store (incl. the packaged default). Empty when the bridge is
 *  absent. */
export async function listStoreSoundKits(): Promise<SoundKitStoreManifest[]> {
  return bscJson<SoundKitStoreManifest[]>(null, ["sound", "release", "list"], []);
}

/** One store entry's manifest, or null when `id@version` isn't in the store. */
export async function getStoreSoundKit(
  pin: Pick<BlueprintSoundKit, "id" | "version">,
): Promise<SoundKitStoreManifest | null> {
  return bscJson<SoundKitStoreManifest | null>(null, ["sound", "release", "get", soundKitRef(pin)], null);
}

export type SoundKitResolution =
  /** `cached` — the id@version was already in the store (zero downloads). */
  | { ok: true; cached: boolean }
  | { ok: false; error: string };

/**
 * Resolve a blueprint's sound-kit pin against the local store (#3372): store hit ⇒ done (an existing
 * `id@version` is NEVER re-fetched — immutable versions make the local copy valid forever); miss ⇒
 * fetch the typed gist at `pin.source`, unwrap its payload to the canonical artifact, verify that
 * artifact's sha256 against `pin.hash` BEFORE anything is written, and only then add it to the store. A
 * hash mismatch (or a missing source, or a gist that isn't a sound kit) is a loud `{ ok: false }` and
 * the store is untouched. The `--sha256` handed to `bsc sound release add` makes the Rust store
 * re-verify, so the no-write-on-mismatch guarantee holds even if this caller is wrong.
 */
export async function resolveSoundKitPin(pin: BlueprintSoundKit, token = ""): Promise<SoundKitResolution> {
  if (await getStoreSoundKit(pin)) return { ok: true, cached: true };
  if (!pin.source) {
    return {
      ok: false,
      error: `sound kit ${soundKitRef(pin)} is not in the local sound-kit store and the pin has no source to fetch it from`,
    };
  }
  const raw = await fetchGistManifestText(pin.source, token);
  if (!raw.ok) return raw;
  const artifact = artifactFromGistText(raw.text);
  if (!artifact.ok) return artifact;
  const hash = await sha256Hex(artifact.text);
  if (hash !== pin.hash.toLowerCase()) {
    return {
      ok: false,
      error: `sound kit ${soundKitRef(pin)} REJECTED: fetched content hashes to ${hash} but the pin expects ${pin.hash} — refusing to store it`,
    };
  }
  try {
    await bsc(
      null,
      ["sound", "release", "add", pin.id, pin.version, "--kind", "sound-kit", "--sha256", pin.hash, "--source", pin.source],
      artifact.text,
    );
  } catch (e) {
    return { ok: false, error: `sound kit ${soundKitRef(pin)} could not be stored: ${String(e)}` };
  }
  return { ok: true, cached: false };
}

/**
 * Fire-and-forget resolve for a blueprint being OPENED or IMPORTED — the store-slice wire point.
 * No pin ⇒ no-op (blueprints without one are unaffected); a failure is logged loudly (the authoring
 * picker additionally surfaces it inline).
 */
export function resolveBlueprintSoundKit(bp: Pick<Blueprint, "name" | "soundKit"> | undefined, token = ""): void {
  const pin = bp?.soundKit;
  if (!pin) return;
  void resolveSoundKitPin(pin, token).then(
    (res) => {
      if (!res.ok) log.error(`blueprint "${bp?.name ?? "?"}": ${res.error}`);
    },
    // Fire-and-forget: an unexpected throw must land in the log, never as an unhandled rejection (#2515).
    (e) => log.error(`blueprint "${bp?.name ?? "?"}": sound-kit resolve failed: ${String(e)}`),
  );
}

/** The store-identity block a published sound-kit gist carries. Unlike the UI twin's `payload.store`,
 *  this rides the ENVELOPE (`manifest.store`) — the payload IS the artifact, so stamping a foreign
 *  `store` key inside it would corrupt the SoundKit the store validates and a consumer parses. */
export interface SoundKitStoreIdentity {
  id: string;
  version: string;
}

const STORE_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "kit";

/** Derive a fetched sound-kit gist's store identity: the stamped envelope-level `store` when present +
 *  valid, else `<gist-owner>/<kit-id>` slugs with the envelope's own version. Exported for tests. */
export function deriveSoundKitIdentity(
  manifest: { id?: unknown; version?: unknown; store?: unknown; payload?: unknown },
  owner?: string,
): SoundKitStoreIdentity {
  const store = manifest.store as { id?: unknown; version?: unknown } | undefined;
  const stamped = typeof store?.id === "string" ? store.id : "";
  // The kit's OWN id names it best (`signal`); the envelope id is the fallback for a gist that
  // wrapped a kit without one.
  const kitId = (manifest.payload as { id?: unknown } | undefined)?.id;
  const name = typeof kitId === "string" && kitId ? kitId : typeof manifest.id === "string" ? manifest.id : "kit";
  const id = STORE_ID_RE.test(stamped) ? stamped : `${slug(owner ?? "gist")}/${slug(name)}`;
  const version =
    (typeof store?.version === "string" && store.version) ||
    (typeof manifest.version === "string" && manifest.version) ||
    "1.0.0";
  return { id, version };
}

type ArtifactResult = { ok: true; text: string } | { ok: false; error: string };

/** Validate a fetched gist as a `sound-kit` envelope and unwrap its payload into canonical artifact
 *  bytes. The one place the envelope→artifact step lives, so the import and resolve paths can never
 *  disagree about what gets hashed and stored. */
function artifactFromGistText(text: string): ArtifactResult {
  const parsed = parseManifest(text);
  if (!parsed.ok) return parsed;
  if (parsed.manifest.kind !== "sound-kit") {
    return { ok: false, error: `that gist holds a '${parsed.manifest.kind}', not a sound kit` };
  }
  const payload = parsed.manifest.payload as { cues?: unknown } | undefined;
  // Fall loudly rather than storing a hollow kit: the Rust store refuses a cue-less artifact anyway,
  // so catching it here turns an opaque CLI error into an actionable one.
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.cues) || payload.cues.length === 0) {
    return { ok: false, error: "that sound-kit gist carries no cues — a kit with no cues maps to no UI sound" };
  }
  return { ok: true, text: canonicalSoundArtifact(payload) };
}

export type SoundKitImportResult =
  | { ok: true; pin: BlueprintSoundKit }
  | { ok: false; error: string };

/**
 * Import a sound kit by gist URL into the global store, returning the pin to record on the blueprint
 * (#3372, the authoring picker's import path). Fetch → validate it IS a `sound-kit` envelope → unwrap
 * to the canonical artifact → derive the store identity → add to the store (the store enforces
 * id@version immutability — a conflict with different content is surfaced, not overwritten) → pin
 * `{ id, version, hash, source }`.
 */
export async function importSoundKitByGistUrl(url: string, token = ""): Promise<SoundKitImportResult> {
  const raw = await fetchGistManifestText(url, token);
  if (!raw.ok) return raw;
  const artifact = artifactFromGistText(raw.text);
  if (!artifact.ok) return artifact;
  const parsed = parseManifest(raw.text);
  if (!parsed.ok) return parsed;
  const { id, version } = deriveSoundKitIdentity(parsed.manifest, raw.owner);
  const hash = await sha256Hex(artifact.text);
  try {
    await bsc(null, ["sound", "release", "add", id, version, "--kind", "sound-kit", "--source", url], artifact.text);
  } catch (e) {
    return { ok: false, error: `could not add ${id}@${version} to the sound-kit store: ${String(e)}` };
  }
  return { ok: true, pin: { id, version, hash, source: url } };
}
