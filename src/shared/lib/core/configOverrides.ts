// #2047 — frontend runtime config loading (parity of the backend's P2). The app's config surfaces
// (blueprints / roles / skills / stage defs / taxonomies) are Vite-embedded via `import.meta.glob` +
// direct `@data/*` imports as the DEFAULT; this module overlays the runtime config dir
// (~/.base-studio-code/config/) over those defaults, primed at boot BEFORE the config modules build
// their consts — so editing a `@data` file under the config dir takes effect on next launch, no rebuild.
//
// Fail-safe by design: `overrides` stays empty in browser-dev (no Tauri) or if the fetch fails, so
// every overlay falls back to the embedded default and behavior is unchanged without a backend.

/** The primed config-dir files (`rel-path → contents`). Empty until `primeConfigOverrides` resolves. */
let overrides: Record<string, string> = {};
let primed = false;

/** Fetch the config-dir files once, before App (and the config modules) are imported. Must be awaited
 *  in the entry (`main.tsx`) ahead of the dynamic `App` import. No-ops safely on any failure. */
export async function primeConfigOverrides(): Promise<void> {
  if (primed) return;
  primed = true;
  try {
    // Dynamic import so the pure `overlay*` consumers (deployEnv/sessionRoles/…) don't statically
    // pull in the Tauri API — only this boot-time primer touches it.
    const { invoke } = await import("@tauri-apps/api/core");
    const files = await invoke<Record<string, string>>("get_config_files");
    if (files && typeof files === "object") overrides = files;
  } catch {
    // No Tauri backend (browser dev) or a read failure — the embedded defaults stand.
  }
}

/** Overlay the config-dir copies over an eager `import.meta.glob` surface, matched by filename stem.
 *  Returns `[stem, parsedValue][]` (embedded order, overrides replacing in place; new files appended) —
 *  the caller shapes it into a Record or a values list. `dir` is the config-dir subdir (e.g. "stages"). */
export function overlayGlob<T>(dir: string, embedded: Record<string, { default: T }>): [string, T][] {
  const out = new Map<string, T>(); // stem → value
  for (const [path, mod] of Object.entries(embedded)) out.set(stem(path), mod.default);
  for (const [rel, content] of Object.entries(overrides)) {
    if (dirOf(rel) !== dir) continue;
    const parsed = tryParse<T>(content);
    if (parsed !== undefined) out.set(stem(rel), parsed);
  }
  return [...out.entries()];
}

/** Overlay a single direct-import `@data` file: the config-dir copy parsed, else the embedded default.
 *  `rel` is the config-dir-relative path (e.g. "planner/blueprint-meta.json"). */
export function overlayFile<T>(rel: string, embedded: T): T {
  const content = overrides[rel];
  if (content === undefined) return embedded;
  return tryParse<T>(content) ?? embedded;
}

/** Overlay a single RAW (non-JSON) `@data` file — e.g. a markdown prompt/protocol imported with
 *  `?raw`: the config-dir copy's text verbatim if present, else the embedded default. The raw analogue
 *  of {@link overlayFile} (no parse), giving markdown surfaces the same edit-without-rebuild parity the
 *  Rust `load_str` gives them backend-side. */
export function overlayRaw(rel: string, embedded: string): string {
  const content = overrides[rel];
  return content === undefined ? embedded : content;
}

/** Test-only: reset the primed state so a spec can re-prime with a fresh mock. */
export function resetConfigOverridesForTest(): void {
  overrides = {};
  primed = false;
}

function basename(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }
function stem(p: string): string { const b = basename(p); return b.endsWith(".json") ? b.slice(0, -5) : b; }
function dirOf(rel: string): string { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); }
function tryParse<T>(s: string): T | undefined { try { return JSON.parse(s) as T; } catch { return undefined; } }
