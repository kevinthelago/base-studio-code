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
    openStudio("designerReact");
    openStudio("designerReact");
    expect(useAppStore.getState().wantedStudios).toEqual(["designerReact"]);
  });

  it("closeStudio drops exactly that studio — its mount unmounts and the PTY is torn down", () => {
    const st = useAppStore.getState();
    st.openStudio("designerReact");
    st.openStudio("librarianRust");
    st.closeStudio("designerReact");
    expect(useAppStore.getState().wantedStudios).toEqual(["librarianRust"]);
    // Closing something not wanted is a no-op (the reaper may race an explicit End session).
    useAppStore.getState().closeStudio("designerReact");
    expect(useAppStore.getState().wantedStudios).toEqual(["librarianRust"]);
  });

  it("ref-counts viewers so two surfaces showing one studio don't cancel each other", () => {
    const st = useAppStore.getState();
    // The page dock and the Glance morph can both show the SAME session at once.
    st.addStudioViewer("designerReact");
    st.addStudioViewer("designerReact");
    expect(useAppStore.getState().studioViewers.designerReact).toBe(2);
    st.removeStudioViewer("designerReact");
    expect(useAppStore.getState().studioViewers.designerReact).toBe(1); // still watched — reaper stays disarmed
    st.removeStudioViewer("designerReact");
    expect(useAppStore.getState().studioViewers.designerReact).toBe(0);
  });

  it("clamps the viewer count at zero — a double-unmount must never make it 'permanently watched'", () => {
    const st = useAppStore.getState();
    st.removeStudioViewer("architect");
    st.removeStudioViewer("architect");
    expect(useAppStore.getState().studioViewers.architect).toBe(0);
  });

  it("orderedWantedStudios renders the wanted mounts in stable rail order", () => {
    expect(orderedWantedStudios(["architect", "designerReact"])).toEqual(["designerReact", "architect"]);
    expect(orderedWantedStudios([])).toEqual([]);
  });
});
