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
// Reads the COMMITTED record store, not the packaged seed — `bsc-emit` materializes `.bsc-records/`
// from `graph/algorithms.json` + `graph/records/*.json` now, so that is the copy this module compiles
// from (`retire-the-packaged-seed-directories`).
import { loadImplementations } from "@scripts/lib/recordStore.mjs";

/** Every first-party source file, raw. `query: "?raw"` keeps these as TEXT rather than making a module
 *  out of the whole app — the same reason `shadowPages.ts` enumerates its raw globs. */
const FILE_SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** Every packaged RECORD's source, keyed by the specifier it provides.
 *
 *  THE GUARD GOES BLIND WITHOUT THIS. It scans `src/`, and the graph migration is steadily moving modules
 *  OUT of `src/` and into records — so a module that writes to a pane keeps doing so while disappearing
 *  from the only place this looked. `useScheduler.ts` is the first to cross that line, and it is a
 *  `pty_write` caller: without the records in scope, retiring it would have quietly removed an entry from
 *  a security allow-list and left the capability in place, unwatched.
 *
 *  A capability boundary has to follow the code, not the directory. */
const RECORD_SOURCES: Record<string, string> = {};
{
  const seeds = import.meta.glob<{ provides?: string; srcText?: string }>("@data/components/app/**/*.json", { eager: true, import: "default" });
  for (const rec of Object.values(seeds)) {
    if (typeof rec?.provides === "string" && typeof rec.srcText === "string") RECORD_SOURCES[rec.provides.trim()] = rec.srcText;
  }
  const algos = (loadImplementations() ?? []) as { provides?: string; code?: string }[];
  for (const im of algos) {
    if (typeof im?.provides === "string" && typeof im.code === "string") RECORD_SOURCES[im.provides.trim()] = im.code;
  }
}

/** Files AND records, in one map. A record is keyed by its `@/…` specifier, a file by its `/src/…` path —
 *  so an allow-list entry names whichever form that module currently takes, and MOVING a module between
 *  the two is a visible edit here rather than a silent removal. */
const SOURCES: Record<string, string> = { ...FILE_SOURCES, ...RECORD_SOURCES };

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
  // EMPTY. Every app-initiated injector is gone (#app-stops-pushing-prompts) and the kit-change
  // Approve button — the last user-click caller — went with them. injectPrompt now has NO callers at
  // all, which is a stronger boundary than a one-entry allow-list: there is nothing to argue onto.
  //
  // injectRedirect SURVIVES and is a different thing: it is the user resume click (coordinatorActuate),
  // a person deciding rather than the app polling.
];

/** Files that import `injectPrompt`, as repo-relative paths, sorted. */
function callers(): string[] {
  return matching(IMPORT_RE);
}

/**
 * The OTHER way to write to a session's stdin, and the one that got past this test.
 *
 * `injectPrompt` is a convenience wrapper; the actual capability is the `pty_write` command, and
 * anything can `invoke` it directly. useWorkerAutoEnd did exactly that — twice, into the DIRECTOR's
 * pane with a trailing CR, which submits the line and opens a Claude turn in a session nobody
 * clicked. It sat there through an inventory that named eight injectors and believed itself complete,
 * because the inventory matched the wrapper rather than the capability.
 *
 * So this ratchet guards the raw command too. The allow-list below is USER-ACTION paths plus the one
 * deliberate exception; a module that is neither has to argue its way on.
 */
