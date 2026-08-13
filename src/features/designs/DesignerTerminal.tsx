// DesignerTerminal (#2471/#2597/#3357) — the Design Studio's bottom panel showing the app-owned designer
// session.
//
// Lifecycle is the studios feature's: showing this page opens the session (`useStudioViewer` → lazy
// start), it stays warm on TerminalHost when the user navigates away, and a 30-minute idle reaper reclaims
// it once neither this dock nor the Glance morph is showing it.
//
// #system-sessions-are-per-technology: there is now one designer PER KIT TECHNOLOGY (react ·
// react-native), and this dock FOLLOWS the workbench's selected kit rather than holding a selection of
// its own — selecting a kit is what pulls up that technology's session. The component store carries
// `tech` on the KIT, one level up from where the algorithms graph carries it, so the caller passes the
// kit's tech rather than a component's.
//
// LAZY, and per-tech lazily: only the ACTIVE session gets a viewer, so switching to a react-native kit
// starts that designer and drops the viewer on the react one (arming its reaper). Nothing pre-starts the
// other technology's session.
import { SessionDock } from "@/shared/ui/layouts/SessionDock";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { STUDIO_SESSIONS, studioForTech, useStudioViewer, useStudioPageShowing } from "@/features/studio-sessions";

export function DesignerTerminal({ height, tech }: { height?: number; tech: string }) {
  // The Designs page is kept MOUNTED but CSS-hidden across page switches, so mounting is not "on screen".
  
  const studio = studioForTech("designer", tech);
  const pageShowing = useStudioPageShowing(studio);
  // A kit whose tech has no designer shows an empty dock rather than defaulting to the react one —
  // see LibrarianTerminal for why a wrong-but-populated dock is worse than an empty one.
  const showing = pageShowing && !!studio;
  useStudioViewer(studio, showing);

  const def = studio ? STUDIO_SESSIONS[studio] : null;
  return (
    <SessionDock
      testid="designer-terminal"
      height={height}
      title={`✦ Designer session · ${tech} · UI kits via bsc ui`}
      subtitle="design-studio · restricted"
    >
      {def ? (
        <TerminalSlot paneId={def.paneId} visible={showing} focused={false} />
      ) : null}
    </SessionDock>
  );
}
