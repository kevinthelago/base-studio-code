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
vi.mock("@/shared/hooks/usePoll", () => ({ usePoll: (fn: () => void | Promise<void>) => { void fn(); } }));
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
