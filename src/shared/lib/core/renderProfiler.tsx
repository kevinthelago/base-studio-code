// renderProfiler (#3618) — a thresholded React <Profiler> for pinpointing WHICH region is slow.
//
// The frontend perf monitor (perf.ts) counts renders globally but can't say which subtree cost them. Wrap
// a region (a graph, the console, …) in <ProfiledRegion id="…"> and it logs `[render] <id> <phase> Nms`
// to the app log ONLY when a commit of that subtree exceeds `thresholdMs` — so a laggy graph surfaces in
// base-studio-code.log alongside the [perf] lines, tagged, without spamming when it's fast. The <Profiler>
// always wraps (so toggling metrics never remounts the graph + drops its viewport state); the LOG is gated
// on the metrics toggle (perfConfig), read fresh in the callback so ProfiledRegion never re-renders for it.
import { Profiler, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { log } from "./log";

export function ProfiledRegion({
  id,
  thresholdMs = 16,
  children,
}: {
  id: string;
  /** Log only commits at/over this many ms (default one frame). */
  thresholdMs?: number;
  children: ReactNode;
}) {
  return (
    <Profiler
      id={id}
      onRender={(pid, phase, actualDuration) => {
        if (actualDuration < thresholdMs) return;
        const cfg = useAppStore.getState().perfConfig;
        if (!cfg.enabled || !cfg.trackFrontend) return; // honor the metrics toggle
        log.warn(`[render] ${pid} ${phase} ${actualDuration.toFixed(1)}ms`, "perf");
      }}
    >
      {children}
    </Profiler>
  );
}
