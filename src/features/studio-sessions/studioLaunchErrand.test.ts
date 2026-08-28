// The ASK DIRECTIVE has to reach the session as a MESSAGE, not as context
// (#an-ask-is-delivered-not-left-to-be-found).
//
// THE BUG THIS PINS. `studioContext` used to append the directive to the persona and the scope, and
// that whole string is written into the studio's workspace `CLAUDE.md`. `seedStudioLaunchState` then
// DELETED `paneStartupPromptText[paneId]`, so the session launched on `STUDIO_INIT_CMD`
// (`claude --continue || claude`), resumed its previous conversation, and was never prompted with the
// request. The directive was `take`n on the way past, so it could not be recovered afterwards either.
// Four real asks — loops 7, 8, 9 and 10 to `designerReact` and `librarianTypescript` — reached their
// target's CLAUDE.md and nothing else, and every one of them sat open with zero turns.
//
// Identity is context; an errand is not. The persona and the scope stay in the CLAUDE.md (they
// describe the session for as long as it lives); the errand goes to the startup prompt, which is what
// `plan_launch` bakes as claude's first message.
//
// IT COSTS NO RESUME, and that is pinned on the Rust side rather than assumed here:
// `plan_launch_non_fresh_only_prompt_always_fires` (src-tauri/src/console/pty/launch.rs) asserts
// `plan_launch(Some(prompt), Some(INIT), /*has_history*/ true, /*continue*/ true, false)` is
// `Prompt { resume: true }` — a startup prompt and `--continue` coexist.
//
// SCOPE, stated because the sibling feature was bitten by exactly this: the debug session's own test
// asserted its charter landed in `paneStartupPromptText` while nothing checked the charter reached
// the LAUNCH — and it did not, for as long as that feature existed (see
// `src/features/debug/requestSessionLaunch.test.tsx`, which now guards the seam). This file asserts
// the STORE half. The seam it hands off to is the same one that test already covers, on the same
// `paneStartupPromptText` key, so the handoff is guarded — but if this feature ever grows its own
// launch path, that path needs its own seam test rather than this one.
import { describe, it, expect, beforeEach } from "vitest";
import { studioContext, seedStudioLaunchState } from "@/features/studio-sessions/StudioSessionMount";
import { STUDIO_SESSIONS } from "@/features/studio-sessions/lib/studioSessions";
import { useAppStore } from "@/store";

const DEF = STUDIO_SESSIONS.designerReact;
const ERRAND =
  "You were started to serve a request on loop 42.\nRun `bsc loop watch 42 --as designerReact` to read it.";

describe("a studio woken to serve an ask", () => {
  beforeEach(() => {
    useAppStore.setState({ paneStartupPromptText: {}, studioPendingDirective: {} });
  });

  it("delivers the errand as the startup prompt, not as CLAUDE.md context", () => {
    useAppStore.getState().setStudioPendingDirective(DEF.id, ERRAND);

    // The context is written to the workspace CLAUDE.md. The errand must NOT be in it — that is
    // where it went to die.
    const context = studioContext(DEF);
    expect(context).not.toContain("loop 42");
    expect(context.length).toBeGreaterThan(0); // ...but the persona/scope still are

    seedStudioLaunchState(DEF);
    expect(useAppStore.getState().paneStartupPromptText[DEF.paneId]).toBe(ERRAND);
  });

  it("takes the errand exactly once, so a later relaunch does not re-serve it", () => {
    useAppStore.getState().setStudioPendingDirective(DEF.id, ERRAND);
    seedStudioLaunchState(DEF);
    expect(useAppStore.getState().paneStartupPromptText[DEF.paneId]).toBe(ERRAND);

    // Relaunching the same studio with nothing pending must not resurrect a request already served.
    seedStudioLaunchState(DEF);
    expect(useAppStore.getState().paneStartupPromptText[DEF.paneId]).toBeUndefined();
  });

  it("clears a stale startup prompt when there is no errand", () => {
    // A pane launched by an older build may still carry a persisted persona greeting under this id.
    // Leaving it would re-greet the session on every launch — the behaviour that got startup prompts
    // removed from this channel in the first place.
    useAppStore.setState({ paneStartupPromptText: { [DEF.paneId]: "an old persona greeting" } });
    seedStudioLaunchState(DEF);
    expect(useAppStore.getState().paneStartupPromptText[DEF.paneId]).toBeUndefined();
  });

  it("opts the pane into continuation, so the errand does not cost the conversation", () => {
    // With `paneContinue` set AND a startup prompt present, `plan_launch` yields
    // `Prompt { resume: true }` — the session is handed its request and still continues.
    useAppStore.getState().setStudioPendingDirective(DEF.id, ERRAND);
    seedStudioLaunchState(DEF);
    expect(useAppStore.getState().paneContinue[DEF.paneId]).toBe(true);
  });
});
