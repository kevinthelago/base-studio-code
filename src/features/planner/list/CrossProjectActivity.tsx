// Cross-project activity feed — recent GitHub events across all project repos.
// A thin wrapper over the shared <ActivityFeed>; the event parsing lives in
// projectsSummaryDerive.ts (buildActivityFeed).

import { useMemo } from "react";
import { ActivityFeed } from "@/shared/ui/ActivityFeed";
import type { GHEvent } from "@/shared/lib/github/types";
import { buildActivityFeed, EVENT_TONE, type GhProject } from "./projectsSummaryDerive";

export function CrossProjectActivity({ events, projects, loading }: {
  events: GHEvent[];
  projects: GhProject[];
  loading: boolean;
}) {
  const feed = useMemo(() => buildActivityFeed(events, projects), [events, projects]);
  return <ActivityFeed items={feed} hint="across all projects" loading={loading} tone={EVENT_TONE} />;
}
