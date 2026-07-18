import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { orderedWantedStudios } from "./store";

/** #3357 — the studio-session lifecycle state: which studios are WANTED (⇒ a warm PTY on TerminalHost)
 *  and how many surfaces are currently showing each (the ref count the idle reaper keys off). */

beforeEach(() => {
  useAppStore.setState({ wantedStudios: [], studioViewers: {} });
});

describe("studios slice (#3357)", () => {
  it("starts empty — NOTHING launches at app boot", () => {
    expect(useAppStore.getState().wantedStudios).toEqual([]);
    expect(useAppStore.getState().studioViewers).toEqual({});
  });

  it("openStudio marks a studio wanted and is idempotent (every viewer may call it)", () => {
    const { openStudio } = useAppStore.getState();
    openStudio("designer");
    openStudio("designer");
    expect(useAppStore.getState().wantedStudios).toEqual(["designer"]);
  });

  it("closeStudio drops exactly that studio — its mount unmounts and the PTY is torn down", () => {
    const st = useAppStore.getState();
    st.openStudio("designer");
    st.openStudio("librarian");
    st.closeStudio("designer");
    expect(useAppStore.getState().wantedStudios).toEqual(["librarian"]);
    // Closing something not wanted is a no-op (the reaper may race an explicit End session).
    useAppStore.getState().closeStudio("designer");
    expect(useAppStore.getState().wantedStudios).toEqual(["librarian"]);
  });

  it("ref-counts viewers so two surfaces showing one studio don't cancel each other", () => {
    const st = useAppStore.getState();
    // The page dock and the Glance morph can both show the SAME session at once.
    st.addStudioViewer("designer");
    st.addStudioViewer("designer");
    expect(useAppStore.getState().studioViewers.designer).toBe(2);
    st.removeStudioViewer("designer");
    expect(useAppStore.getState().studioViewers.designer).toBe(1); // still watched — reaper stays disarmed
    st.removeStudioViewer("designer");
    expect(useAppStore.getState().studioViewers.designer).toBe(0);
  });

  it("clamps the viewer count at zero — a double-unmount must never make it 'permanently watched'", () => {
    const st = useAppStore.getState();
    st.removeStudioViewer("architect");
    st.removeStudioViewer("architect");
    expect(useAppStore.getState().studioViewers.architect).toBe(0);
  });

  it("orderedWantedStudios renders the wanted mounts in stable rail order", () => {
    expect(orderedWantedStudios(["architect", "designer"])).toEqual(["designer", "architect"]);
    expect(orderedWantedStudios([])).toEqual([]);
  });
});
