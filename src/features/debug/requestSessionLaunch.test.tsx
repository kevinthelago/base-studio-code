// The HANDOFF: RequestSessionsMount → TerminalHost → TerminalView → pty_create.
//
// `RequestSessionsMount`'s own test asserts the charter lands in `paneStartupPromptText`, and stubs
// `TerminalSlot` out entirely — so nothing had ever checked that the charter reaches the LAUNCH. It
// did not. Every debug session in the running app came up as a bare `claude --model sonnet` (three
// argv entries, read from /proc) and sat at an empty prompt with no work, for as long as the feature
// has existed: no session transcript has ever contained the charter's first line.
//
// That is this repo's recurring shape — a green test covering less than its name implies — so the
// guard has to be the seam itself, not either side of it. This file mocks only what jsdom cannot run
// (xterm) and the two external stores (`bsc`, the Tauri bridge); the mount, the host, the slot and the
// view are all real, and the assertion is on the argument `pty_create` actually received.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { TerminalHost } from "@/app/console/terminal/TerminalHost";
import { RequestSessionsMount } from "@/features/debug/RequestSessionsMount";
import { useAppStore } from "@/store";
import { invoke } from "@tauri-apps/api/core";

const REQUEST = { id: 7, status: "open", claimed_by: null, origin: "design-studio:designer-react", display_title: "ui list needs --kit" };
const { queue } = vi.hoisted(() => ({ queue: { rows: [] as (typeof REQUEST)[] } }));

// The queue, modelling the one contract that matters here: `claim` flips the oldest open row and
// returns it, so the mount has a definite id to bind a session to.
vi.mock("@/shared/lib/core/bsc", () => ({
  bscJson: vi.fn(async (_cwd: unknown, args: string[]) => {
    if (args[1] === "claim") {
      const next = queue.rows.find((r) => r.status === "open");
      if (!next) return null;
      next.status = "claimed";
      return next;
    }
    return queue.rows;
  }),
  bsc: vi.fn(async () => ""),
  bscRun: vi.fn(async () => {}),
  bscWrite: vi.fn(async () => {}),
}));
// Run the poll body once, deterministically, rather than on a 20s timer.
// `usePoll` hands its callback an `isCancelled` probe (the mount checks it before writing state after
// an await). A mock that calls `fn()` bare passes `undefined` for it, so the first `isCancelled()`
// throws — the callback never ran, and the test failed for a reason that had nothing to do with it.
vi.mock("@/shared/hooks/usePoll", () => ({
  usePoll: (fn: (isCancelled: () => boolean) => void | Promise<void>) => { void fn(() => false); },
}));
// xterm cannot initialize in jsdom (`open()` needs real measurements).
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80; rows = 24; options = {}; parser = { registerOscHandler: vi.fn() };
    loadAddon = vi.fn(); open = vi.fn(); write = vi.fn(); scrollToBottom = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() })); focus = vi.fn(); dispose = vi.fn();
    attachCustomKeyEventHandler = vi.fn(); getSelection = vi.fn(() => ""); refresh = vi.fn();
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

beforeEach(() => {
  queue.rows = [{ ...REQUEST }];
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (cmd: string, payload?: unknown) => {
    if (cmd === "debug_repo_root") return "/repo";
    if (cmd === "pty_pane_runtime") {
      const ids = (payload as { paneIds?: string[] } | undefined)?.paneIds ?? [];
      return ids.map((paneId) => ({ paneId, live: false }));
    }
    if (cmd === "pty_create") return true;
    return "";
  });
  useAppStore.setState({ paneStartupPromptText: {}, paneContinue: {} });
});
afterEach(cleanup);

/** The `pty_create` payload, or undefined if the launch never happened. */
const launch = () => {
  const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "pty_create");
  return call?.[1] as { startupPrompt?: string; initCmd?: string; cwd?: string; continueSession?: boolean } | undefined;
};

