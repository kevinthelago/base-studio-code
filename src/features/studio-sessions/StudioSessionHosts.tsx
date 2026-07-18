// StudioSessionHosts (#3357) — the app-shell mount point for every WANTED studio session, rendered inside
// <TerminalHost> beside <DebugSessionMount />. One persistent, off-screen `primary` claim per wanted studio
// keeps its PTY warm across navigation; the idle reaper (30 min unwatched) kills the session and drops it
// from the wanted list, which unmounts the claim.
//
// A studio whose page is TORN OFF is skipped here: that window runs its own TerminalHost + hosts, and two
// windows each mounting an xterm onto the same PTY would fight over `pty_resize`. The single-owner handoff
// the pages already had (`KeptMountedPage`'s `gate`) thus survives the migration.
import { useAppStore } from "@/store";
import { StudioSessionMount } from "./StudioSessionMount";
import { useStudioReaper } from "./useStudioReaper";
import { orderedWantedStudios } from "./store";
import { studioDetached } from "./lib/studioSessions";

export function StudioSessionHosts() {
  useStudioReaper();
  const wantedStudios = useAppStore((s) => s.wantedStudios);
  const detachedSections = useAppStore((s) => s.detachedSections);
  const mounted = orderedWantedStudios(wantedStudios).filter((id) => !studioDetached(id, detachedSections));
  return <>{mounted.map((id) => <StudioSessionMount key={id} studio={id} />)}</>;
}
