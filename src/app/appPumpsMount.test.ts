// THE PUMPS RUN IN ONE WINDOW (`the-agent-view-is-a-window-a-session-navigates-without-moving-yours`).
//
// `App.tsx` used to call every app-level hook before its detached early return, so each ran once per OPEN
// WINDOW: a tear-off ran a second scheduler, a second idle reaper, a second warden, and the agent view
// would have doubled them again. These are ACTIONS — dispatching commands into panes, killing idle
// sessions, quarantining workers, speaking coordination events — so a second copy performs each twice.
//
// The fix is structural (the hooks live in `AppPumps`, mounted once), and this is what keeps it that way:
// a hook re-added to the shell is the exact regression, and it is invisible to every other guard because
// the app still compiles, renders and passes its tests with the pump running twice.
//
// A SOURCE test, deliberately. Rendering the shell to prove a hook did NOT run needs the whole app booted
// per hook; reading the file answers the same question in milliseconds, and the thing being asserted is a
// property of the source rather than of a render.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = readFileSync(join(process.cwd(), "src/app/App.tsx"), "utf8");

/** The loops that own something OUTSIDE the window they run in. Each one moved into `AppPumps`. */
const PUMPS = [
  "useScheduler",
  "useWarden",
  "useIdleReaper",
  "useWorkerAutoEnd",
  "useTunnelSync",
  "useStoreProjector",
  "useTunnelAutomations",
  "useTunnelHookTelemetry",
  "useTunnelCoordControl",
  "useNotificationSounds",
  "useCoordAnnouncer",
  "useCoordSpeaker",
  "useFleetWakeBridge",
  "usePersonaUseBridge",
  "usePersonaWhatamiBridge",
  "useSystemSessionBridge",
  "useFleetDirectorBridge",
  "useFleetStartBridge",
  "useDebugChannel",
  "useDockBack",
  "useSurfaceCatalogPoll",
];

describe("the app-level pumps mount in one window", () => {
  it("reads the shell at all", () => {
    // NON-VACUITY: a failed read or a moved file would make every assertion below pass silently.
    expect(APP).toContain("export default function App()");
    expect(PUMPS.length).toBeGreaterThan(15);
  });

  it("the shell calls no pump directly — they live in AppPumps", () => {
    const called = PUMPS.filter((h) => new RegExp(`^\\s*${h}\\(`, "m").test(APP));
    expect(
      called,
      `${called.length} pump(s) are called in App.tsx again. They own resources the app owns ONCE, so a ` +
        `second window would run them twice; move them into @/app/AppPumps:\n${called.join("\n")}`,
    ).toEqual([]);
  });

  it("mounts AppPumps, and not in the agent view", () => {
    expect(APP).toContain("<AppPumps />");
    // The gate reads what the APP authored into the window's URL — the renderer decides nothing.
    expect(APP).toMatch(/!isAgentViewWindow\(\)\s*&&\s*<AppPumps \/>/);
  });

  it("keeps the navigate bridge in EVERY window — it is how a window is driven at all", () => {
    // The agent view exists to be steered and photographed; a bridge that only ran in the user's window
    // would make it unreachable, and the whole surface pointless.
    expect(APP).toMatch(/^\s*useNavigateBridge\(\);/m);
  });
});
