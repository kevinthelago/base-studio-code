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

/** #architect-asks-a-system-session-for-a-service — the launch directive `bsc session ask` queues when
 *  it starts a session to serve a loop. Take-once semantics are the whole point: a directive that
 *  survived its launch would send a LATER session to watch a loop that was already answered. */
describe("studio pending launch directive", () => {
  beforeEach(() => {
    useAppStore.setState({ studioPendingDirective: {} });
  });

  it("starts empty, so an ordinary launch bakes in nothing", () => {
    expect(useAppStore.getState().studioPendingDirective).toEqual({});
    expect(useAppStore.getState().takeStudioPendingDirective("designerReact")).toBeUndefined();
  });

  it("takes the directive exactly once", () => {
    const st = useAppStore.getState();
    st.setStudioPendingDirective("designerReact", "watch loop 7");
    expect(useAppStore.getState().takeStudioPendingDirective("designerReact")).toBe("watch loop 7");
    // The second take is the relaunch case — a reaper reclaim, or the user re-opening the studio.
    expect(useAppStore.getState().takeStudioPendingDirective("designerReact")).toBeUndefined();
    expect(useAppStore.getState().studioPendingDirective).toEqual({});
  });

  it("keeps each studio's directive separate", () => {
    const st = useAppStore.getState();
    st.setStudioPendingDirective("designerReact", "loop 1");
    st.setStudioPendingDirective("librarianRust", "loop 2");
    expect(useAppStore.getState().takeStudioPendingDirective("designerReact")).toBe("loop 1");
    expect(useAppStore.getState().takeStudioPendingDirective("librarianRust")).toBe("loop 2");
  });

  it("a second ask supersedes an unconsumed first rather than stacking", () => {
    // Two directives in one launch prompt would have the session watching two loops and answering
    // neither — the newer request is the one that is still being waited on.
    const st = useAppStore.getState();
    st.setStudioPendingDirective("designerReact", "loop 1");
    st.setStudioPendingDirective("designerReact", "loop 2");
    expect(useAppStore.getState().takeStudioPendingDirective("designerReact")).toBe("loop 2");
  });
});
