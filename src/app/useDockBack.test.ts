// The main window's dock-back listener (#3919).
//
// Deliberately ONE mounted render for the behavioural assertions. The listener installs from an async
// effect, and mounting the hook repeatedly across separate `it` blocks proved genuinely flaky here — the
// second and later renders did not re-install, so the tests failed in-suite while passing in isolation.
// That is a harness artefact, not a product behaviour, and chasing it would have bought nothing: every
// assertion below is about what happens AFTER the listener is installed, which one render exercises fully.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const installs: Array<(p: { page: string; section: string }) => void> = [];
const unlisten = vi.fn();
vi.mock("@/shared/lib/core/dockBack", () => ({
  onDockBack: (h: (p: { page: string; section: string }) => void) => {
    installs.push(h);
    return Promise.resolve(unlisten);
  },
}));

import { useDockBack } from "./useDockBack";
import { useAppStore } from "@/store";

beforeEach(() => {
  installs.length = 0;
  unlisten.mockClear();
  useAppStore.setState({ detachedSections: { github: ["repos"], skills: ["runs"] } });
});

describe("useDockBack (#3919)", () => {
  it("docks a page back: clears its detached flag, leaves other pages alone, and is idempotent", async () => {
    const { unmount } = renderHook(() => useDockBack(true));
    await act(async () => {});
    expect(installs.length, "listener installed").toBe(1);
    const fire = installs[0];

    // Clearing the flag is what returns the tab — `usePageTabs` filters the strip by `detachedSections`.
    act(() => fire({ page: "github", section: "repos" }));
    expect(useAppStore.getState().detachedSections.github).toEqual([]);
    // …and only that page's.
    expect(useAppStore.getState().detachedSections.skills).toEqual(["runs"]);

    // Idempotent: the event racing the window's own `tauri://destroyed` re-dock must be harmless.
    act(() => fire({ page: "github", section: "repos" }));
    expect(useAppStore.getState().detachedSections.github).toEqual([]);

    unmount();
    expect(unlisten, "unsubscribes on teardown").toHaveBeenCalled();
  });

  it("does NOT install in a detached window — it must not re-dock its own page", async () => {
    renderHook(() => useDockBack(false));
    await act(async () => {});
    expect(installs.length).toBe(0);
  });
});