describe("a spawned debug session launches with its charter", () => {
  it("bakes the charter into pty_create, naming the request it was spawned for", async () => {
    render(<TerminalHost><RequestSessionsMount /></TerminalHost>);
    await waitFor(() => {
      const p = launch();
      expect(p, "pty_create was never called — no session launched at all").toBeTruthy();
      // The whole point: a session that reaches claude with no prompt sits at an empty prompt forever,
      // and looks exactly like one that has finished.
      expect(p!.startupPrompt, "launched with NO charter — the session has nothing to do").toBeTruthy();
      expect(p!.startupPrompt).toContain("YOUR REQUEST IS #7");
      // ...and it is THIS request's charter, not a generic "go find work" (#one-request-one-debug-session).
      expect(p!.startupPrompt).toContain("bsc request get 7");
    });
  });

  /// The bug this file was written for, and the assertion that would have caught it first time.
  ///
  /// The charter was reaching `pty_create` all along — and the BACKEND threw it away.
  /// `resolveStartupPromptFreshOnly` returned true for every `debug-studio:` pane, and `plan_launch`
  /// suppresses the prompt when `fresh_only && has_history`. Every debug session runs in the
  /// base-studio-code repo, where claude has always run before, so `has_history` is permanently true:
  /// the charter was dropped on every launch that has ever happened, and the session came up as a
  /// bare `claude` with nothing to do.
  ///
  /// Asserting the payload — not just the prompt — is what makes this a guard rather than a
  /// coincidence: a prompt that is present in the payload and then discarded downstream looks
  /// identical to a working launch from here.
  ///
  /// The FLAG IS GONE (`the-launch-derives-its-own-fresh-only-instead-of-receiving-it`). The frontend
  /// no longer decides; it sends the two facts and the backend derives the rule from them plus its own
  /// studio registry. So the assertion moves with it: send the facts that make the backend DELIVER,
  /// and let `console::pty::tests::the_launch_derives_fresh_only_from_the_facts_it_is_given` prove the
  /// backend does. Asserting the old key here would have gone vacuous rather than red — `undefined`
  /// is not `false`, but a `?? false` would have swallowed exactly that.
  it("does NOT ask the backend to suppress the charter — the launch is fresh, so there is nothing to re-greet", async () => {
    render(<TerminalHost><RequestSessionsMount /></TerminalHost>);
    await waitFor(() => {
      const p = launch() as
        | ({ startupPromptFreshOnly?: boolean; restoreRequested?: boolean; startupPromptIsErrand?: boolean } & Record<string, unknown>)
        | undefined;
      expect(p, "pty_create was never called").toBeTruthy();
      expect(
        p!.startupPromptFreshOnly,
        "the computed flag must not come back — the backend derives it, and a second opinion on the wire is what this whole inversion removes",
      ).toBeUndefined();
      // A per-request session is not a crash restore, and `debug-studio:req-<id>` is not in the studio
      // registry — so these two facts are what make the backend deliver the charter.
      expect(p!.restoreRequested, "a freshly claimed request is not a crash restore").toBe(false);
      expect(typeof p!.startupPromptIsErrand, "the errand fact must be sent, not omitted").toBe("boolean");
    });
  });

  it("launches fresh in the repo, never resuming another conversation (#3497)", async () => {
    render(<TerminalHost><RequestSessionsMount /></TerminalHost>);
    await waitFor(() => {
      const p = launch();
      expect(p?.cwd).toBe("/repo");
      expect(p?.initCmd).toBe("claude");
      expect(p?.continueSession).toBe(false);
    });
  });

  it("carries the charter even when the STORE never got it — the property the prop buys", async () => {
    // The failure this fixes was invisible from either side: the mount wrote the charter, the view read
    // the store, and in production the write never reached the read. Emptying the store mid-flight is
    // the only way to assert that the launch no longer DEPENDS on that route.
    const original = useAppStore.setState;
    const spy = vi.spyOn(useAppStore, "setState").mockImplementation(((...args: Parameters<typeof original>) => {
      const out = original(...args);
      // Whatever the mount wrote, drop it again before anything can read it.
      original({ paneStartupPromptText: {} } as never);
      return out;
    }) as never);
    try {
      render(<TerminalHost><RequestSessionsMount /></TerminalHost>);
      await waitFor(() => {
        expect(useAppStore.getState().paneStartupPromptText).toEqual({});
        const prompt = launch()?.startupPrompt;
        expect(prompt, "the launch still depends on the store — it went out with no charter").toBeTruthy();
        expect(prompt).toContain("YOUR REQUEST IS #7");
      });
    } finally {
      spy.mockRestore();
    }
  });
});
