// The github feature's graph-platform surface (#3650, epic #3604) — the modules a graph-loaded GitHub page
// imports but does NOT redraw: the feature's own summary/pulse logic + hooks, and the cross-feature PLANNER
// board views the GitHub page drills into (ProjectBoard / Roadmap / Issues / Insights / ProjectsSummary).
// The planner coupling already exists in the live index.tsx, so registering the barrel here adds no new
// de-lazy cost. Registered HERE, inside the feature, because the shell must not reach a feature's internals
// (#1545). The github host calls this synchronously before the graph page loads. Mirrors the fleet/
// automations/security graph-platforms.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as Planner from "@/features/planner"; // ProjectsSummary/ProjectBoard/Roadmap/Issues/Insights (board drill-in)
import * as GithubSummary from "./lib/githubSummary";
import * as UseGithubSummary from "./useGithubSummary";
import * as UseRepoPulse from "./lib/useRepoPulse";
import * as HeatFill from "./heatFill";

let done = false;

/** Register the github page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerGithubPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/planner", Planner);
  registerAppModule("@/features/github/lib/githubSummary", GithubSummary);
  registerAppModule("@/features/github/useGithubSummary", UseGithubSummary);
  registerAppModule("@/features/github/lib/useRepoPulse", UseRepoPulse);
  registerAppModule("@/features/github/heatFill", HeatFill);
}