const PTY_WRITE_RE = /["']pty_write["']/;

const KNOWN_PTY_WRITERS: readonly string[] = [
  // The terminal itself: keystrokes, paste, and a repaint write. This IS the user typing.
  "/src/app/console/panes/views/TerminalView.tsx",
  // `useHotkeys` left this list with the console grid (`project-fleet-panes-live-only-in-glance`): its
  // clear-input and broadcast writes read the console tabs to find a pane, and are gone.
  "/src/shared/lib/session/terminalClipboard.ts",
  "/src/shared/lib/session/useScreenSession.ts",
  // THE ONE UNATTENDED PATH, and it is deliberate: a cron automation the USER configured. It is the
  // stated exception in #only-the-user-resumes-a-session — the user set it up on purpose, so it is
  // their standing instruction rather than the app deciding. Nothing else may join it on that
  // argument.
  "/src/features/automations/lib/dispatch.ts",
  "/src/features/tunnel/lib/useTunnelAutomations.ts",
  // The phone's keyboard — a person. `usePlanConfirmations` sat beside it (the user pressing
  // confirm/skip on a plan section) and is GONE with the planner screen
  // (`delete-the-planner-ui-keep-the-planner`): removing an injector shrinks this list, which is the
  // ratchet turning the right way.
  // The wrapper's own definition, and the launch/restore handshake.
  "/src/shared/lib/fleet/paneInject.ts",
  "/src/shared/lib/session/ensureClaudeRunning.ts",

  // ── THE SAME MODULES AS RECORDS ──────────────────────────────────────────────────────────────────
  // A migrated module keeps its capability; only its FORM changes. These four are the record copies of
  // entries above and carry the identical argument. They are listed separately rather than folded in
  // because the two copies can DRIFT — a designer edit to a record is not an edit to the file — and a
  // capability list that cannot tell them apart could not show that.
  "@/features/automations/lib/dispatch",
  "@/shared/lib/fleet/paneInject",
  "@/shared/lib/session/ensureClaudeRunning",

  // RECORD-ONLY, and the reason this test now scans records at all. `WorkerDetail`'s file was retired
  // before anyone noticed it holds a `pty_write` — so it left this allow-list silently, taking its
  // capability off the record while keeping it in the app. It writes `text + "\r"`, which SUBMITS the
  // line and opens a turn, and that is precisely the shape the header describes useWorkerAutoEnd getting
  // away with.
  //
  // It is legitimate: `send("steer" | "answer")` is a person typing into the worker-detail modal and
  // pressing send. It belongs here for the same reason the terminal does — a human is the author. What
  // was NOT acceptable is that nothing was watching it.
  "@/features/glance/fleet/WorkerDetail",

  // RETIRED to a record (#seed-the-store-only-records) — same capability, same argument, different form.
  "@/features/automations/useScheduler",
];

function ptyWriters(): string[] {
  return matching(PTY_WRITE_RE);
}

/**
 * One canonical name per MODULE, whichever form it currently takes.
 *
 * `/src/a/b.ts` and the record providing `@/a/b` are the same module wearing different clothes, and the
 * graph migration moves modules between the two continuously. Keying the allow-list on the raw form meant
 * every retirement silently removed an entry and every promotion added a duplicate — the list churned on
 * a change that alters nothing about who may write to a pane.
 *
 * Canonicalising makes the list say what it means: WHICH MODULES hold this capability. A module that
 * exists in both forms collapses to one name, so a file and its record cannot both be argued onto the
 * list as if they were two separate grants.
 */
const canonical = (key: string): string =>
  key.startsWith("@/") ? key : `@/${key.replace(/^\/src\//, "").replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, "")}`;

function matching(re: RegExp): string[] {
  const hits = new Set(
    Object.entries(SOURCES)
      .filter(([path, src]) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx") && re.test(src))
      .map(([path]) => canonical(path)),
  );
  return [...hits].sort();
}

describe("who may write to a session's stdin (#only-the-user-resumes-a-session)", () => {
  it("is EXACTLY the known set — a new injector must justify itself here first", () => {
    // The failure message is the point: whoever adds an injector reads the reason this list exists
    // before deciding their module belongs on it.
    expect(callers()).toEqual([...new Set(KNOWN_INJECTORS.map(canonical))].sort());
  });

  it("names only modules that still EXIST — a stale entry would hide a real regression", () => {
    // An allow-list that outlives its file silently grants room for one more injector: the count still
    // matches while a different module took the dead one's place.
    const present = new Set(Object.keys(SOURCES).map(canonical));
    for (const f of KNOWN_INJECTORS) {
      expect(present.has(canonical(f)), `${f} is listed as a known injector but no longer exists in EITHER form`).toBe(true);
    }
  });

  it("guards the RAW pty_write too — the wrapper is not the capability", () => {
    // The bypass that made this necessary: useWorkerAutoEnd wrote to the director's stdin twice via
    // `invoke("pty_write", …)` while the injectPrompt list above read EMPTY. An allow-list that names
    // one route to a capability certifies nothing about the capability.
    expect(ptyWriters()).toEqual([...new Set(KNOWN_PTY_WRITERS.map(canonical))].sort());
  });

  it("keeps useWorkerAutoEnd off the stdin list — it reaps panes, it does not type at them", () => {
    // Named explicitly because it is the one that got through, and because `pty_kill` (which it does
    // still call, legitimately) reads like `pty_write` at a glance in a diff.
    expect(ptyWriters()).not.toContain(canonical("/src/shared/lib/fleet/useWorkerAutoEnd.ts"));
  });

  it("names only pty_write modules that still EXIST — a stale entry hides a regression", () => {
    const present = new Set(Object.keys(SOURCES).map(canonical));
    for (const f of KNOWN_PTY_WRITERS) {
      expect(present.has(canonical(f)), `${f} is listed as a known pty_write caller but no longer exists in EITHER form`).toBe(true);
    }
  });

  it("contains NO session-LAUNCH pump — that half is fixed, and must stay fixed", () => {
    // useFleetGate is the one that survived two previous attempts, because it launches rather than
    // injects and a sweep of injection sites could not see it. It must never reappear as a caller.
    expect(callers()).not.toContain(canonical("/src/shared/lib/fleet/useFleetGate.ts"));
  });

  it("keeps useFleetGate inert — its body evaluates nothing and launches nothing", () => {
    // Looked up CANONICALLY: the file was retired to a record, and a lookup keyed on the `/src/…` path
    // would simply find nothing — turning the strongest assertion in this file (that the launch pump's
    // BODY is still empty) into an undefined that only the `toBeTruthy` below catches. The gate has to
    // follow the module wherever it lives, which is the same lesson as the allow-lists above.
    const src = SOURCES[canonical("/src/shared/lib/fleet/useFleetGate.ts")] ?? SOURCES["/src/shared/lib/fleet/useFleetGate.ts"];
    expect(src, "useFleetGate still exists, as a file or as a record").toBeTruthy();
    // Guarded on the BODY, not on the export: the hook is still called by a page record, so deleting
    // it is not the fix — staying empty is. It fired within 2s of every startup for 41 recorded
    // launches, and was invisible to a source grep because its mount point is a RECORD, not a .tsx.
    expect(src).toMatch(/export function useFleetGate\([^)]*\)\s*:\s*void\s*\{\s*(\/\/[^\n]*\n\s*)*\}/);
  });
});
