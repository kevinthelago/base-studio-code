// The idle reaper has to be MOUNTED, and its focus guard has to compare a real pane id
// (#the-idle-reaper-is-built-and-never-mounted-and-its-focus-guard-is-dead).
//
// Both assertions here are SOURCE-LEVEL on purpose, because both failures were invisible to every
// other kind of test:
//
//   * The hook was fully built — pure decision, actuator, store slice, `enabled: true` in the
//     persisted config — and simply never called. `useIdleReaper` appeared exactly twice outside its
//     own definition, both in `console-graph-platform.ts` (an import and a `registerAppModule`). A
//     unit test of the hook passes perfectly while nothing invokes it; only "is it wired into the
//     shell" catches that, and that question lives in the shell's source.
//
//   * The focus guard compared `t${activeTabIdx}p${focusedPaneIdx}` — the RETIRED positional pane id
//     — against identity-keyed panes (`studio-code:director`). It could never match, so `focused` was
//     always false. Rendering the hook would not reveal it either unless the fixture happened to use
//     identity ids, which is exactly the assumption that was wrong.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..");
const appSrc = readFileSync(join(repoRoot, "src", "app", "App.tsx"), "utf8");

/** The reaper's actuator, as the app actually ships it (a record, emitted into `.bsc-records`). */
function reaperSource(): string {
  for (const ext of ["tsx", "ts"]) {
    try {
      return readFileSync(
        join(repoRoot, ".bsc-records", "app", "console", "lib", `useIdleReaper.${ext}`),
        "utf8",
      );
    } catch {
      /* try the other extension */
    }
  }
  throw new Error("useIdleReaper is not emitted — run `npm run emit:records`");
}

/** The app-owned pumps, as the app actually ships them (a record, emitted into `.bsc-records`).
 *
 *  THE REAPER MOVED, AND THE QUESTION DID NOT (`the-agent-view-is-a-window-a-session-navigates-without-moving-yours`).
 *  It used to be called in `App.tsx`; it is now called in `AppPumps`, which the shell mounts in the
 *  window the APP names as the owner — because every open window used to run a second reaper, a second
 *  scheduler and a second warden. So "is it wired into the shell" is still the question; the shell now
 *  answers it in two hops, and both are asserted below. */
function pumpsSource(): string {
  for (const ext of ["tsx", "ts"]) {
    try {
      return readFileSync(join(repoRoot, ".bsc-records", "app", `AppPumps.${ext}`), "utf8");
    } catch {
      /* try the other extension */
    }
  }
  throw new Error("AppPumps is not emitted — run `npm run emit:records`");
}

describe("the idle reaper is actually wired up", () => {
  it("is mounted by the pumps the shell mounts, beside the other always-on hooks", () => {
    // Not by ConsoleWorkspace, which the hook's header claimed for a long time while nothing mounted
    // it at all — and which would be the wrong home regardless, since the Console is opt-in: a reaper
    // that only runs while somebody is looking at the Console is not a reaper.
    const pumps = pumpsSource();
    expect(pumps).toMatch(/^\s*useIdleReaper\(\);/m);
    // ...and imported, or the call above could not resolve.
    expect(pumps).toContain('from "@/app/console/lib/useIdleReaper"');
    // And the shell mounts that component, or the call above runs in nothing.
    expect(appSrc).toContain("<AppPumps />");
    expect(appSrc).toContain('from "@/app/AppPumps"');
  });

  it("is mounted alongside the other always-on hooks, not behind a conditional", () => {
    // A reaper mounted inside a branch is a reaper that does not run, which is the failure this file
    // exists for wearing a different hat. The ONE branch it may sit behind is the window role: the
    // agent view is a second window, and running a second reaper there is the bug, not the feature.
    const pumps = pumpsSource();
    const line = pumps.split("\n").findIndex((l) => /^\s*useIdleReaper\(\);/.test(l));
    expect(line).toBeGreaterThan(-1);
    const neighbours = pumps.split("\n").slice(Math.max(0, line - 6), line + 6).join("\n");
    expect(neighbours).toMatch(/use(Warden|StoreProjector|WorkerAutoEnd|Scheduler)\(/);
    // Inside AppPumps the call is unconditional — no `if`/`&&` guard smuggled around it.
    expect(pumps.split("\n")[line]).toMatch(/^\s*useIdleReaper\(\);\s*$/);
  });

  it("resolves the focused pane to its IDENTITY id, never the retired positional form", () => {
    const src = reaperSource();
    expect(src).toContain("paneIdFor(");
    // THE REGRESSION. `t${...}p${...}` cannot match `studio-code:director`, so the guard was inert —
    // and an inert focus guard on a reaper that IS mounted reaps the pane the user is watching.
    expect(src).not.toMatch(/`t\$\{[^}]*\}p\$\{[^}]*\}`/);
  });
});
