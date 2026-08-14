// The DECLARED BOUNDARY, frontend side (#3897; maintainer decision 2026-08-12, see `closure.rs`).
//
// A record's dependency may be a RECORD, or a module the platform registry DECLARES — anything else is
// unresolved. `@data/ui/platform-modules.json` is that registry, generated from the real runtime module
// registry (guarded by `platformModules.gen.test.ts`) and embedded verbatim by the Rust twin.
//
// The two halves are supplied differently on purpose, and each runner supplies them as far as it can:
// the closure runner ALIASES a declared specifier to the app's real file; the browser preview cannot
// (separate realm, and the app ships compiled rather than as source) so it supplies a local STUB — the
// same treatment every non-curated bare specifier already gets (#3696).
//
// This module exists so there is exactly ONE such set on the frontend. It previously lived privately in
// `graphHealth.ts`, which meant the doctor honoured the boundary and the preview did not: doctor called a
// component healthy, the preview refused to build it, and `navigate` acked a mount that never happened.
// That is precisely the asymmetry `isPreviewBuildable`'s own contract forbids — *the doctor must never be
// more permissive than the thing it reports on.* Importing the set from here keeps them in lockstep by
// construction rather than by vigilance.
import platformModules from "@data/ui/platform-modules.json";

/** Every specifier the runtime module registry resolves. Matched LITERALLY, exactly as the loader's
 *  `isAppModule` does — no prefix or directory matching, so an unregistered `@/…` sibling stays an
 *  honest failure. */
export const PLATFORM_MODULES: ReadonlySet<string> = new Set<string>(platformModules as string[]);

/** Is `spec` a registered platform module — the second half of the declared boundary? */
export function isPlatformModule(spec: string): boolean {
  return PLATFORM_MODULES.has(spec);
}
