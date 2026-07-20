import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { RequestSessionsMount } from "./RequestSessionsMount";
import { requestPaneId, requestCharter } from "./requestSession";
import { useAppStore } from "@/store";

// `vi.hoisted` because vi.mock is hoisted ABOVE plain consts: referencing a normal `const` from a mock
// factory throws "Cannot access before initialization" the moment anything calls the mock early (the
// store does, at init). The tests still passed green while that rejection fired — exactly the kind of
// green-but-throwing suite worth not shipping.
const { REQUESTS } = vi.hoisted(() => ({
  REQUESTS: [
    { id: 1, surface: "bsc ui", cmd: "bsc ui harvest src/shared/ui", text: "the deny list blocks every path" },
    { id: 2, surface: "bsc ui", cmd: "bsc ui doctor --fix", text: "doctor wants to delete the pages tier" },
  ],
}));

// The queue read, the repo-root probe and the terminal itself are all external systems; stub them so
// the LAUNCH DECISION (what gets seeded, for which pane) is what the test observes.
// Mock EVERY export, not just the one under test: the store also calls into this module, and a partial
// mock leaves the rest `undefined`, which throws asynchronously while the tests still pass green.
vi.mock("@/shared/lib/core/bsc", () => ({
  bscJson: vi.fn(async () => REQUESTS),
  bsc: vi.fn(async () => ""),
  bscRun: vi.fn(async () => {}),
  bscWrite: vi.fn(async () => {}),
}));
vi.mock("@/shared/lib/core/safeInvoke", () => ({ safeInvoke: vi.fn(async () => "C:/repo") }));
vi.mock("@/app/console/terminal/TerminalSlot", () => ({ TerminalSlot: () => null }));
// Run the poll body once, deterministically, instead of on a timer.
vi.mock("@/shared/hooks/usePoll", () => ({
  usePoll: (fn: () => void | Promise<void>) => { void fn(); },
}));

describe("RequestSessionsMount — a debug session per open request (#3498)", () => {
  beforeEach(() =>
    useAppStore.setState({ autoSpawnDebugSessions: false, paneContinue: {}, paneStartupPromptText: {} }));

  it("spawns NOTHING while auto-spawn is off — the default", async () => {
    // The safety assertion. With the toggle off the mount must seed no pane at all, however many
    // requests are open.
    const { container } = render(<RequestSessionsMount />);
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().paneStartupPromptText).toEqual({});
    expect(container).toBeEmptyDOMElement();
  });

  it("spawns a session for each open request once auto-spawn is ON", async () => {
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => {
      const prompts = useAppStore.getState().paneStartupPromptText;
      // CAP is 2, and there are 2 open requests — both get a pane, each its own.
      expect(Object.keys(prompts).sort()).toEqual([requestPaneId(1), requestPaneId(2)].sort());
    });
  });

  it("gives each session its OWN pane and never resumes (#3497)", async () => {
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => {
      const cont = useAppStore.getState().paneContinue;
      expect(cont[requestPaneId(1)]).toBe(false);
      expect(cont[requestPaneId(2)]).toBe(false);
    });
    // Distinct pane ids ⇒ distinct conversation namespaces; two requests can never share a session.
    expect(requestPaneId(1)).not.toBe(requestPaneId(2));
  });

  it("charters each session with ITS request, not the whole queue", async () => {
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => {
      const p = useAppStore.getState().paneStartupPromptText[requestPaneId(1)];
      expect(p).toContain("REQUEST #1");
      expect(p).toContain("the deny list blocks every path");
      expect(p).not.toContain("doctor wants to delete the pages tier");
    });
  });
});

describe("the per-request charter", () => {
  it("names the request, cites the failing command, and demands a resolve", () => {
    const c = requestCharter(REQUESTS[0]);
    expect(c).toContain("REQUEST #1 SPECIFICALLY");
    expect(c).toContain("bsc ui harvest src/shared/ui");
    expect(c).toContain("bsc request resolve 1");
    // A request must never be left open with no explanation — the failure this feature removes.
    expect(c).toMatch(/never be left open/i);
  });

  it("omits the command line when the request cites none", () => {
    const c = requestCharter({ id: 9, surface: "bsc ui", text: "no command", cmd: null });
    expect(c).not.toContain("The exact command that failed");
    expect(c).toContain("bsc request resolve 9");
  });

  it("keys panes per request", () => {
    expect(requestPaneId(7)).toBe("debug-studio:req-7");
  });
});
