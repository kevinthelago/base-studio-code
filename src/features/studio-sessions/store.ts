// Studios feature store slice (#3357) — the LIFECYCLE of the app-owned designer / librarian / architect
// sessions, now that all three live on the shared TerminalHost instead of a page-owned xterm.
//
// Two transient (NEVER persisted) fields, both keyed by StudioId:
//   • `wantedStudios` — which studios should have a WARM session. A studio enters the list the first time
//     something shows it (its page dock or the Glance morph, via `useStudioViewer`) and leaves it when the
//     idle reaper fires. `StudioSessionHosts` renders one persistent `TerminalSlot` per wanted studio, so
//     "wanted" is exactly "this studio has a terminal on the host". (The backend PTY is killed explicitly
//     by whoever drops the studio — the reaper, or an "End session" from the Glance morph — because
//     `TerminalView`'s unmount deliberately leaves the session alive for reconnect.)
//   • `studioViewers` — a REF COUNT of the surfaces currently SHOWING each studio. Two independent
//     surfaces can show the same session at once (the studio page dock and the Glance node morph), so a
//     boolean would let whichever closed first cancel the other. Counting means the reaper only arms when
//     the LAST viewer goes away.
//
// Nothing here launches or kills a PTY directly — `wantedStudios` is a declaration and the mount/TerminalHost
// pair is what acts on it. That keeps the whole lifecycle unit-testable as plain state transitions.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import { STUDIO_IDS, type StudioId } from "./lib/studioSessions";

export interface StudiosSlice {
  /** Studios whose session should be kept warm on TerminalHost. Transient — nothing launches at boot. */
  wantedStudios: StudioId[];
  /** studio id → number of mounted surfaces currently SHOWING it (page dock + Glance morph). Transient. */
  studioViewers: Record<string, number>;
  /** Mark a studio as wanted — the lazy start. Idempotent, so every viewer can call it on mount. */
  openStudio: (id: StudioId) => void;
  /** Drop a studio from the wanted list → its persistent mount unmounts. Called by the idle reaper and by
   *  an explicit "End session" from the Glance morph, BOTH of which also `pty_kill` the session. */
  closeStudio: (id: StudioId) => void;
  /** A surface began showing this studio (cancels any armed reap). */
  addStudioViewer: (id: StudioId) => void;
  /** A surface stopped showing this studio (arms the reaper when the count reaches 0). */
  removeStudioViewer: (id: StudioId) => void;
}

export const createStudiosSlice: StateCreator<AppStore, [], [], StudiosSlice> = (set) => ({
  wantedStudios: [],
  studioViewers: {},

  openStudio: (id) =>
    set((s) => (s.wantedStudios.includes(id) ? {} : { wantedStudios: [...s.wantedStudios, id] })),

  closeStudio: (id) =>
    set((s) => (s.wantedStudios.includes(id) ? { wantedStudios: s.wantedStudios.filter((w) => w !== id) } : {})),

  addStudioViewer: (id) =>
    set((s) => ({ studioViewers: { ...s.studioViewers, [id]: (s.studioViewers[id] ?? 0) + 1 } })),

  // Clamp at 0: a double-unmount (StrictMode, a racing cleanup) must never drive the count negative —
  // a negative count would read as "still watched" forever and the reaper would never arm.
  removeStudioViewer: (id) =>
    set((s) => ({ studioViewers: { ...s.studioViewers, [id]: Math.max(0, (s.studioViewers[id] ?? 0) - 1) } })),
});

/** The studios currently WANTED, in canonical rail order (so the mounts render in a stable order). */
export function orderedWantedStudios(wanted: readonly StudioId[]): StudioId[] {
  return STUDIO_IDS.filter((id) => wanted.includes(id));
}
