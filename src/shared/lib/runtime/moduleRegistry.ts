// The runtime module registry (#3605, epic #3604) — the bridge that lets graph-loaded code run INSIDE the
// live app instead of in the preview's isolated sandbox.
//
// A component loaded from the components graph is real React source with real imports — `import { useApp
// Store } from "@/store"`, `import { jsx } from "react/jsx-runtime"`. For its hooks to fire and its store
// reads to be LIVE, those imports must resolve to the app's OWN running modules — the SAME React instance
// (a second copy silently breaks hooks: "Invalid hook call") and the SAME Zustand store. This registry is
// how: the shell registers each platform module by its import specifier at boot, and the loader's runtime
// `require` reads them back here. Everything NOT registered is either a graph sibling (loaded from the
// graph) or an honest "unresolved platform module" error — never a stub.
//
// Pure + framework-free (a Map) so it's unit-testable and has no import cycle with the shell.

const registry = new Map<string, unknown>();

/** Register the app's LIVE module for an import specifier (e.g. `"react"`, `"@/store"`). Idempotent —
 *  a re-register replaces (an HMR re-eval must not double up). */
export function registerAppModule(specifier: string, mod: unknown): void {
  registry.set(specifier, mod);
}

/** The registered live module for a specifier, or `undefined` if none — the loader's `require` lookup. */
export function resolveAppModule(specifier: string): unknown | undefined {
  return registry.get(specifier);
}

/** Is this specifier backed by a real app module? Drives the loader's import classification. */
export function isAppModule(specifier: string): boolean {
  return registry.has(specifier);
}

/** Every registered specifier — for diagnostics + a loader error that names what IS available. */
export function registeredSpecifiers(): string[] {
  return [...registry.keys()].sort();
}

/** Clear the registry (tests only — the app registers once at boot and never clears). */
export function __resetRegistry(): void {
  registry.clear();
}
