// App-state gist transport (#2272) — publish/load a "demoable" app-state snapshot as a typed gist,
// reusing the SAME extension-manifest envelope + gist transport blueprints already use. The `kind`
// discriminator (`app-state`) is what lets the app tell an app-state gist from a blueprint gist.
//
// Split into pure envelope helpers (unit-testable) + the Tauri-backed load/save transport.

import {
  wrapExtension, validateManifest, type ExtensionManifest,
} from "@/features/planner/lib/gist/manifest";
import { installFromGist, publishGist } from "@/features/planner/lib/gist/gist";
import { pickDemoable, snapshotAppState, type AppStateSnapshot } from "./appState";
import { useAppStore } from ".";

/** The manifest kind an app-state snapshot ships as (#2272). */
export const APP_STATE_KIND = "app-state" as const;
/** Stable manifest id for an app-state snapshot (there is one logical app-state per gist). */
const APP_STATE_ID = "app-state";

/** Wrap a snapshot in the typed extension envelope for publishing. */
export function appStateToManifest(
  snapshot: AppStateSnapshot, name = "Demo app-state", version = "1.0.0",
): ExtensionManifest<AppStateSnapshot> {
  return wrapExtension(APP_STATE_KIND, APP_STATE_ID, name, version, snapshot);
}

/** Reconstruct a sanitized snapshot from a validated manifest, or an error if it's not an app-state.
 *  The payload is run through {@link pickDemoable} so an untrusted gist can never set a non-demoable
 *  (secret / machine) key. */
export function appStateFromManifest(
  m: ExtensionManifest,
): { ok: true; name: string; snapshot: AppStateSnapshot } | { ok: false; error: string } {
  if (m.kind !== APP_STATE_KIND) return { ok: false, error: `expected an app-state, got '${m.kind}'` };
  return { ok: true, name: m.name, snapshot: pickDemoable(m.payload) };
}

/**
 * Load an app-state gist by URL/id and overlay it as the demo (backing up the current state so it's
 * clearable). Reading a public gist needs no auth; `token` only raises the rate limit / reads a
 * secret gist.
 */
export async function loadDemoFromGist(
  url: string, token = "",
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const res = await installFromGist(url, token);
  if (!res.ok) return res;
  const parsed = appStateFromManifest(res.manifest);
  if (!parsed.ok) return parsed;
  useAppStore.getState().loadDemoState(parsed.snapshot);
  return { ok: true, name: parsed.name };
}

/**
 * Snapshot the CURRENT app-state (allowlist-filtered — never secrets) and publish it as a gist.
 * Needs a token with the `gist` scope. `public` makes it a shareable public gist (the shape a curated
 * demo wants); the default is a secret gist.
 */
export async function saveDemoToGist(
  token: string, name = "Demo app-state", opts: { public?: boolean } = {},
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const snapshot = snapshotAppState(useAppStore.getState());
    const res = await publishGist(token, appStateToManifest(snapshot, name), { public: opts.public });
    return { ok: true, url: res.htmlUrl };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Re-export for tests / callers that want the raw validator on an already-fetched manifest.
export { validateManifest };
