// The glance feature's graph-platform surface (#4185, epic #3604) — the modules a graph-loaded Glance
// imports but does NOT redraw. Registered HERE, inside the feature, because the shell must not reach a
// feature's internals (#1545). The glance host calls this at module load, before the graph page loads.
// Mirrors the fleet/automations/security/github/skills/mcp graph-platforms.
//
// This is the biggest injected surface of any page, and deliberately so: Glance is a COCKPIT. Its 860-line
// workspace is thin over ~17 hooks and pure derivations (the project graph, the fleet roll-up, stream
// progress, fault health, resume), and every one of them reaches the store, the log tail, or a bsc store.
// "Presentation is data, behavior stays code" puts all of it here — what moves to the graph is the layout.
//
// The last three are not glance's own: Glance composes other features' surfaces (the fleet page, teams, the
// studio sessions, the designs library, the debug pane) and reaches two app-owned console internals. Those
// couplings already exist in the live source — this registers what the page ALREADY imports, and adds no
// new dependency.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
// — glance's own domain: the hooks + pure derivations the cockpit is thin over —
import * as AgentStall from "./lib/agentStall";
import * as FleetPlanProgress from "./lib/fleetPlanProgress";
import * as GlanceData from "./lib/glanceData";
import * as GlanceFleet from "./lib/glanceFleet";
import * as GlanceGraph from "./lib/glanceGraph";
import * as GlancePush from "./lib/glancePush";
import * as MorphGrid from "./lib/morphGrid";
import * as ResumeProject from "./lib/resumeProject";
import * as StreamProgress from "./lib/streamProgress";
import * as StudioProject from "./lib/studioProject";
import * as UseFleetHeld from "./lib/useFleetHeld";
import * as UseFleetIssueState from "./lib/useFleetIssueState";
import * as UseGlanceFaults from "./lib/useGlanceFaults";
import * as UseGlanceProjects from "./lib/useGlanceProjects";
import * as UseProjectComplete from "./lib/useProjectComplete";
import * as UseProjectFleet from "./lib/useProjectFleet";
import * as UseStreamProgress from "./lib/useStreamProgress";
import * as UsePreviewReview from "./usePreviewReview";
import * as GlanceNodeMotion from "./glanceNodeMotion";
// — the surfaces Glance COMPOSES from elsewhere —
import * as FleetGraphHost from "@/features/planner/fleet/FleetGraphHost";
import * as TeamFleet from "@/features/planner/fleet/teamFleet";
import * as StudioSessions from "@/features/studio-sessions";
import * as Designs from "@/features/designs";
import * as Debug from "@/features/debug";
import * as Teams from "@/features/teams";
import * as PaneIdentity from "@/app/console/lib/paneIdentity";
import * as TerminalSlot from "@/app/console/terminal/TerminalSlot";

let done = false;

/** Register the Glance page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerGlancePlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/glance/lib/agentStall", AgentStall);
  registerAppModule("@/features/glance/lib/fleetPlanProgress", FleetPlanProgress);
  registerAppModule("@/features/glance/lib/glanceData", GlanceData);
  registerAppModule("@/features/glance/lib/glanceFleet", GlanceFleet);
  registerAppModule("@/features/glance/lib/glanceGraph", GlanceGraph);
  registerAppModule("@/features/glance/lib/glancePush", GlancePush);
  registerAppModule("@/features/glance/lib/morphGrid", MorphGrid);
  registerAppModule("@/features/glance/lib/resumeProject", ResumeProject);
  registerAppModule("@/features/glance/lib/streamProgress", StreamProgress);
  registerAppModule("@/features/glance/lib/studioProject", StudioProject);
  registerAppModule("@/features/glance/lib/useFleetHeld", UseFleetHeld);
  registerAppModule("@/features/glance/lib/useFleetIssueState", UseFleetIssueState);
  registerAppModule("@/features/glance/lib/useGlanceFaults", UseGlanceFaults);
  registerAppModule("@/features/glance/lib/useGlanceProjects", UseGlanceProjects);
  registerAppModule("@/features/glance/lib/useProjectComplete", UseProjectComplete);
  registerAppModule("@/features/glance/lib/useProjectFleet", UseProjectFleet);
  registerAppModule("@/features/glance/lib/useStreamProgress", UseStreamProgress);
  registerAppModule("@/features/glance/usePreviewReview", UsePreviewReview);
  registerAppModule("@/features/glance/glanceNodeMotion", GlanceNodeMotion);
  registerAppModule("@/features/planner/fleet/FleetGraphHost", FleetGraphHost);
  registerAppModule("@/features/planner/fleet/teamFleet", TeamFleet);
  registerAppModule("@/features/studio-sessions", StudioSessions);
  registerAppModule("@/features/designs", Designs);
  registerAppModule("@/features/debug", Debug);
  registerAppModule("@/features/teams", Teams);
  registerAppModule("@/app/console/lib/paneIdentity", PaneIdentity);
  registerAppModule("@/app/console/terminal/TerminalSlot", TerminalSlot);
}
