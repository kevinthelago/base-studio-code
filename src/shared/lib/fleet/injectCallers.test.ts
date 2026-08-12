// The "only the user resumes a session" invariant, made ENFORCEABLE (#only-the-user-resumes-a-session).
//
// Four separate mechanisms were launching or re-prompting sessions on their own, and each was found by
// evidence rather than by reading the code: the `bsc-defer` Stop hook, `autoResumeClaude` defaulting
// true, `useFleetGate`'s launch pump, and the idle reminder. They were found one at a time, over four
// rounds, because nothing in the repo stated the rule — so a sweep could inventory the INJECTION sites
// and still miss a LAUNCH pump, which is exactly what happened.
//
// This test states it. It is a RATCHET, not a clean-room assertion: the modules that still inject are
// listed below with what each is for, so
//
//   • a NEW module that injects fails immediately — it has to justify itself by being added here, and
//     the reviewer gets to ask "why is this not the Coordination inbox?";
//   • converting one to surface-instead-of-inject is a DELETION from this list, so the remaining
//     surface shrinks visibly instead of being re-counted by hand each time.
//
// The list is the honest state of the item, not a claim that the work is done: the launch half is
// fixed and confirmed, the injection half is still being converted pump by pump.
import { describe, it, expect } from "vitest";

/** Every first-party source file, raw. `query: "?raw"` keeps these as TEXT rather than making a module
 *  out of the whole app — the same reason `shadowPages.ts` enumerates its raw globs. */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** The import specifier every caller reaches for. Matching the IMPORT (not a bare `injectPrompt(`)
 *  avoids counting the definition, the doc comments that name it in prose, and this test. */
const IMPORT_RE = /import\s*\{[^}]*\binjectPrompt\b[^}]*\}\s*from\s*["'][^"']*paneInject["']/;

/**
 * The modules that still write to a session's stdin on their own, and why each is still here.
 *
 * Every one of these is a PUMP: it reacts to app state (a coord event, a fault, a completed kit) and
 * pushes a prompt into a running pane. The item's target state is that each surfaces in the
 * Coordination inbox instead, so the user chooses what to resume — nothing is lost, but nothing moves
 * without a click either.
 *
 * NOTE what is NOT here: nothing LAUNCHES a session any more. That half is done and was confirmed
 * against a real app start. These write to panes that are already running.
 */
const KNOWN_INJECTORS: readonly string[] = [
  // SHRINKING under #app-stops-pushing-prompts. Three inject-only pumps are now inert exports.
  "/src/app/console/useDirectorPump.ts",
  "/src/features/designs/useDesignerLoopPump.ts",
  "/src/features/glance/usePreviewReview.ts",
  "/src/shared/lib/github/useCiWatcher.ts",
];

/** Files that import `injectPrompt`, as repo-relative paths, sorted. */
function callers(): string[] {
  return Object.entries(SOURCES)
    .filter(([path, src]) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx") && IMPORT_RE.test(src))
    .map(([path]) => path)
    .sort();
}

describe("who may write to a session's stdin (#only-the-user-resumes-a-session)", () => {
  it("is EXACTLY the known set — a new injector must justify itself here first", () => {
    // The failure message is the point: whoever adds an injector reads the reason this list exists
    // before deciding their module belongs on it.
    expect(callers()).toEqual([...KNOWN_INJECTORS].sort());
  });

  it("names only modules that still EXIST — a stale entry would hide a real regression", () => {
    // An allow-list that outlives its file silently grants room for one more injector: the count still
    // matches while a different module took the dead one's place.
    const present = new Set(Object.keys(SOURCES));
    for (const f of KNOWN_INJECTORS) {
      expect(present.has(f), `${f} is listed as a known injector but no longer exists`).toBe(true);
    }
  });

  it("contains NO session-LAUNCH pump — that half is fixed, and must stay fixed", () => {
    // useFleetGate is the one that survived two previous attempts, because it launches rather than
    // injects and a sweep of injection sites could not see it. It must never reappear as a caller.
    expect(callers()).not.toContain("/src/shared/lib/fleet/useFleetGate.ts");
  });

  it("keeps useFleetGate inert — its body evaluates nothing and launches nothing", () => {
    const src = SOURCES["/src/shared/lib/fleet/useFleetGate.ts"];
    expect(src, "useFleetGate.ts is still the file the gate lives in").toBeTruthy();
    // Guarded on the BODY, not on the export: the hook is still called by a page record, so deleting
    // it is not the fix — staying empty is. It fired within 2s of every startup for 41 recorded
    // launches, and was invisible to a source grep because its mount point is a RECORD, not a .tsx.
    expect(src).toMatch(/export function useFleetGate\([^)]*\)\s*:\s*void\s*\{\s*(\/\/[^\n]*\n\s*)*\}/);
  });
});
