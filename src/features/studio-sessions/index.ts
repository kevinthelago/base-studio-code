// Public API of the studio-sessions feature (#3357) — the app-owned designer / librarian / architect
// singleton SESSIONS, hosted on the shared TerminalHost. (Distinct from the neighbouring `studio` feature,
// #2889, which is the shareable snapshot BUNDLE of the app's library state — same word, unrelated
// concern; hence the plural, hyphenated name.) Before #3357 each studio ran its own single-mount xterm
// (`use*Terminal` → `useScreenSession`), which the host could not re-parent, so their Glance nodes could
// only "open the page" instead of morphing into the live terminal. They now launch through the generic
// TerminalView path like every fleet terminal, with a lazy start, survival across navigation, and a
// 30-minute idle reaper.
export { StudioSessionHosts } from "./StudioSessionHosts";
export { StudioSessionMount, seedStudioLaunchState, studioStartPrompt } from "./StudioSessionMount";
export { useStudioViewer, useStudioViewers } from "./useStudioViewer";
export { useStudioPageShowing, studioPageShowing } from "./useStudioPageShowing";
export { useStudioReaper, STUDIO_IDLE_MS, STUDIO_BUSY_RECHECK_MS } from "./useStudioReaper";
export { createStudiosSlice, orderedWantedStudios, type StudiosSlice } from "./store";
export {
  STUDIO_IDS, STUDIO_SESSIONS, STUDIO_INIT_CMD,
  isStudioId, studioForPaneId, studioRoleForPaneId, studioDetached,
  type StudioId, type StudioSessionDef,
} from "./lib/studioSessions";
