// #3610 / #4086 — the persisted snapshot must NOT carry a `bsc`-owned library.
//
// Zustand `persist` re-`JSON.stringify`s the whole partialized snapshot on EVERY store write. #3610
// found `components` (~592 KB) riding along on every unrelated tick and freezing the app; #4086 found
// the same shape in `blueprints` (395 KB), `skills` (71 KB), `personas` (33 KB) and `teams` (6 KB) —
// together 96% of a 519 KB file. Each is REPLACED from its own SQLite store at boot, so the persisted
// copy was a second source that could only drift.
//
// These guard that they stay out, and that genuine UI/settings state stays in.
import { describe, it, expect } from "vitest";
import { persistedState, migrateAutoResumeOff } from "@/store/persist";
import { useAppStore } from "@/store";

describe("persistedState — the persist allowlist (#3610)", () => {
  it("does NOT persist any bsc-owned library (each re-hydrates from its store at boot)", () => {
    const snap = persistedState(useAppStore.getState());
    // Paired with the hydrate that owns each one — a field may only be dropped BECAUSE something
    // else restores it, so the pairing is the actual invariant.
    for (const [field, owner] of [
      ["components", "hydrateComponents"],
      ["blueprints", "store/index.ts blueprint list --full"],
      ["skills", "hydrateSkills"],
      ["skillGroups", "hydrateSkills"],
      ["personas", "hydratePersonas"],
      ["teams", "hydrateOrgs"],
    ]) {
      expect(field in snap, `${field} must stay out of persist — ${owner} restores it`).toBe(false);
    }
  });

  it("a fat bsc-owned library added to the store does NOT grow the persisted snapshot (#4086)", () => {
    // The generalization of the #3610 proof: the heavy libraries no longer ride along on every write.
    const before = JSON.stringify(persistedState(useAppStore.getState())).length;
    const fat = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, body: "y".repeat(4000) }));
    useAppStore.setState({ blueprints: fat(100) as never, skills: fat(30) as never, personas: fat(20) as never });
    expect(JSON.stringify(persistedState(useAppStore.getState())).length).toBe(before);
  });

  it("a full 600 KB component library added to the store does NOT grow the persisted snapshot", () => {
    // The direct proof of the fix, independent of any seed sizes: inject a fully-hydrated library and
    // show the serialized snapshot is byte-for-byte unchanged — i.e. the heavy blob no longer rides
    // along on every write. Before the fix this delta was ~600 KB per write.
    const before = JSON.stringify(persistedState(useAppStore.getState())).length;
    const fatLibrary = Array.from({ length: 154 }, (_, i) => ({ id: `c${i}`, srcText: "x".repeat(4000) }));
    useAppStore.setState({ components: fatLibrary as never });
    const after = JSON.stringify(persistedState(useAppStore.getState())).length;
    expect(after).toBe(before);
    expect("components" in persistedState(useAppStore.getState())).toBe(false);
  });

  it("still persists genuine UI + settings + library state (not an over-broad deletion)", () => {
    const snap = persistedState(useAppStore.getState());
    // A representative field from every domain that MUST survive a restart.
    for (const key of [
      "activeWorkspace", "tabs", "keybindings",           // shell / console UI
      "githubToken", "githubState",                        // github
      "planFleet", "planStages",                           // planner
      "kits", "kitUsage", "kitDispatches",                 // kit state (kept: small caches + durable queue)
    ]) {
      expect(key in snap).toBe(true);
    }
  });

  it("returns a plain projection, not the whole store (no store methods leak in)", () => {
    const snap = persistedState(useAppStore.getState()) as Record<string, unknown>;
    expect(typeof snap.setWorkspace).toBe("undefined");
    expect(typeof snap.navigate).toBe("undefined");
  });
});

// #restart-does-not-resume-sessions — the v1→v2 flip that actually reaches existing installs.
describe("migrateAutoResumeOff (persist v1 → v2)", () => {
  it("turns a persisted `true` OFF on the upgrade — the case every existing install is in", () => {
    // This is the whole point of the migration. `autoResumeClaude` defaulted TRUE, so the persisted
    // snapshot carries an explicit `true` that is rehydrated OVER the new default — moving the default
    // alone would have left every affected install auto-resuming exactly as before.
    expect(migrateAutoResumeOff({ autoResumeClaude: true }, 1).autoResumeClaude).toBe(false);
  });

  it("leaves an already-off install alone", () => {
    expect(migrateAutoResumeOff({ autoResumeClaude: false }, 1).autoResumeClaude).toBe(false);
  });

  it("does NOT re-flip a deliberate re-enable — it is one-time, keyed on the upgrade", () => {
    // The setting survives so it can be switched back on. If this ran on every load, turning it on in
    // Settings would silently revert at the next restart and read as the toggle being broken.
    expect(migrateAutoResumeOff({ autoResumeClaude: true }, 2).autoResumeClaude).toBe(true);
    expect(migrateAutoResumeOff({ autoResumeClaude: true }, 3).autoResumeClaude).toBe(true);
  });

  it("tolerates a snapshot that never had the field", () => {
    expect(migrateAutoResumeOff({}, 1)).toEqual({});
  });
});

// ── the role must be as durable as everything derived from it ────────────────────────────────────
//
// `a-fleet-pane-comes-back-uncaged-after-an-app-restart`. `paneRoles` and `panePersonas` were the
// only pane-identity fields left OUT of the allowlist, while every value derived from the role —
// the profile, the write globs, the flow, the repo, the stream, the cwd — was persisted beside
// them. After a restart `paneRole()` resolved undefined, `sandboxPlanFor` computed backend "none",
// and a fleet pane relaunched on the host with no cage and no role gate. MEASURED: a director came
// back as `claude --model sonnet` with `/proc/<pid>/ns/mnt` equal to the host's.
//
// A studio pane survived the same restart caged, which is what hid this: `paneRole()` falls back to
// `studioRoleForPaneId`, so a studio role is derivable from the pane id. A fleet role is not.

describe("persistedState — a pane's isolation survives a restart", () => {
  it("persists the ROLE, not only the things derived from it", () => {
    const snap = persistedState(useAppStore.getState());
    // The pairing IS the invariant: each derived field is only meaningful alongside the role that
    // produced it, so persisting one without the other is what made the set incoherent.
    for (const derived of ["paneProfiles", "paneRoleGlobs", "paneFlows", "paneRepos"]) {
      expect(derived in snap, `${derived} is persisted, so the role that produced it must be too`).toBe(true);
    }
    expect("paneRoles" in snap, "the role decides whether the pane gets a cage at all").toBe(true);
    expect("panePersonas" in snap, "a persona may narrow the role's floor; losing it widens the session").toBe(true);
  });

  it("carries a fleet pane's role across a persist round-trip", () => {
    // The end-to-end shape of the failure: assign a director, serialize the way zustand does,
    // and read the role back. Undefined here is exactly what produced an uncaged director.
    useAppStore.setState({
      paneRoles: { "network-monitor:director": "director" },
      panePersonas: { "network-monitor:director": "director" },
    } as never);

    const rehydrated = JSON.parse(JSON.stringify(persistedState(useAppStore.getState())));

    expect(rehydrated.paneRoles?.["network-monitor:director"]).toBe("director");
    expect(rehydrated.panePersonas?.["network-monitor:director"]).toBe("director");
  });
});
