import { describe, it, expect } from "vitest";
import { resolveStartupPromptFreshOnly } from "@/app/console/lib/sessionLaunch";
import { STUDIO_SESSION_PANE_IDS } from "@/shared/lib/session/systemSessions";
import { useAppStore } from "@/store";
import type { AppStore } from "@/store/types";

const STUDIO = STUDIO_SESSION_PANE_IDS[0];
const FLEET = "twitter-clone-test:director";
const MANUAL = "man:tab_abc:p2";
const state = (restore: Record<string, boolean> = {}) =>
  ({ restoreRequested: restore } as unknown as AppStore);

// `bsc-agent` takes `--continue`/`-c`, deliberately mirroring claude's, so every rule about RESUMING
// applies to it. This one was gated on `isClaudeProvider`, which made its protection Claude-only: a
// local studio session never suppressed its charter kickoff, so a resumed one was RE-INSTRUCTED on
// every launch. The rule is about resuming, not about which harness resumes.
describe("fresh-only is about resuming, not about the harness", () => {
  it("marks a studio session's kickoff fresh-only for a LOCAL pane, not just a Claude one", () => {
    expect(resolveStartupPromptFreshOnly(state(), STUDIO, false))
      .toBe(resolveStartupPromptFreshOnly(state(), STUDIO, true));
    expect(resolveStartupPromptFreshOnly(state(), STUDIO, false)).toBe(true);
  });

  it("honours an explicit restore request on either harness", () => {
    const s = state({ [FLEET]: true });
    expect(resolveStartupPromptFreshOnly(s, FLEET, false)).toBe(true);
    expect(resolveStartupPromptFreshOnly(s, FLEET, true)).toBe(true);
  });

  it("still exempts a manual console — the user's shell has no charter to re-deliver", () => {
    expect(resolveStartupPromptFreshOnly(state(), MANUAL, false)).toBe(false);
    expect(resolveStartupPromptFreshOnly(state(), MANUAL, true)).toBe(false);
  });

  it("leaves an ordinary fleet pane alone on both harnesses", () => {
    // A director is not a studio session: its kickoff is not fresh-only, and its resume comes from
    // `paneContinue` instead. Pinned so this change cannot be read as making everything fresh-only.
    expect(resolveStartupPromptFreshOnly(state(), FLEET, false)).toBe(false);
    expect(resolveStartupPromptFreshOnly(state(), FLEET, true)).toBe(false);
  });
});

describe("the resume flag survives a restart", () => {
  it("persists paneContinue alongside the other launch facts", () => {
    // THE director's resume path. `fleetStartProject` sets it for every fleet pane; unpersisted, a
    // cold start read false and `resume: continue_session && has_history` was false however much
    // history existed. Measured: `has_history=true · resumed=false` beside a 54 KB conversation.json.
    const persisted = (useAppStore.persist?.getOptions?.().partialize?.(
      useAppStore.getState() as never,
    ) ?? {}) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(persisted, "paneContinue")).toBe(true);
  });
});
